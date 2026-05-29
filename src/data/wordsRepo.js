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

// ── Streaming full-list loader with an in-memory cache ───────────────────────
// Walks every page of a batched endpoint, but invokes `onBatch(accumulated)`
// after EACH page so the UI can paint the first ~50 items immediately instead
// of waiting for the whole library (a cold Edge call is ~1–2s and pages are
// sequential, so the old "await the full set" path cost several seconds before
// the first word appeared).
//
// Results are cached per `kind|native|target` for the lifetime of the page
// session: once a list is fully loaded, re-entering the page / switching tabs /
// toggling word↔oral reuses it instantly with ZERO new requests. Concurrent
// callers (e.g. React StrictMode's double-invoke in dev) share one in-flight
// load instead of doubling the network traffic.
//
// NOTE: this still pulls the whole set (just spread across cached requests) —
// Phase 6's drip-feed is what stops bulk pulls; Phase 3 only moves the SOURCE
// from the bundle to the Edge API and makes that move feel instant.
const _fullCache = new Map();    // key -> resolved full array
const _inflight = new Map();     // key -> Promise<full array>

async function streamAll(kind, fetchBatch, native, target, onBatch) {
  const key = `${kind}|${native}|${target}`;
  // Already fully loaded → hand back the cached list in one shot.
  if (_fullCache.has(key)) {
    const arr = _fullCache.get(key);
    onBatch?.(arr);
    return arr;
  }
  // A load is already running → reuse it (don't double-fetch); the awaiting
  // caller gets the final list once (no progressive paint, which is fine since
  // the original caller is the one painting).
  if (_inflight.has(key)) {
    const arr = await _inflight.get(key);
    onBatch?.(arr);
    return arr;
  }
  const p = (async () => {
    const out = [];
    let cursor = null;
    for (let guard = 0; guard < 2000; guard++) {
      const { items, nextCursor } = await fetchBatch({ native, target, cursor, limit: 50 });
      out.push(...items);
      onBatch?.(out.slice());
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    _fullCache.set(key, out);
    return out;
  })();
  _inflight.set(key, p);
  try {
    return await p;
  } finally {
    _inflight.delete(key);
  }
}

// ── Full-list bridges (drop-in async replacements for the bundle exports) ────
// `onBatch` is optional: pass it to paint progressively as pages stream in;
// omit it to just await the complete (cached) list.
export function getWords({ native, target }, onBatch) {
  return streamAll('w', fetchWordBatch, native, target, onBatch);
}

export function getPhrases({ native, target }, onBatch) {
  return streamAll('p', fetchPhraseBatch, native, target, onBatch);
}

// languages + per-category COUNTS (numbers only, never content).
export async function getMeta({ native, target }) {
  const { data, error } = await supabase.functions.invoke('get-meta', { body: { native, target } });
  if (error) throw error;
  return data || { languages: [], wordCategories: {}, phraseCategories: {} };
}
