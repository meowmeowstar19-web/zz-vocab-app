#!/usr/bin/env node
// One-shot: rename existing *_SUSPECT.mp3 files (in public/ and in the
// canonical update_data_folder/audio/PhraseList/ location) to drop the
// _SUSPECT marker. The marker came from upstream TTS review flagging; the
// audio itself is what's used at runtime, so it needs the canonical key.
//
// Source files keep a SUSPECT.txt note so the user remembers which rows
// were flagged for manual review.

import { readdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PUBLIC_LANG = { ja: 'public/assets/audio/ja', zh: 'public/assets/audio/zh' };
// 内容工厂 Phase 2：audio-未压缩-原版/ 已删（只留线上压缩版）。原本这里给未压缩源
// 写 SUSPECT.txt 备注的环节已无对象 → 留空。真正去 _SUSPECT 标记的活在上面的
// PUBLIC_LANG 块（改 public/assets/audio 里的文件）。
const SRC_LANG    = {};

function stripSuspect(stem) { return stem.replace(/_SUSPECT$/, ''); }

const suspectList = { ja: [], zh: [] };

for (const [lang, dir] of Object.entries(PUBLIC_LANG)) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs)) {
    if (!/_SUSPECT\.mp3$/i.test(f)) continue;
    const stem = basename(f, extname(f));
    const clean = stripSuspect(stem);
    const from = join(abs, f);
    const to   = join(abs, `${clean}.mp3`);
    renameSync(from, to);
    console.log(`renamed public ${lang}/${f} → ${clean}.mp3`);
    suspectList[lang].push(clean);
  }
}

for (const [lang, dir] of Object.entries(SRC_LANG)) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  // Just track which source files have the marker — keep filenames as-is so
  // the marker stays visible when the user inspects the folder.
  const notes = [];
  for (const f of readdirSync(abs)) {
    if (/_SUSPECT\.mp3$/i.test(f)) notes.push(f);
  }
  if (notes.length > 0) {
    const notePath = join(abs, 'SUSPECT.txt');
    writeFileSync(notePath, `Files flagged _SUSPECT by upstream TTS review — verify by ear:\n\n${notes.join('\n')}\n`);
    console.log(`wrote ${dir}/SUSPECT.txt with ${notes.length} entries`);
  }
}

console.log('\nSummary of cleaned suspect keys:');
console.log('ja:', suspectList.ja.length, suspectList.ja);
console.log('zh:', suspectList.zh.length, suspectList.zh);
