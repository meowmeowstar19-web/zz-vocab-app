#!/usr/bin/env node
// ============================================================================
// Push content (words + phrases) to Supabase  — Anti-scraping Phase 1
// ----------------------------------------------------------------------------
// Reads the ALREADY-GENERATED src/data/{words,oralPhrases,jaData,phonetics,
// pinyin}.js (the app's source of truth, produced by `npm run sync`) and
// upserts it into the language-agnostic Supabase schema created by
// migrations/20260528000000_antiscrape_content_schema.sql.
//
// Why read generated JS and not WordList.xlsx directly:
//   sync-data.mjs stays the SINGLE Excel parser. This script only mirrors its
//   output into the DB, so the two can never drift, and we don't touch the
//   sensitive sync pipeline. Workflow:  改 Excel → npm run sync → npm run push:supabase
//
// Upsert is keyed by slug (== the app's word/phrase id), so it's idempotent and
// safe to re-run. The app does NOT read from Supabase yet — that's Phase 3/4.
//
// Usage:
//   node scripts/push-to-supabase.mjs           # import / re-import everything
//   node scripts/push-to-supabase.mjs --dry     # parse + report, no network
//
// Requires .env.local with:
//   VITE_SUPABASE_URL   (reused) and SUPABASE_SERVICE_ROLE_KEY  (server-only,
//   never shipped to the client — keep it out of any VITE_ var).
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');

const log = {
  info:    (m) => console.log(`\x1b[36m→\x1b[0m ${m}`),
  ok:      (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`),
  warn:    (m) => console.log(`\x1b[33m⚠\x1b[0m ${m}`),
  err:     (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`),
  section: (m) => console.log(`\n\x1b[1m\x1b[34m── ${m} ──\x1b[0m`),
};

// ── Load env from .env.local (same pattern as upload-r2.mjs) ──────────────────
function loadEnv() {
  const envPath = join(ROOT, '.env.local');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (process.env[k] === undefined) process.env[k] = v.replace(/^["']|["']$/g, '');
    }
  }
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [];
  if (!url) missing.push('VITE_SUPABASE_URL');
  if (!key) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    log.err(`missing env vars in .env.local: ${missing.join(', ')}`);
    log.info('Add SUPABASE_SERVICE_ROLE_KEY=... to .env.local (Supabase → Project Settings → API → service_role). It is server-only — never prefix with VITE_.');
    process.exit(1);
  }
  return { url, key };
}

// ── Languages (static — adding one is a one-line edit + a sync) ───────────────
const LANGUAGES = [
  { code: 'en', name: 'English', ipa_kind: 'ipa' },
  { code: 'zh', name: '中文',    ipa_kind: 'pinyin' },
  { code: 'ja', name: '日本語',  ipa_kind: 'kana' },
];

const clean = (v) => {
  const s = (v == null ? '' : String(v)).trim();
  return s === '' ? null : s;
};

// A translation row is only emitted when it carries actual content (text or
// sentence) — avoids empty zh/ja rows for words that lack that language.
function transRow(idField, idVal, lang, { text, sentence, reading, phonetic }) {
  const t = clean(text), s = clean(sentence), r = clean(reading), p = clean(phonetic);
  if (!t && !s && !r && !p) return null;
  return { [idField]: idVal, lang_code: lang, text: t, sentence: s, reading: r, phonetic: p };
}

async function chunkedUpsert(supabase, table, rows, onConflict) {
  const SIZE = 500;
  for (let i = 0; i < rows.length; i += SIZE) {
    const slice = rows.slice(i, i + SIZE);
    const { error } = await supabase.from(table).upsert(slice, { onConflict });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }
}

async function main() {
  console.log('\n\x1b[1m⬆️  Push content to Supabase\x1b[0m');

  // Load generated data (app's source of truth)
  const { words }       = await import(join(ROOT, 'src/data/words.js'));
  const { oralPhrases } = await import(join(ROOT, 'src/data/oralPhrases.js'));
  const { jaData }      = await import(join(ROOT, 'src/data/jaData.js'));
  const { phoneticMap } = await import(join(ROOT, 'src/data/phonetics.js'));
  const { pinyinMap }   = await import(join(ROOT, 'src/data/pinyin.js'));

  log.section('Building rows');

  // ── Words ──────────────────────────────────────────────────────────────
  const wordRows = words.map((w) => ({
    slug: w.id, category: clean(w.category), level: clean(w.level), image_path: clean(w.img),
  }));

  const wordTransSpecs = words.map((w) => {
    const ja = jaData[w.en] || {};
    return {
      slug: w.id,
      langs: [
        ['en', { text: w.en, sentence: w.sentence, phonetic: phoneticMap[w.en] }],
        ['zh', { text: w.zh, sentence: w.sentenceZh, reading: pinyinMap[w.zh] }],
        ['ja', { text: ja.ja, sentence: ja.sentence, reading: ja.reading }],
      ],
    };
  });

  // ── Phrases ────────────────────────────────────────────────────────────
  const phraseRows = oralPhrases.map((p) => ({ slug: p.id, category: clean(p.category) }));

  const phraseTransSpecs = oralPhrases.map((p) => ({
    slug: p.id,
    langs: [
      ['en', { text: p.en, sentence: p.sentence, phonetic: p.ipa }],
      ['zh', { text: p.zh, sentence: p.sentenceZh, reading: p.pinyin }],
      ['ja', { text: p.ja, sentence: p.jaSentence, reading: p.jaReading }],
    ],
  }));

  log.ok(`${wordRows.length} words, ${phraseRows.length} phrases`);

  if (DRY) {
    log.section('Dry run — sample');
    console.log('word[0]:', wordRows[0]);
    console.log('word_translations[0]:', wordTransSpecs[0].langs.map(([l, d]) => transRow('word_id', '<id>', l, d)).filter(Boolean));
    console.log('phrase[0]:', phraseRows[0]);
    log.info('No network calls made (--dry).');
    return;
  }

  const { url, key } = loadEnv();
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // ── Upsert languages ─────────────────────────────────────────────────────
  log.section('Upserting');
  await chunkedUpsert(supabase, 'languages', LANGUAGES, 'code');
  log.ok(`languages (${LANGUAGES.length})`);

  // ── Words + translations ───────────────────────────────────────────────
  await chunkedUpsert(supabase, 'words', wordRows, 'slug');
  const { data: wordIds, error: wErr } = await supabase.from('words').select('id, slug');
  if (wErr) throw new Error(`fetch word ids failed: ${wErr.message}`);
  const wordIdBySlug = new Map(wordIds.map((r) => [r.slug, r.id]));

  const wordTrans = [];
  for (const spec of wordTransSpecs) {
    const id = wordIdBySlug.get(spec.slug);
    if (!id) { log.warn(`no id for word slug ${spec.slug}`); continue; }
    for (const [lang, data] of spec.langs) {
      const row = transRow('word_id', id, lang, data);
      if (row) wordTrans.push(row);
    }
  }
  await chunkedUpsert(supabase, 'word_translations', wordTrans, 'word_id,lang_code');
  log.ok(`words (${wordRows.length}) + word_translations (${wordTrans.length})`);

  // ── Phrases + translations ──────────────────────────────────────────────
  await chunkedUpsert(supabase, 'phrases', phraseRows, 'slug');
  const { data: phraseIds, error: pErr } = await supabase.from('phrases').select('id, slug');
  if (pErr) throw new Error(`fetch phrase ids failed: ${pErr.message}`);
  const phraseIdBySlug = new Map(phraseIds.map((r) => [r.slug, r.id]));

  const phraseTrans = [];
  for (const spec of phraseTransSpecs) {
    const id = phraseIdBySlug.get(spec.slug);
    if (!id) { log.warn(`no id for phrase slug ${spec.slug}`); continue; }
    for (const [lang, data] of spec.langs) {
      const row = transRow('phrase_id', id, lang, data);
      if (row) phraseTrans.push(row);
    }
  }
  await chunkedUpsert(supabase, 'phrase_translations', phraseTrans, 'phrase_id,lang_code');
  log.ok(`phrases (${phraseRows.length}) + phrase_translations (${phraseTrans.length})`);

  console.log('\n\x1b[32m✓ Done — content is in Supabase. App behaviour unchanged (still reads bundled JS).\x1b[0m\n');
}

main().catch((e) => {
  console.error('\n\x1b[31m✗ Push failed:\x1b[0m', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
