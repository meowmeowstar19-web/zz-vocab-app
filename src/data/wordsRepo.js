// Anti-scraping Phase 3 — async data layer.
//
// The ONLY client-side door to the locked Supabase content tables is the three
// Phase 2 Edge Functions (get-word-batch / get-phrase-batch / get-meta). They
// require a valid JWT and return content batched + keyset-paginated, never the
// full set in one shot and never a total count.
//
// This module calls those functions (via supabase.functions.invoke, which
// attaches the caller's auth token automatically) and maps each per-pair Edge
// item back into the bundled word/phrase OBJECT shape the app already uses:
//   word:   { id, en, zh, category, level, sentence, sentenceZh, img, ipa?, pinyin?, jaReading?, ja?, jaSentence? }
//   phrase: { id, en, zh, category, level:'oral', img:null, sentence, sentenceZh, ja?, jaSentence?, ipa?, pinyin?, jaReading? }
// so langHelpers (getWordText/getSentence/getPhonetic/isWordAvailable) keeps
// working synchronously and unchanged — only *fetching* becomes async.
//
// Edge item shape (per language pair):
//   { slug, category, level?, image_path, native:{text,sentence,reading,phonetic}, target:{...} }
//   slug == the app's word/phrase id; image_path == the original img filename.

import { supabase } from '../lib/supabase';

// Map one translation object into the absolute-language fields the app reads.
// DB stores IPA/pinyin in `phonetic`, and the Japanese reading in `reading`.
function assignLangFields(obj, lang, tr) {
  if (!tr) return;
  if (lang === 'en') {
    obj.en = tr.text ?? '';
    obj.sentence = tr.sentence ?? '';
    if (tr.phonetic) obj.ipa = tr.phonetic;
  } else if (lang === 'zh') {
    obj.zh = tr.text ?? '';
    obj.sentenceZh = tr.sentence ?? '';
    if (tr.phonetic) obj.pinyin = tr.phonetic;
  } else if (lang === 'ja') {
    obj.ja = tr.text ?? '';
    obj.jaSentence = tr.sentence ?? '';
    if (tr.reading) obj.jaReading = tr.reading;
  }
}

function mapWordItem(item, native, target) {
  const w = { id: item.slug, category: item.category, level: item.level ?? 'beginner', img: item.image_path ?? null, en: '', zh: '' };
  assignLangFields(w, native, item.native);
  assignLangFields(w, target, item.target);
  return w;
}

function mapPhraseItem(item, native, target) {
  const p = { id: item.slug, category: item.category, level: 'oral', img: null, en: '', zh: '' };
  assignLangFields(p, native, item.native);
  assignLangFields(p, target, item.target);
  return p;
}

async function invokeBatch(fn, { native, target, cursor, limit }) {
  const { data, error } = await supabase.functions.invoke(fn, {
    body: { native, target, cursor: cursor ?? null, limit: limit ?? 30 },
  });
  if (error) throw error;
  return data || { items: [], nextCursor: null };
}

// ── Low-level batched fetchers (one Edge request per call) ───────────────────
export async function fetchWordBatch({ native, target, cursor = null, limit = 30 }) {
  const { items, nextCursor } = await invokeBatch('get-word-batch', { native, target, cursor, limit });
  return { items: (items || []).map((it) => mapWordItem(it, native, target)), nextCursor: nextCursor ?? null };
}

export async function fetchPhraseBatch({ native, target, cursor = null, limit = 30 }) {
  const { items, nextCursor } = await invokeBatch('get-phrase-batch', { native, target, cursor, limit });
  return { items: (items || []).map((it) => mapPhraseItem(it, native, target)), nextCursor: nextCursor ?? null };
}

// NOTE (anti-scraping Phase 6 切片2): there is intentionally NO full-list /
// streamAll loader here anymore. The client used to walk every page on open
// (~125 items/sec), which is indistinguishable from a scraper and would trip
// the planned server-side speed line. LearningPage now drives windowed,
// interaction-paced fetching directly via fetchWordBatch/fetchPhraseBatch:
// it pulls only the next small batch and refills its buffer as the user learns,
// so the whole library is never held client-side and never pulled in a burst.

// languages + per-category COUNTS (numbers only, never content).
export async function getMeta({ native, target }) {
  const { data, error } = await supabase.functions.invoke('get-meta', { body: { native, target } });
  if (error) throw error;
  return data || { languages: [], wordCategories: {}, phraseCategories: {} };
}
