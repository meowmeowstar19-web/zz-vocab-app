// Anti-scraping Phase 4 — local rolling prefetch queue (localStorage).
//
// Why this exists: Phase 4 removes the full word list from the JS bundle. A
// brand-new user is covered by the tiny static seed pack (seed.js), but a
// RETURNING user has already learned those seed words — so without a local
// stash of *unlearned* words they'd see an "all learned / review done" flash at
// 0ms until the Edge pool arrives (~1–2s). That regresses the hard "0ms, never
// block on network" rule (see feedback_never_block_on_network).
//
// So we keep a small forward-looking window (~the next few dozen UNLEARNED
// words for the current language pair) persisted locally. On open the app seeds
// its buffer from this window synchronously → instant real new words. The
// window is refreshed in the background after each session's Edge load.
//
// localStorage (NOT IndexedDB) on purpose: the seed read MUST be synchronous to
// paint the first frame at 0ms, and IndexedDB is async-only. The window is a few
// dozen small objects (a few KB) — comfortably within localStorage limits.
//
// This is the client-side that the plan's Phase 6 "预取缓冲" formalizes; it is
// NOT the full library (only a bounded window), so it doesn't reopen the
// scraping hole the bundle removal closes.

const MAX = 60;
const VERSION = 1;

function keyFor(kind, native, target) {
  return `pw_pf_${kind}_${native}_${target}`;
}

// Synchronous read — safe to call during render / state init for a 0ms paint.
// Returns [] on any error (missing, corrupt, no localStorage).
export function readQueueSync(kind, native, target) {
  try {
    const raw = localStorage.getItem(keyFor(kind, native, target));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.words)) return [];
    return parsed.words;
  } catch {
    return [];
  }
}

// Persist a bounded window of (ideally unlearned) word/phrase objects. Callers
// should pass words the user has NOT yet learned so the next open lands on real
// new material. Silently no-ops on quota / serialization errors.
export function persistQueue(kind, native, target, wordObjs) {
  if (!Array.isArray(wordObjs) || wordObjs.length === 0) return;
  try {
    const words = wordObjs.slice(0, MAX);
    localStorage.setItem(keyFor(kind, native, target), JSON.stringify({ v: VERSION, words }));
  } catch {
    // ignore (quota, private mode, etc.) — seed pack remains the fallback
  }
}
