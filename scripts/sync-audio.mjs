#!/usr/bin/env node
// ============================================================================
// VocabWorkspace Audio Sync  —— 内容工厂 Phase 3
// ----------------------------------------------------------------------------
// Compresses the 工厂's audio drafts into the shippable public tree:
//
//   data_prep/audio/{word,phrase}/{en,zh,jp}/<audioKey>.mp3
//        → public/assets/audio/{en,ja,zh}/<audioKey>.mp3   (48 kbps mono 22050 Hz)
//
// Phase 3 change: the generator (4.语音生成.py) now names every file by
// `audioKey(text,lang)` — exactly the key the app/useAudio.js looks up — so the
// basename IS the match key. No row-number prefixes, no xlsx, no completeness
// gating: we simply re-encode whatever the factory produced. (jp/ folder maps to
// the ja/ output dir to match the app's lang code.)
//
// `*_SUSPECT.mp3` files are duration-flagged drafts pending manual review and are
// NOT shipped — review/rerun them in the generator first.
//
// Flags:
//   --clean   after a file is successfully encoded, delete the factory source
//             (used by publish-all in Phase 3C: 工厂不留永久副本). Default: keep.
// ============================================================================

import {
  readdirSync, mkdirSync, existsSync, statSync, rmSync,
} from 'node:fs';
import { join, dirname, extname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
// 路径钥匙：工厂音频目录从这里取（搬文件夹时一处改）。
import { AUDIO_WORD_DIR, AUDIO_PHRASE_DIR } from '../../data_prep/scripts/paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = join(ROOT, 'public', 'assets', 'audio');

// 工厂源目录（按 word/phrase 两个清单）
const SRC_LISTS = { word: AUDIO_WORD_DIR, phrase: AUDIO_PHRASE_DIR };
// 工厂语言文件夹 → public 输出语言码（jp 源 → ja 输出，对齐 useAudio 的语言码）
const LANG_MAP = { en: 'en', jp: 'ja', zh: 'zh' };

// Encoding target: matches existing public/assets/audio/*/*.mp3
const BITRATE = '48k';
const SAMPLE = '22050';

const CLEAN = process.argv.includes('--clean');

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

// Compress every <audioKey>.mp3 in one factory (list, srcLang) folder into the
// matching public/<outLang>/ dir. Skips _SUSPECT drafts and dotfiles.
function processLangDir(listName, srcLang, outLang) {
  const srcDir = join(SRC_LISTS[listName], srcLang);
  const outDir = join(OUT_DIR, outLang);
  if (!existsSync(srcDir)) {
    return { count: 0, bytesIn: 0, bytesOut: 0, skipped: 0 };
  }

  const files = readdirSync(srcDir).filter(f =>
    !f.startsWith('.') &&
    extname(f).toLowerCase() === '.mp3' &&
    !basename(f, extname(f)).endsWith('_SUSPECT')
  );
  const suspects = readdirSync(srcDir).filter(f =>
    extname(f).toLowerCase() === '.mp3' &&
    basename(f, extname(f)).endsWith('_SUSPECT')
  ).length;

  if (files.length === 0 && suspects === 0) {
    return { count: 0, bytesIn: 0, bytesOut: 0, skipped: 0 };
  }
  ensureDir(outDir);
  log.sect(`${listName} ${srcLang}/ → ${outLang}/  (${files.length} files${suspects ? `, ${suspects} _SUSPECT skipped` : ''})`);

  let count = 0, bytesIn = 0, bytesOut = 0, skipped = suspects;
  for (const f of files) {
    const src = join(srcDir, f);
    const dst = join(outDir, f); // basename = audioKey.mp3, ship as-is
    try {
      const sBefore = statSync(src).size;
      compressOne(src, dst);
      const sAfter = statSync(dst).size;
      bytesIn += sBefore;
      bytesOut += sAfter;
      count++;
      if (CLEAN) rmSync(src);
      if (count % 50 === 0) log.info(`  ${count}/${files.length} done…`);
    } catch (e) {
      log.err(`  failed ${f}: ${e.message}`);
    }
  }

  const ratio = bytesIn ? ((1 - bytesOut / bytesIn) * 100).toFixed(1) : 0;
  log.ok(`${listName} ${outLang}/: ${count}/${files.length} encoded${CLEAN ? ' (sources cleaned)' : ''} · ${(bytesIn/1024/1024).toFixed(2)} MB → ${(bytesOut/1024/1024).toFixed(2)} MB (-${ratio}%)`);
  return { count, bytesIn, bytesOut, skipped };
}

function main() {
  console.log('\n\x1b[1m🔊 VocabWorkspace Audio Sync (工厂 → public)\x1b[0m');

  // Sanity: ffmpeg present?
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
  } catch {
    log.err('ffmpeg not found — install with `brew install ffmpeg`');
    process.exit(1);
  }

  let totalIn = 0, totalOut = 0, totalCount = 0, totalSkipped = 0;
  let anySrc = false;

  for (const listName of Object.keys(SRC_LISTS)) {
    if (!existsSync(SRC_LISTS[listName])) {
      log.info(`No factory dir: ${SRC_LISTS[listName]} — skipping ${listName}`);
      continue;
    }
    anySrc = true;
    for (const [srcLang, outLang] of Object.entries(LANG_MAP)) {
      const r = processLangDir(listName, srcLang, outLang);
      totalIn += r.bytesIn; totalOut += r.bytesOut;
      totalCount += r.count; totalSkipped += r.skipped;
    }
  }

  log.sect('Summary');
  if (!anySrc) {
    log.info('No factory audio folders found — nothing to do.');
  }
  const ratio = totalIn ? ((1 - totalOut / totalIn) * 100).toFixed(1) : 0;
  log.ok(`Encoded ${totalCount} files (${totalSkipped} _SUSPECT skipped) · ${(totalIn/1024/1024).toFixed(2)} MB → ${(totalOut/1024/1024).toFixed(2)} MB (-${ratio}%)`);
  if (!CLEAN && totalCount > 0) {
    log.info('(factory sources kept. Pass --clean to delete them after encoding — used by publish-all.)');
  }

  console.log('\n\x1b[32m✓ Done!\x1b[0m\n');
}

main();
