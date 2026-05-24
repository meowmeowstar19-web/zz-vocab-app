// Pulls/pushes localStorage state to the user_progress row in Supabase, and
// merges cloud + local on login so a returning user keeps anything they did
// while signed out (guest mode) or on another device.
import { supabase } from '../lib/supabase';

const TARGETS = ['en', 'ja', 'zh'];

// ── localStorage helpers ───────────────────────────────────────────────────
function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// Snapshot every local key the sync owns, shaped to match the cloud row.
export function readLocalSnapshot(uid) {
  const progress = {};
  const reviewStates = {};
  for (const t of TARGETS) {
    progress[t] = readJSON(`vocab_kids_progress_${t}`, {});
    reviewStates[t] = readJSON(`vocab_review_states_${t}`, {});
  }
  // Prefer per-user login days, fall back to guest's history (covers first
  // login after the user did a stretch in guest mode).
  const perUser = readJSON(`login_days_${uid}`, null);
  const guest = readJSON('login_days_guest', []);
  return {
    progress,
    review_states: reviewStates,
    login_days: perUser || guest || [],
  };
}

// Write the merged snapshot back to localStorage. Caller is responsible for
// triggering a re-render (we don't own UI state).
export function writeLocalSnapshot(uid, snap) {
  for (const t of TARGETS) {
    writeJSON(`vocab_kids_progress_${t}`, snap.progress?.[t] || {});
    writeJSON(`vocab_review_states_${t}`, snap.review_states?.[t] || {});
  }
  if (snap.login_days?.length) {
    writeJSON(`login_days_${uid}`, snap.login_days);
  }
}

// ── Merge ──────────────────────────────────────────────────────────────────
// Picks the most recently touched entry per word, but unions `mastered` so a
// device that learned-then-mastered doesn't lose the mastered flag if another
// device only saw the "learned" state.
function touchedAt(entry) {
  if (!entry) return 0;
  return Math.max(entry.timestamp || 0, entry.masteredAt || 0, entry.lastReviewedAt || 0);
}

function mergeWordMap(localMap = {}, cloudMap = {}) {
  const out = {};
  const ids = new Set([...Object.keys(localMap), ...Object.keys(cloudMap)]);
  for (const id of ids) {
    const l = localMap[id];
    const c = cloudMap[id];
    if (!l) { out[id] = c; continue; }
    if (!c) { out[id] = l; continue; }
    const winner = touchedAt(l) >= touchedAt(c) ? l : c;
    out[id] = { ...winner, mastered: !!(l.mastered || c.mastered) };
    // Preserve the *earliest* masteredAt if both sides have it, else the one
    // that exists. Tracks when the word first became mastered.
    if (l.mastered || c.mastered) {
      const lm = l.masteredAt || 0;
      const cm = c.masteredAt || 0;
      const masteredAt = (lm && cm) ? Math.min(lm, cm) : (lm || cm || winner.masteredAt || Date.now());
      if (masteredAt) out[id].masteredAt = masteredAt;
    }
  }
  return out;
}

// Review states are session bookkeeping; on conflict, prefer the entry with
// more recorded activity (sessionCorrect + errorCount summed).
function mergeReviewStates(localMap = {}, cloudMap = {}) {
  const out = {};
  const ids = new Set([...Object.keys(localMap), ...Object.keys(cloudMap)]);
  for (const id of ids) {
    const l = localMap[id];
    const c = cloudMap[id];
    if (!l) { out[id] = c; continue; }
    if (!c) { out[id] = l; continue; }
    const lScore = (l.sessionCorrect || 0) + (l.errorCount || 0);
    const cScore = (c.sessionCorrect || 0) + (c.errorCount || 0);
    out[id] = lScore >= cScore ? l : c;
  }
  return out;
}

export function mergeSnapshots(local, cloud) {
  const out = { progress: {}, review_states: {}, login_days: [] };
  for (const t of TARGETS) {
    out.progress[t] = mergeWordMap(local.progress?.[t], cloud.progress?.[t]);
    out.review_states[t] = mergeReviewStates(local.review_states?.[t], cloud.review_states?.[t]);
  }
  const days = new Set([...(local.login_days || []), ...(cloud.login_days || [])]);
  out.login_days = [...days].sort();
  return out;
}

// ── Network ────────────────────────────────────────────────────────────────
async function pullFromCloud(uid) {
  const { data, error } = await supabase
    .from('user_progress')
    .select('data')
    .eq('user_id', uid)
    .maybeSingle();
  if (error) {
    console.warn('[progressSync] pull failed:', error.message);
    return null;
  }
  return data?.data || null;
}

async function pushToCloud(uid, snap) {
  const { error } = await supabase
    .from('user_progress')
    .upsert({ user_id: uid, data: snap }, { onConflict: 'user_id' });
  if (error) console.warn('[progressSync] push failed:', error.message);
  return !error;
}

// True if the cloud snapshot has any progress entries for any target lang.
// Used to detect "this account is already in use" during a bind attempt.
function cloudHasProgress(cloud) {
  if (!cloud) return false;
  const p = cloud.progress || {};
  for (const t of TARGETS) {
    if (Object.keys(p[t] || {}).length > 0) return true;
  }
  return false;
}

// ── Public API ─────────────────────────────────────────────────────────────
// Run once when the user becomes authenticated. Pulls the cloud row, merges
// with whatever's in localStorage, writes the merged result back to both.
// Idempotent — safe to call on every auth event; cheap when there's no diff.
//
// When `bind_flow_active` is set in localStorage (LoginPromptModal sets it
// before initiating OAuth / email login), we refuse to merge if the target
// account already has cloud progress — otherwise the guest's local data would
// overwrite the existing account. Caller can detect this via the `rejected`
// field on the returned object.
//
// The flag is NOT cleared on rejection. Supabase fires multiple auth events
// per OAuth callback (SIGNED_IN, INITIAL_SESSION, getSession.then) and the
// emit-initial-session path can be delayed by an internal lock — long enough
// for the first syncOnLogin's `inFlight` promise to resolve and the next call
// to start fresh. If we cleared early, that later call would see
// isBindFlow=false and merge the existing account's cloud data into the
// guest's localStorage. Leaving the flag set means every call in the same
// auth window rejects consistently. Caller clears the flag after handling
// the rejection.
let inFlight = null;
export async function syncOnLogin(uid) {
  if (!uid) return { rejected: false };
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const isBindFlow = (() => {
      try { return localStorage.getItem('bind_flow_active') === '1'; }
      catch { return false; }
    })();
    try {
      const [local, cloud] = await Promise.all([
        Promise.resolve(readLocalSnapshot(uid)),
        pullFromCloud(uid),
      ]);
      if (isBindFlow && cloudHasProgress(cloud)) {
        // Don't write anything — caller is responsible for signing out so the
        // guest's local data survives for a retry against a different account.
        // Flag stays set so any delayed parallel syncOnLogin call also rejects.
        return { rejected: true, reason: 'account_in_use' };
      }
      const merged = mergeSnapshots(local, cloud || { progress: {}, review_states: {}, login_days: [] });
      writeLocalSnapshot(uid, merged);
      await pushToCloud(uid, merged);
      // Successful merge — clear the bind flag so future TOKEN_REFRESHED or
      // re-mount events for this same user aren't misinterpreted as a fresh
      // bind attempt.
      if (isBindFlow) {
        try { localStorage.removeItem('bind_flow_active'); } catch {}
      }
      return { rejected: false };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// Push the current localStorage snapshot up. Use for background sync —
// debounced timer, visibilitychange, beforeunload.
export async function pushLocalToCloud(uid) {
  if (!uid) return;
  const snap = readLocalSnapshot(uid);
  await pushToCloud(uid, snap);
}
