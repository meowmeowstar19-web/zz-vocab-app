#!/usr/bin/env node
// ============================================================================
// ⚠️ RETIRED — 内容工厂 Phase 3 (2026-06-04)
// ----------------------------------------------------------------------------
// 不再被 publish-all 调用。Phase 3 起没有「投放中转站」update_data_folder/updated_audio,
// 音频统一由工厂生成器 4.语音生成.py 产出 audio/{word,phrase}/{lang}/<audioKey>.mp3,
// 再由 sync-audio.mjs(读工厂、按 audioKey 压缩进 public)处理。
// 本文件保留仅作历史参考,可手动运行处理遗留 drop,但日常发布流程已不用它。
// ----------------------------------------------------------------------------
// Sync updated audio drops (legacy)
// ----------------------------------------------------------------------------
// Reads update_data_folder/updated_audio/{WordList,PhraseList}/{jp,zh,en}/*.mp3
// and matches each file to its xlsx row by FILENAME TEXT (not the numeric
// prefix — row prefixes are unreliable after deletions/renumbering).
//
// Compresses to public/assets/audio/{ja,zh,en}/<audioKey>.mp3 (these compressed
// files are the keepers — live + on R2), verifies coverage vs the xlsx, then
// DELETES the processed uncompressed source mp3s so updated_audio/ stays clean
// for the next drop.
//
// NOTE (内容工厂 Phase 2): the uncompressed canonical archive (audio-未压缩-原版/)
// was removed per user decision — only the online/compressed copies are kept,
// and uncompressed sources are regenerable via data_prep/4.语音生成.py. So this
// script no longer archives; it just deletes processed sources.
//
// A drop may contain only some lists / only some languages — anything not
// present is simply skipped.
// ============================================================================

import XLSX from 'xlsx';
import {
  readdirSync, mkdirSync, existsSync, statSync, unlinkSync,
} from 'node:fs';
import { join, dirname, extname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { audioKey } from '../src/utils/audioKey.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DROP_BASE = join(ROOT, 'update_data_folder', 'updated_audio');
const OUT_DIR = join(ROOT, 'public', 'assets', 'audio');

// Source folder (jp/zh/en) → output folder (ja/zh/en) in public/assets/audio
const LANG_MAP = { jp: 'ja', zh: 'zh', en: 'en' };

// Per-list config: which xlsx + sheet to read, and the text column per language.
const LISTS = {
  WordList: {
    xlsx: join(ROOT, 'update_data_folder', 'WordList.xlsx'),
    sheetPref: '单词',
    col: { ja: '单词日语翻译', zh: '单词中文翻译', en: 'English' },
  },
  PhraseList: {
    xlsx: join(ROOT, 'update_data_folder', 'PhraseList.xlsx'),
    sheetPref: '口语',
    col: { ja: '短语日语翻译', zh: '短语中文翻译', en: 'English' },
  },
};

const BITRATE = '48k';
const SAMPLE = '22050';

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

function compressOne(src, dst) {
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

// Extract the text portion of the filename: strip leading "NNNN_", trailing
// "_SUSPECT" review marker, and ".mp3" extension.
function textFromFilename(f) {
  const stem = basename(f, extname(f));
  return stem.replace(/^\d+_/, '').replace(/_SUSPECT$/, '');
}

function hasSuspectMarker(f) {
  return /_SUSPECT\.mp3$/i.test(f);
}

function readXlsxRows(cfg) {
  const wb = XLSX.readFile(cfg.xlsx);
  const sheetName = wb.SheetNames.includes(cfg.sheetPref) ? cfg.sheetPref : wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
}

// Process one list (e.g. WordList). Returns aggregate byte/count totals.
function processList(listName, cfg) {
  const dropDir = join(DROP_BASE, listName);
  if (!existsSync(dropDir)) return null;

  // Which language folders are actually present in this drop?
  const presentLangs = Object.keys(LANG_MAP).filter(
    (srcLang) => existsSync(join(dropDir, srcLang)),
  );
  if (presentLangs.length === 0) return null;

  console.log(`\n\x1b[1m🔊 ${listName}\x1b[0m  (langs: ${presentLangs.join(', ')})`);

  if (!existsSync(cfg.xlsx)) { log.err(`Missing ${cfg.xlsx}`); return null; }
  const rows = readXlsxRows(cfg);
  log.info(`${listName}.xlsx: ${rows.length} rows`);

  // Build expected-key sets from xlsx, for verification.
  const expected = { ja: new Map(), zh: new Map(), en: new Map() }; // key → english (for reporting)
  for (const r of rows) {
    const en = String(r.English || '').trim();
    for (const lang of ['ja', 'zh', 'en']) {
      const text = String(r[cfg.col[lang]] || '').trim();
      if (!text) continue;
      const k = audioKey(text, lang);
      if (!k) continue;
      if (!expected[lang].has(k)) expected[lang].set(k, en);
    }
  }

  let totalIn = 0, totalOut = 0, totalCount = 0;
  const producedKeys = { ja: new Set(), zh: new Set(), en: new Set() };
  const unmatchedFiles = { ja: [], zh: [], en: [] };

  for (const srcLang of presentLangs) {
    const outLang = LANG_MAP[srcLang];
    const srcDir = join(dropDir, srcLang);
    const outDir = join(OUT_DIR, outLang);
    ensureDir(outDir);

    const files = readdirSync(srcDir)
      .filter(f => !f.startsWith('.') && extname(f).toLowerCase() === '.mp3');
    log.sect(`${listName} ${srcLang}/ → ${outLang}/  (${files.length} files)`);

    let count = 0, bytesIn = 0, bytesOut = 0;
    const seenKeys = new Map();
    const suspectFiles = [];

    for (const f of files) {
      if (hasSuspectMarker(f)) suspectFiles.push(f);
      const text = textFromFilename(f);
      if (!text) { log.warn(`  ${f}: empty text after prefix strip — skipping`); continue; }
      const key = audioKey(text, outLang);
      if (!key) { log.warn(`  ${f}: audioKey() empty for "${text}" — skipping`); continue; }

      if (!expected[outLang].has(key)) {
        unmatchedFiles[outLang].push(f);
      }
      if (seenKeys.has(key)) {
        log.warn(`  duplicate key "${key}.mp3" (this: ${f}, prev: ${seenKeys.get(key)}) — overwriting`);
      }
      seenKeys.set(key, f);

      const src = join(srcDir, f);
      const dst = join(outDir, `${key}.mp3`);
      try {
        const sBefore = statSync(src).size;
        compressOne(src, dst);
        const sAfter = statSync(dst).size;
        bytesIn += sBefore;
        bytesOut += sAfter;
        count++;
        producedKeys[outLang].add(key);
        if (count % 50 === 0) log.info(`  ${count}/${files.length} encoded…`);
      } catch (e) {
        log.err(`  failed ${f}: ${e.message}`);
      }
    }

    const ratio = bytesIn ? ((1 - bytesOut / bytesIn) * 100).toFixed(1) : 0;
    log.ok(`${listName} ${outLang}/: ${count}/${files.length} encoded · ${(bytesIn/1024/1024).toFixed(2)} MB → ${(bytesOut/1024/1024).toFixed(2)} MB (-${ratio}%)`);
    if (suspectFiles.length > 0) {
      log.warn(`${outLang}: ${suspectFiles.length} _SUSPECT file(s) flagged for review (stripped marker in output key):`);
      suspectFiles.forEach(f => console.log(`     · ${f}`));
    }
    totalIn += bytesIn; totalOut += bytesOut; totalCount += count;
  }

  // ── Verification ───────────────────────────────────────────────────────────
  log.sect(`${listName}: verification vs ${listName}.xlsx`);
  for (const srcLang of presentLangs) {
    const lang = LANG_MAP[srcLang];
    const missing = [];
    for (const [key, en] of expected[lang]) {
      if (!producedKeys[lang].has(key)) missing.push({ key, en });
    }
    if (missing.length === 0) {
      log.ok(`${lang}: every xlsx row has matching audio in this drop`);
    } else {
      log.warn(`${lang}: ${missing.length} xlsx row(s) without matching audio in this drop:`);
      missing.forEach(({ key, en }) => console.log(`     · "${en}" → expected ${lang}/${key}.mp3`));
    }
    if (unmatchedFiles[lang].length > 0) {
      log.warn(`${lang}: ${unmatchedFiles[lang].length} audio file(s) don't match any xlsx row:`);
      unmatchedFiles[lang].forEach(f => console.log(`     · ${f}`));
    }
  }

  // ── Delete processed uncompressed sources ──────────────────────────────────
  // (No more audio-未压缩-原版 archive — compressed copies in public/assets/audio
  //  are the keepers; uncompressed is regenerable. 内容工厂 Phase 2.)
  log.sect(`${listName}: deleting processed sources from updated_audio/`);
  for (const srcLang of presentLangs) {
    const fromDir = join(dropDir, srcLang);
    let removed = 0;
    for (const f of readdirSync(fromDir).filter(f => !f.startsWith('.'))) {
      try {
        unlinkSync(join(fromDir, f));
        removed++;
      } catch (e) {
        log.err(`  failed to delete ${f}: ${e.message}`);
      }
    }
    log.ok(`${srcLang}: deleted ${removed} processed source file(s)`);
  }

  return { totalIn, totalOut, totalCount };
}

function main() {
  console.log('\n\x1b[1m🔊 Sync updated audio\x1b[0m');

  try { execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' }); }
  catch { log.err('ffmpeg not found — install with `brew install ffmpeg`'); process.exit(1); }

  if (!existsSync(DROP_BASE)) { log.err(`Missing ${DROP_BASE}`); process.exit(1); }

  let grandIn = 0, grandOut = 0, grandCount = 0;
  let processedAny = false;

  for (const [listName, cfg] of Object.entries(LISTS)) {
    const r = processList(listName, cfg);
    if (!r) continue;
    processedAny = true;
    grandIn += r.totalIn; grandOut += r.totalOut; grandCount += r.totalCount;
  }

  if (!processedAny) {
    log.warn('No audio found in update_data_folder/updated_audio/{WordList,PhraseList}/');
    return;
  }

  log.sect('Summary');
  const ratio = grandIn ? ((1 - grandOut / grandIn) * 100).toFixed(1) : 0;
  log.ok(`Encoded ${grandCount} files · ${(grandIn/1024/1024).toFixed(2)} MB → ${(grandOut/1024/1024).toFixed(2)} MB (-${ratio}%)`);
  console.log('\n\x1b[32m✓ Done!\x1b[0m\n');
}

main();
