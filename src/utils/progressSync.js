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
// `scope` selects which user-slot to read — 'guest' for the anonymous slot,
// `u_${uid}` for a signed-in user's slot. Each scope has independent
// progress/review-state arrays so account switches don't merge data.
export function readLocalSnapshot(uid, scope) {
  const readScope = scope || (uid ? `u_${uid}` : 'guest');
  const progress = {};
  const reviewStates = {};
  for (const t of TARGETS) {
    progress[t] = readJSON(`vocab_kids_progress_${readScope}_${t}`, {});
    reviewStates[t] = readJSON(`vocab_review_states_${readScope}_${t}`, {});
  }
  // Prefer per-user login days, fall back to guest's history (covers first
  // login after the user did a stretch in guest mode).
  const perUser = readJSON(`login_days_${uid}`, null);
  const guest = readJSON('login_days_guest', []);
  let preferences = null;
  try {
    const n = localStorage.getItem('app_native');
    const tg = localStorage.getItem('app_target');
    if (n || tg) preferences = { nativeLang: n || null, targetLang: tg || null };
  } catch {}
  return {
    progress,
    review_states: reviewStates,
    login_days: perUser || guest || [],
    preferences,
  };
}

// Write the merged snapshot back to localStorage. Caller is responsible for
// triggering a re-render (we don't own UI state). `scope` selects the
// destination user-slot, defaulting to the uid's slot.
export function writeLocalSnapshot(uid, snap, scope) {
  const writeScope = scope || (uid ? `u_${uid}` : 'guest');
  for (const t of TARGETS) {
    writeJSON(`vocab_kids_progress_${writeScope}_${t}`, snap.progress?.[t] || {});
    writeJSON(`vocab_review_states_${writeScope}_${t}`, snap.review_states?.[t] || {});
  }
  if (snap.login_days?.length) {
    writeJSON(`login_days_${uid}`, snap.login_days);
  }
  // Restore the account's saved language preferences so re-login on a fresh
  // device lands on the same langs the user previously picked. If the cloud
  // has no saved preferences for this account, leave the local keys alone —
  // the device's existing pick wins. Wiping them on account-switch was
  // forcing the picker to re-fire every time the user signed into an account
  // that hadn't pushed prefs yet, which was annoying and unwanted.
  if (snap.preferences) {
    try {
      if (snap.preferences.nativeLang) {
        localStorage.setItem('app_native', snap.preferences.nativeLang);
      }
      if (snap.preferences.targetLang) {
        localStorage.setItem('app_target', snap.preferences.targetLang);
      }
    } catch {}
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

export function mergeSnapshots(local, cloud, opts = {}) {
  const { isBindFlow = false } = opts;
  const out = { progress: {}, review_states: {}, login_days: [] };
  for (const t of TARGETS) {
    out.progress[t] = mergeWordMap(local.progress?.[t], cloud.progress?.[t]);
    out.review_states[t] = mergeReviewStates(local.review_states?.[t], cloud.review_states?.[t]);
  }
  const days = new Set([...(local.login_days || []), ...(cloud.login_days || [])]);
  out.login_days = [...days].sort();
  // Language preferences:
  //   - Bind flow (guest → new account): keep local (guest just picked them;
  //     cloud is empty for this brand-new account). They'll be pushed up by
  //     the background sync.
  //   - Plain login with cloud prefs: cloud wins so re-login on a fresh
  //     device restores the account's saved choice.
  //   - Plain login without cloud prefs: emit nothing so writeLocalSnapshot
  //     leaves the device's existing pick alone. Account-switching no longer
  //     wipes the local langs — picker only fires when the device truly has
  //     no pick yet (handled by App.jsx via the absence of `app_native`).
  const cloudPrefs = cloud?.preferences;
  const localPrefs = local?.preferences;
  if (isBindFlow) {
    if (localPrefs) out.preferences = localPrefs;
  } else if (cloudPrefs && (cloudPrefs.nativeLang || cloudPrefs.targetLang)) {
    out.preferences = {
      nativeLang: cloudPrefs.nativeLang || null,
      targetLang: cloudPrefs.targetLang || null,
    };
  }
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

// ── Public API ─────────────────────────────────────────────────────────────
// Run once when the user becomes authenticated. Pulls the cloud row, merges
// with whatever's in localStorage, writes the merged result back to both.
// Idempotent — safe to call on every auth event; cheap when there's no diff.
//
// The old bind-rejection apparatus (bind_flow_active / cloudHasProgress /
// app_anon_scope / clearScope) is gone with the state-machine migration:
// binds keep the anon uid (linkIdentity / updateUser), so "bind onto an
// account that already has data" is structurally impossible — GoTrue's
// identity_already_exists error covers the identity side. A guest logging
// into an EXISTING account has their local data folded into the account's
// scope by the machine's mergeScopes effect BEFORE this runs, so this
// function always operates on the uid's own slot.
let inFlight = null;
export async function syncOnLogin(uid) {
  if (!uid) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const scope = `u_${uid}`;
    try {
      const [local, cloud] = await Promise.all([
        Promise.resolve(readLocalSnapshot(uid, scope)),
        pullFromCloud(uid),
      ]);
      const merged = mergeSnapshots(local, cloud || { progress: {}, review_states: {}, login_days: [] });
      writeLocalSnapshot(uid, merged, scope);
      await pushToCloud(uid, merged);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// Background sync: pull the cloud row, merge with local, write the union to
// both. Used by the heartbeat / visibilitychange / pagehide flushers.
// Always operates on the signed-in user's own scope; never touches guest.
//
// Why pull-merge-push instead of a plain push: a raw upsert overwrites the
// cloud row, so device B pushing its (stale) local would wipe out the rows
// device A had just written. With merge, the cloud always ends up as the
// union — and as a bonus this device picks up the other device's changes
// without waiting for a full reload + syncOnLogin.
//
// Preferences are the one field where local must win in this path: the user
// explicitly picked their langs on THIS device and we don't want a stale
// cloud value to revert their current pick mid-session. syncOnLogin still
// lets cloud win on a fresh login (which is the right behavior for "open on
// a new device and resume my account").
export async function pushLocalToCloud(uid) {
  if (!uid) return;
  const local = readLocalSnapshot(uid, `u_${uid}`);
  const cloud = await pullFromCloud(uid);
  const empty = { progress: {}, review_states: {}, login_days: [] };
  const merged = mergeSnapshots(local, cloud || empty);
  if (local.preferences && (local.preferences.nativeLang || local.preferences.targetLang)) {
    merged.preferences = local.preferences;
  }
  writeLocalSnapshot(uid, merged, `u_${uid}`);
  await pushToCloud(uid, merged);
}
