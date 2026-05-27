#!/usr/bin/env node
// ============================================================================
// Sync updated audio drops
// ----------------------------------------------------------------------------
// Reads update_data_folder/updated_audio/PhraseList/{jp,zh}/*.mp3 and matches
// each file to a PhraseList.xlsx row by FILENAME TEXT (not the numeric prefix
// — row prefixes are unreliable after deletions/renumbering).
//
// Compresses to public/assets/audio/{ja,zh}/<audioKey>.mp3, verifies coverage
// vs the xlsx, then moves the source mp3s into
// audio-未压缩-原版/PhraseList/{jp,zh}/ (the canonical uncompressed archive
// at the repo root) so updated_audio/ stays clean for the next drop.
// ============================================================================

import XLSX from 'xlsx';
import {
  readdirSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync,
} from 'node:fs';
import { join, dirname, extname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { audioKey } from '../src/utils/audioKey.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_BASE = join(ROOT, 'update_data_folder', 'updated_audio', 'PhraseList');
const CANONICAL_BASE = join(ROOT, 'audio-未压缩-原版', 'PhraseList');
const OUT_DIR = join(ROOT, 'public', 'assets', 'audio');
const XLSX_PATH = join(ROOT, 'update_data_folder', 'PhraseList.xlsx');

// Source folder (jp/zh/en) → output folder (ja/zh/en) in public/assets/audio
const LANG_MAP = { jp: 'ja', zh: 'zh', en: 'en' };
const COL_MAP = { ja: '短语日语翻译', zh: '短语中文翻译', en: 'English' };

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

function readXlsxRows() {
  const wb = XLSX.readFile(XLSX_PATH);
  const sheetName = wb.SheetNames.includes('口语') ? '口语' : wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
}

function main() {
  console.log('\n\x1b[1m🔊 Sync updated audio (PhraseList)\x1b[0m');

  try { execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' }); }
  catch { log.err('ffmpeg not found — install with `brew install ffmpeg`'); process.exit(1); }

  if (!existsSync(XLSX_PATH)) { log.err(`Missing ${XLSX_PATH}`); process.exit(1); }

  const rows = readXlsxRows();
  log.info(`PhraseList.xlsx: ${rows.length} rows`);

  // Build expected-key sets from xlsx, for verification
  const expected = { ja: new Map(), zh: new Map(), en: new Map() }; // key → english (for reporting)
  for (const r of rows) {
    const en = String(r.English || '').trim();
    for (const lang of ['ja', 'zh', 'en']) {
      const text = String(r[COL_MAP[lang]] || '').trim();
      if (!text) continue;
      const k = audioKey(text, lang);
      if (!k) continue;
      if (!expected[lang].has(k)) expected[lang].set(k, en);
    }
  }
  log.info(`Expected keys: ja=${expected.ja.size}, zh=${expected.zh.size}, en=${expected.en.size}`);

  let totalIn = 0, totalOut = 0, totalCount = 0;
  const producedKeys = { ja: new Set(), zh: new Set(), en: new Set() };
  const unmatchedFiles = { ja: [], zh: [], en: [] };

  for (const [srcLang, outLang] of Object.entries(LANG_MAP)) {
    const srcDir = join(SRC_BASE, srcLang);
    if (!existsSync(srcDir)) {
      log.warn(`No source folder: ${srcDir} — skipping`);
      continue;
    }
    const outDir = join(OUT_DIR, outLang);
    ensureDir(outDir);

    const files = readdirSync(srcDir)
      .filter(f => !f.startsWith('.') && extname(f).toLowerCase() === '.mp3');
    log.sect(`${srcLang}/ → ${outLang}/  (${files.length} files)`);

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
    log.ok(`${outLang}/: ${count}/${files.length} encoded · ${(bytesIn/1024/1024).toFixed(2)} MB → ${(bytesOut/1024/1024).toFixed(2)} MB (-${ratio}%)`);
    if (suspectFiles.length > 0) {
      log.warn(`${outLang}: ${suspectFiles.length} _SUSPECT file(s) flagged for review (stripped marker in output key):`);
      suspectFiles.forEach(f => console.log(`     · ${f}`));
    }
    totalIn += bytesIn; totalOut += bytesOut; totalCount += count;
  }

  // ── Verification ───────────────────────────────────────────────────────────
  log.sect('Verification vs PhraseList.xlsx');
  for (const lang of ['ja', 'zh', 'en']) {
    if (producedKeys[lang].size === 0) continue; // didn't process this lang this run
    const missing = [];
    for (const [key, en] of expected[lang]) {
      if (!producedKeys[lang].has(key)) missing.push({ key, en });
    }
    if (missing.length === 0) {
      log.ok(`${lang}: every xlsx row has matching audio`);
    } else {
      log.warn(`${lang}: ${missing.length} xlsx row(s) without matching audio:`);
      missing.forEach(({ key, en }) => console.log(`     · "${en}" → expected ${lang}/${key}.mp3`));
    }
    if (unmatchedFiles[lang].length > 0) {
      log.warn(`${lang}: ${unmatchedFiles[lang].length} audio file(s) don't match any xlsx row:`);
      unmatchedFiles[lang].forEach(f => console.log(`     · ${f}`));
    }
  }

  // ── Move sources to canonical location ─────────────────────────────────────
  log.sect('Moving sources → audio-未压缩-原版/PhraseList/');
  for (const srcLang of Object.keys(LANG_MAP)) {
    const fromDir = join(SRC_BASE, srcLang);
    const toDir   = join(CANONICAL_BASE, srcLang);
    if (!existsSync(fromDir)) continue;
    ensureDir(toDir);

    // Clear stale canonical files in this lang before moving the new batch in.
    for (const old of readdirSync(toDir).filter(f => !f.startsWith('.'))) {
      try { unlinkSync(join(toDir, old)); } catch {}
    }

    let moved = 0;
    for (const f of readdirSync(fromDir).filter(f => !f.startsWith('.'))) {
      try {
        renameSync(join(fromDir, f), join(toDir, f));
        moved++;
      } catch (e) {
        log.err(`  failed to move ${f}: ${e.message}`);
      }
    }
    log.ok(`${srcLang}: moved ${moved} source file(s) into audio-未压缩-原版/PhraseList/${srcLang}/`);
  }

  log.sect('Summary');
  const ratio = totalIn ? ((1 - totalOut / totalIn) * 100).toFixed(1) : 0;
  log.ok(`Encoded ${totalCount} files · ${(totalIn/1024/1024).toFixed(2)} MB → ${(totalOut/1024/1024).toFixed(2)} MB (-${ratio}%)`);
  console.log('\n\x1b[32m✓ Done!\x1b[0m\n');
}

main();
