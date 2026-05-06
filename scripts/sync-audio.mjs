#!/usr/bin/env node
// ============================================================================
// VocabWorkspace Audio Sync
// ----------------------------------------------------------------------------
// Reads update_data_folder/audio/{WordList,PhraseList}/{en,jp,zh}/####_*.mp3
// and the matching xlsx file. The leading "####" prefix is the 1-indexed data
// row in the spreadsheet, which is how each audio file is matched back to its
// row.
//
// Only compresses audio for rows that are "complete" — every content column
// in the spreadsheet is filled. Output filenames are derived from the row's
// text via `audioKey()` so they line up with runtime lookups in useAudio.js.
//
// Output: public/assets/audio/{en,ja,zh}/<audioKey>.mp3 at 48 kbps mono 22050 Hz.
// ============================================================================

import XLSX from 'xlsx';
import {
  readdirSync, mkdirSync, existsSync, statSync, renameSync,
} from 'node:fs';
import { join, dirname, extname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { audioKey } from '../src/utils/audioKey.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_BASE  = join(ROOT, 'update_data_folder', 'audio');
const OUT_DIR   = join(ROOT, 'public', 'assets', 'audio');
const ARCHIVE   = join(SRC_BASE, '_processed');

// jp folder in source maps to ja/ directory in output (matches useAudio lang code)
const LANG_MAP = { en: 'en', jp: 'ja', zh: 'zh' };

// Encoding target: matches existing public/assets/audio/en/*.mp3
const BITRATE = '48k';
const SAMPLE  = '22050';

// Per-list config: which xlsx to read, sheet name, and required content columns.
// "Required" = every entry in this list must be non-empty for a row to be
// considered complete. Optional columns (e.g. "Image Prompt", "Subcategory")
// are intentionally excluded.
const LISTS = {
  WordList: {
    xlsx: join(ROOT, 'update_data_folder', 'WordList.xlsx'),
    sheet: null, // first sheet
    enCol: 'English',
    zhCol: '单词中文翻译',
    jaCol: '单词日语翻译',
    required: [
      'English', 'Example', 'Category',
      '英语音标', '单词中文翻译', '中文拼音', '例句中文翻译',
      '单词日语翻译', '日语音标', '例句日语翻译',
    ],
  },
  PhraseList: {
    xlsx: join(ROOT, 'update_data_folder', 'PhraseList.xlsx'),
    sheet: '口语',
    enCol: 'English',
    zhCol: '短语中文翻译',
    jaCol: '短语日语翻译',
    // 例句r日语翻译 is a typo carried over from the source sheet header;
    // either spelling counts as the Japanese example sentence column.
    required: [
      'English', 'Example', 'Category', 'Level',
      '英语音标', '短语中文翻译', '中文拼音', '例句中文翻译',
      '短语日语翻译', '日语音标',
    ],
    requireAny: [['例句日语翻译', '例句r日语翻译']],
  },
};

const log = {
  info: (m) => console.log(`\x1b[36m→\x1b[0m ${m}`),
  ok:   (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`),
  warn: (m) => console.log(`\x1b[33m⚠\x1b[0m ${m}`),
  err:  (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`),
  sect: (m) => console.log(`\n\x1b[1m\x1b[34m── ${m} ──\x1b[0m`),
};

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function readRows(cfg) {
  if (!existsSync(cfg.xlsx)) return null;
  const wb = XLSX.readFile(cfg.xlsx);
  const sheetName = cfg.sheet && wb.SheetNames.includes(cfg.sheet)
    ? cfg.sheet
    : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

function isRowComplete(row, cfg) {
  for (const col of cfg.required) {
    if (!String(row[col] || '').trim()) return false;
  }
  for (const group of (cfg.requireAny || [])) {
    if (!group.some(c => String(row[c] || '').trim())) return false;
  }
  return true;
}

function compressOne(src, dst) {
  // -y: overwrite, -ac 1: mono, -ar: sample rate, -b:a: bitrate, -map_metadata -1: strip tags
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', src,
    '-ac', '1',
    '-ar', SAMPLE,
    '-b:a', BITRATE,
    '-map_metadata', '-1',
    dst,
  ], { stdio: 'pipe' });
}

// Build a Set of 1-indexed row numbers that have an audio file present in
// every source language folder for this list. Used to gate compression so
// we only emit a row's audio when it's complete across en/zh/jp.
function rowsWithAllLangAudio(listName) {
  const perLang = {};
  for (const srcLang of Object.keys(LANG_MAP)) {
    const dir = join(SRC_BASE, listName, srcLang);
    perLang[srcLang] = new Set();
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (extname(f).toLowerCase() !== '.mp3' || f.startsWith('.')) continue;
      const m = basename(f, extname(f)).match(/^(\d+)_/);
      if (m) perLang[srcLang].add(parseInt(m[1], 10));
    }
  }
  const langs = Object.keys(perLang);
  if (langs.length === 0) return new Set();
  return new Set(
    [...perLang[langs[0]]].filter(n => langs.every(l => perLang[l].has(n)))
  );
}

// Process one (listName, srcLang) → (outLang) directory.
// `rows` is the parsed xlsx as a flat array; row index 0 = first data row,
// which corresponds to source filename "0001_*.mp3".
function processLang(listName, srcLang, outLang, rows, cfg, fullAudioRows) {
  const srcDir = join(SRC_BASE, listName, srcLang);
  const outDir = join(OUT_DIR, outLang);
  if (!existsSync(srcDir)) {
    return { count: 0, bytesIn: 0, bytesOut: 0, skipped: 0 };
  }
  ensureDir(outDir);

  const files = readdirSync(srcDir).filter(f =>
    !f.startsWith('.') && extname(f).toLowerCase() === '.mp3'
  );

  log.sect(`${listName} ${srcLang}/ → ${outLang}/  (${files.length} files)`);

  const textCol = srcLang === 'en' ? cfg.enCol
                 : srcLang === 'zh' ? cfg.zhCol
                 : cfg.jaCol;

  let count = 0, bytesIn = 0, bytesOut = 0, skipped = 0;
  const seen = new Map();

  for (const f of files) {
    const m = basename(f, extname(f)).match(/^(\d+)_/);
    if (!m) {
      log.warn(`  no row prefix: ${f} — skipping`);
      skipped++;
      continue;
    }
    const rowNum = parseInt(m[1], 10);
    const rowIdx = rowNum - 1;
    const row = rows[rowIdx];
    if (!row) {
      log.warn(`  ${f}: row ${rowIdx + 1} not in xlsx — skipping`);
      skipped++;
      continue;
    }
    if (!isRowComplete(row, cfg)) {
      log.warn(`  ${f}: row ${rowIdx + 1} "${String(row[cfg.enCol] || '').slice(0, 40)}" is incomplete — skipping`);
      skipped++;
      continue;
    }
    if (!fullAudioRows.has(rowNum)) {
      log.warn(`  ${f}: row ${rowNum} "${String(row[cfg.enCol] || '').slice(0, 40)}" is missing audio in another language — skipping`);
      skipped++;
      continue;
    }

    const text = String(row[textCol] || '').trim();
    if (!text) {
      log.warn(`  ${f}: row missing "${textCol}" — skipping`);
      skipped++;
      continue;
    }
    const name = audioKey(text, outLang);
    if (!name) {
      log.warn(`  ${f}: empty key from "${text}" — skipping`);
      skipped++;
      continue;
    }
    if (seen.has(name)) {
      log.warn(`  duplicate target "${name}.mp3" (from ${f}, was from ${seen.get(name)}) — overwriting`);
    }
    seen.set(name, f);

    const src = join(srcDir, f);
    const dst = join(outDir, `${name}.mp3`);
    try {
      const sBefore = statSync(src).size;
      compressOne(src, dst);
      const sAfter = statSync(dst).size;
      bytesIn  += sBefore;
      bytesOut += sAfter;
      count++;
      if (count % 50 === 0) log.info(`  ${count}/${files.length} done…`);
    } catch (e) {
      log.err(`  failed ${f}: ${e.message}`);
    }
  }

  const ratio = bytesIn ? ((1 - bytesOut / bytesIn) * 100).toFixed(1) : 0;
  log.ok(`${listName} ${outLang}/: ${count}/${files.length} encoded, ${skipped} skipped · ${(bytesIn/1024/1024).toFixed(2)} MB → ${(bytesOut/1024/1024).toFixed(2)} MB (-${ratio}%)`);
  return { count, bytesIn, bytesOut, skipped };
}

function archiveSource(listName) {
  const srcDir = join(SRC_BASE, listName);
  if (!existsSync(srcDir)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = join(ARCHIVE, stamp);
  ensureDir(target);
  try {
    renameSync(srcDir, join(target, listName));
    log.ok(`Archived source → update_data_folder/audio/_processed/${stamp}/${listName}`);
  } catch (e) {
    log.warn(`Could not archive ${listName}: ${e.message}`);
  }
}

function main() {
  console.log('\n\x1b[1m🔊 VocabWorkspace Audio Sync\x1b[0m');

  // Sanity: ffmpeg present?
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
  } catch {
    log.err('ffmpeg not found — install with `brew install ffmpeg`');
    process.exit(1);
  }

  let totalIn = 0, totalOut = 0, totalCount = 0, totalSkipped = 0;
  const listsProcessed = [];

  for (const [listName, cfg] of Object.entries(LISTS)) {
    const listDir = join(SRC_BASE, listName);
    if (!existsSync(listDir)) {
      log.info(`No source folder: audio/${listName}/ — skipping`);
      continue;
    }
    const rows = readRows(cfg);
    if (!rows) {
      log.warn(`Missing xlsx for ${listName}: ${cfg.xlsx}`);
      continue;
    }
    const completeCount = rows.filter(r => isRowComplete(r, cfg)).length;
    const fullAudioRows = rowsWithAllLangAudio(listName);
    log.info(`${listName}: ${completeCount} of ${rows.length} rows pass completeness check; ${fullAudioRows.size} rows have audio in all source languages`);

    for (const [src, out] of Object.entries(LANG_MAP)) {
      const r = processLang(listName, src, out, rows, cfg, fullAudioRows);
      totalIn += r.bytesIn; totalOut += r.bytesOut;
      totalCount += r.count; totalSkipped += r.skipped;
    }
    listsProcessed.push(listName);
  }

  log.sect('Summary');
  const ratio = totalIn ? ((1 - totalOut / totalIn) * 100).toFixed(1) : 0;
  log.ok(`Encoded ${totalCount} files (${totalSkipped} skipped) · ${(totalIn/1024/1024).toFixed(2)} MB → ${(totalOut/1024/1024).toFixed(2)} MB (-${ratio}%)`);

  if (process.argv.includes('--archive')) {
    for (const listName of listsProcessed) archiveSource(listName);
  } else {
    log.info('(source kept in update_data_folder/audio/. Pass --archive to move it.)');
  }

  console.log('\n\x1b[32m✓ Done!\x1b[0m\n');
}

main();
