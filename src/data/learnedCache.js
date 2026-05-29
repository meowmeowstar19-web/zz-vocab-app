// Anti-scraping Phase 3 — local cache of LEARNED word/phrase objects (IndexedDB).
//
// Why: once Phase 4 strips the full word list out of the JS bundle, the only
// words the app may hold client-side are the ones the user has actually learned
// (their progress already lists those ids). This store keeps the OBJECT for each
// learned id so the word-list page can render — and works offline — without ever
// pulling the full set from the server.
//
// We NEVER cache the whole library here: callers only write words the user has
// genuinely encountered (LearningPage on serve, WordListPage backfilling its
// already-learned ids). Entries are MERGED by id so a word accumulates its
// per-language fields as the user meets it across different language pairs.

const DB_NAME = 'plushieword';
const STORE = 'learned_words';
const VERSION = 1;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no-indexeddb')); return; }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function mergeWord(prev, next) {
  if (!prev) return next;
  const out = { ...prev };
  for (const k of Object.keys(next)) {
    const v = next[k];
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

// Merge-upsert an array of word/phrase objects (each must have `id`).
export async function cacheLearnedWords(wordObjs) {
  if (!Array.isArray(wordObjs) || wordObjs.length === 0) return;
  let db;
  try { db = await openDb(); } catch { return; }
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
    for (const w of wordObjs) {
      if (!w || !w.id) continue;
      const getReq = store.get(w.id);
      getReq.onsuccess = () => store.put(mergeWord(getReq.result, w));
    }
  });
}

// Returns a Map<id, wordObj> of every cached learned word.
export async function getAllLearnedWords() {
  let db;
  try { db = await openDb(); } catch { return new Map(); }
  return new Promise((resolve) => {
    const map = new Map();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      for (const w of req.result || []) if (w && w.id) map.set(w.id, w);
      resolve(map);
    };
    req.onerror = () => resolve(map);
  });
}
