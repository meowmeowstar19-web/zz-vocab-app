#!/usr/bin/env node
// ============================================================================
// Generate the client seed pack + content metadata — Anti-scraping Phase 4
// ----------------------------------------------------------------------------
// Reads the ALREADY-GENERATED src/data/{words,oralPhrases,jaData,phonetics,
// pinyin}.js and emits two SMALL files that the client bundle is allowed to
// import once the full content files are no longer imported by the app:
//
//   src/data/seed.js        — the ~30 starter words (all-language fields), so a
//                             brand-new user sees a word at 0ms before the Edge
//                             API delivers the real pool. Mirrors the object
//                             shape produced by wordsRepo.mapWordItem.
//   src/data/contentMeta.js — language-neutral UI metadata (category slug lists
//                             + oral category labels). NOT scrapeable content.
//
// Why a separate script (not part of sync-data.mjs): sync-data.mjs stays the
// SINGLE Excel parser. This only mirrors its generated output, exactly like
// push-to-supabase.mjs, so the two can never drift and the sensitive sync
// pipeline is untouched. Run it after `npm run sync` (publish-all wires it in).
//
// NOTE: the seed list below is the 2026-05-29 PLACEHOLDER set (Claude-picked,
// 31 words across animals/food/colors/actions/mood). It will be replaced by a
// `seed` column in WordList.xlsx once the user finalizes it.
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_DATA = join(ROOT, 'src', 'data');

const log = {
  info: (m) => console.log(`\x1b[36m→\x1b[0m ${m}`),
  ok:   (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`),
  warn: (m) => console.log(`\x1b[33m⚠\x1b[0m ${m}`),
};

// PLACEHOLDER starter set (slugs == word ids). Replace via Excel `seed` column.
const SEED_WORD_SLUGS = [
  'cat', 'dog', 'monkey', 'rabbit', 'elephant', 'lion', 'frog', 'turtle', 'shark', 'swan',
  'apple', 'banana', 'strawberry', 'watermelon', 'pizza', 'ice-cream', 'cake', 'durian', 'avocado', 'cookie',
  'red', 'blue', 'yellow', 'green', 'pink',
  'eat', 'sleep', 'dance', 'sing', 'swim',
  'happy',
];
const SEED_PHRASE_SLUGS = []; // none for now (placeholder set is words-only)

const clean = (v) => {
  const s = (v == null ? '' : String(v)).trim();
  return s === '' ? undefined : s;
};

// Assemble one word into the all-language object shape the app reads
// (identical to wordsRepo.mapWordItem output).
function assembleWord(w, jaData, phoneticMap, pinyinMap) {
  const ja = jaData[w.en] || {};
  const obj = {
    id: w.id, category: w.category, level: w.level, img: w.img,
    en: w.en, zh: w.zh, sentence: w.sentence, sentenceZh: w.sentenceZh,
    ipa: phoneticMap[w.en], pinyin: pinyinMap[w.zh],
    ja: ja.ja, jaReading: ja.reading, jaSentence: ja.sentence,
  };
  for (const k of Object.keys(obj)) if (obj[k] === undefined || obj[k] === null || obj[k] === '') delete obj[k];
  return obj;
}

async function main() {
  const { words }       = await import(join(SRC_DATA, 'words.js'));
  const { oralPhrases, oralCategories, ORAL_CATEGORY_LABELS } = await import(join(SRC_DATA, 'oralPhrases.js'));
  const { categories }  = await import(join(SRC_DATA, 'words.js'));
  const { jaData }      = await import(join(SRC_DATA, 'jaData.js'));
  const { phoneticMap } = await import(join(SRC_DATA, 'phonetics.js'));
  const { pinyinMap }   = await import(join(SRC_DATA, 'pinyin.js'));

  const wordById = new Map(words.map((w) => [w.id, w]));
  const phraseById = new Map(oralPhrases.map((p) => [p.id, p]));

  const seedWords = [];
  const missingW = [];
  for (const slug of SEED_WORD_SLUGS) {
    const w = wordById.get(slug);
    if (!w) { missingW.push(slug); continue; }
    seedWords.push(assembleWord(w, jaData, phoneticMap, pinyinMap));
  }
  const seedPhrases = [];
  const missingP = [];
  for (const slug of SEED_PHRASE_SLUGS) {
    const p = phraseById.get(slug);
    if (!p) { missingP.push(slug); continue; }
    seedPhrases.push(p);
  }

  if (missingW.length) log.warn(`seed words not found in data (skipped): ${missingW.join(', ')}`);
  if (missingP.length) log.warn(`seed phrases not found in data (skipped): ${missingP.join(', ')}`);

  // ── Per-pair, per-category COUNTS (numbers only, never content) ─────────────
  // These mirror what the get-meta Edge Function returns, but baked into the
  // bundle so the learning-page counter shows the true total at 0ms (no network
  // / auth race). Availability rule = isWordAvailable: the item must have text in
  // BOTH languages (en=en, zh=zh, ja=ja). Word ja comes from jaData; phrase ja is
  // on the phrase object already.
  const PAIRS = [['zh','en'],['zh','ja'],['en','zh'],['en','ja'],['ja','zh'],['ja','en']];
  const txt = (o, lang) => (lang === 'en' ? o.en : lang === 'zh' ? o.zh : (o.ja || '')) || '';
  const countByCat = (items, n, t) => {
    const out = {};
    for (const it of items) {
      if (!txt(it, n) || !txt(it, t)) continue;
      out[it.category] = (out[it.category] || 0) + 1;
    }
    return out;
  };
  const allWords = words.map((w) => assembleWord(w, jaData, phoneticMap, pinyinMap));
  const wordCounts = {};
  const phraseCounts = {};
  for (const [n, t] of PAIRS) {
    wordCounts[`${n}_${t}`] = countByCat(allWords, n, t);
    phraseCounts[`${n}_${t}`] = countByCat(oralPhrases, n, t);
  }

  const banner = (src) =>
    `// AUTO-GENERATED by scripts/gen-seed.mjs — do not edit by hand\n// Source: ${src}\n// Last generated: ${new Date().toISOString()}\n\n`;

  // ── seed.js ──────────────────────────────────────────────────────────────
  const seedOut =
    banner('src/data/{words,oralPhrases,jaData,phonetics,pinyin}.js (PLACEHOLDER seed set)') +
    '// Tiny starter pack so a brand-new user sees a word at 0ms before the Edge\n' +
    '// API delivers the real (login-gated) pool. NOT the full library.\n\n' +
    `export const seedWords = ${JSON.stringify(seedWords, null, 2)};\n\n` +
    `export const seedPhrases = ${JSON.stringify(seedPhrases, null, 2)};\n`;
  writeFileSync(join(SRC_DATA, 'seed.js'), seedOut);

  // ── contentMeta.js ─────────────────────────────────────────────────────────
  const metaOut =
    banner('src/data/{words,oralPhrases}.js') +
    '// Language-neutral UI metadata (category slug lists + oral labels). These\n' +
    '// are NOT scrapeable content, so they may live in the client bundle after\n' +
    '// the full word/phrase data moves to Supabase (Phase 4).\n\n' +
    `export const categories = ${JSON.stringify(categories)};\n\n` +
    `export const oralCategories = ${JSON.stringify(oralCategories)};\n\n` +
    `export const ORAL_CATEGORY_LABELS = ${JSON.stringify(ORAL_CATEGORY_LABELS, null, 2)};\n\n` +
    '// Per-pair, per-category COUNTS (numbers only — NOT scrapeable content; these\n' +
    '// are the same totals get-meta returns to any logged-in user). Baked in so the\n' +
    '// learning-page denominator is correct at 0ms, survives clear-data / offline /\n' +
    '// logged-out, and never climbs as windowed batches load. Key = `${native}_${target}`.\n\n' +
    `export const WORD_CATEGORY_COUNTS = ${JSON.stringify(wordCounts, null, 2)};\n\n` +
    `export const PHRASE_CATEGORY_COUNTS = ${JSON.stringify(phraseCounts, null, 2)};\n`;
  writeFileSync(join(SRC_DATA, 'contentMeta.js'), metaOut);

  log.ok(`seed.js: ${seedWords.length} words, ${seedPhrases.length} phrases`);
  log.ok(`contentMeta.js: ${categories.length} word categories, ${oralCategories.length} oral categories, counts for ${PAIRS.length} pairs`);
}

main().catch((e) => {
  console.error('\n\x1b[31m✗ gen-seed failed:\x1b[0m', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
