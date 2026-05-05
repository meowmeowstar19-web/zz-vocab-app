#!/usr/bin/env node
// ============================================================================
// VocabWorkspace Audio Sync
// ----------------------------------------------------------------------------
// Reads update_data_folder/audio/WordList/{en,jp,zh}/####_<text>.mp3
// Strips numeric prefix, lowercases en/, maps jp/ → ja/, and re-encodes each
// file to 48 kbps mono @ 22050 Hz (matches existing public/assets/audio/ size).
// Output: public/assets/audio/{en,ja,zh}/<text>.mp3
// ============================================================================

import {
  readdirSync, mkdirSync, existsSync, statSync, renameSync,
} from 'node:fs';
import { join, dirname, extname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_DIR  = join(ROOT, 'update_data_folder', 'audio', 'WordList');
const OUT_DIR  = join(ROOT, 'public', 'assets', 'audio');
const ARCHIVE  = join(ROOT, 'update_data_folder', 'audio', '_processed');

// jp folder in source maps to ja/ directory in output (matches useAudio lang code)
const LANG_MAP = { en: 'en', jp: 'ja', zh: 'zh' };

// Encoding target: matches existing public/assets/audio/en/*.mp3
const BITRATE  = '48k';
const SAMPLE   = '22050';

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

// Strip leading "####_" prefix and (.mp3) extension. Lowercase if asked.
function deriveName(file, { lower }) {
  const base = basename(file, extname(file));
  const stripped = base.replace(/^\d+_/, '').trim();
  return lower ? stripped.toLowerCase() : stripped;
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

function processLang(srcLang, outLang) {
  const srcDir = join(SRC_DIR, srcLang);
  const outDir = join(OUT_DIR, outLang);
  if (!existsSync(srcDir)) {
    log.warn(`No source dir: ${srcDir} — skipping`);
    return { count: 0, bytesIn: 0, bytesOut: 0 };
  }
  ensureDir(outDir);

  const files = readdirSync(srcDir).filter(f =>
    !f.startsWith('.') && extname(f).toLowerCase() === '.mp3'
  );

  log.sect(`Processing ${srcLang}/ → ${outLang}/  (${files.length} files)`);

  let count = 0, bytesIn = 0, bytesOut = 0;
  const seen = new Map(); // outName → src file (catches duplicates)

  for (const f of files) {
    const src = join(srcDir, f);
    // Lowercase only English (zh/ja filenames are already non-Latin script).
    const name = deriveName(f, { lower: srcLang === 'en' });
    if (!name) {
      log.warn(`  empty name after stripping: ${f}`);
      continue;
    }
    if (seen.has(name)) {
      log.warn(`  duplicate target "${name}.mp3" (from ${f}, was from ${seen.get(name)}) — overwriting`);
    }
    seen.set(name, f);

    const dst = join(outDir, `${name}.mp3`);
    try {
      const sBefore = statSync(src).size;
      compressOne(src, dst);
      const sAfter  = statSync(dst).size;
      bytesIn  += sBefore;
      bytesOut += sAfter;
      count++;
      if (count % 50 === 0) log.info(`  ${count}/${files.length} done…`);
    } catch (e) {
      log.err(`  failed ${f}: ${e.message}`);
    }
  }

  const ratio = bytesIn ? ((1 - bytesOut / bytesIn) * 100).toFixed(1) : 0;
  log.ok(`${outLang}/: ${count}/${files.length} encoded · ${(bytesIn/1024/1024).toFixed(2)} MB → ${(bytesOut/1024/1024).toFixed(2)} MB (-${ratio}%)`);
  return { count, bytesIn, bytesOut };
}

function archiveSource() {
  // Move processed source files out so re-runs don't re-encode them.
  // Skip if SRC_DIR doesn't exist or is empty.
  if (!existsSync(SRC_DIR)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = join(ARCHIVE, stamp);
  ensureDir(target);
  try {
    renameSync(SRC_DIR, join(target, 'WordList'));
    log.ok(`Archived source → update_data_folder/audio/_processed/${stamp}/WordList`);
  } catch (e) {
    log.warn(`Could not archive source: ${e.message}`);
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

  if (!existsSync(SRC_DIR)) {
    log.warn(`No source folder: ${SRC_DIR}`);
    log.info('Drop ####_<word>.mp3 files into update_data_folder/audio/WordList/{en,jp,zh}/ and re-run.');
    return;
  }

  let totalIn = 0, totalOut = 0, totalCount = 0;
  for (const [src, out] of Object.entries(LANG_MAP)) {
    const r = processLang(src, out);
    totalIn += r.bytesIn; totalOut += r.bytesOut; totalCount += r.count;
  }

  log.sect('Summary');
  const ratio = totalIn ? ((1 - totalOut / totalIn) * 100).toFixed(1) : 0;
  log.ok(`Encoded ${totalCount} files · ${(totalIn/1024/1024).toFixed(2)} MB → ${(totalOut/1024/1024).toFixed(2)} MB (-${ratio}%)`);

  if (process.argv.includes('--archive')) {
    archiveSource();
  } else {
    log.info('(source kept in update_data_folder/audio/WordList/. Pass --archive to move it.)');
  }

  console.log('\n\x1b[32m✓ Done!\x1b[0m\n');
}

main();
