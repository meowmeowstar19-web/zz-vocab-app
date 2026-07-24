// Per-user-scope, per-target storage: each user (or 'guest') has their own
// independent set of progress/review-state slots. Callers pass a storageKey
// of the form `${userScope}_${targetLang}` (e.g. `guest_en`, `u_abc_ja`) and
// this layer just appends it. Account isolation lives in the storageKey
// composition done by callers (see App.jsx → LearningPage / WordListPage).
const getKey = (langKey = 'guest_en') => `vocab_kids_progress_${langKey}`;

// Migrate from native_target pair keys → target-only keys
// (progress belongs to the target language, independent of which native lang you use)
export function migrateProgressToTargetOnly() {
  if (localStorage.getItem('vocab_progress_v2_migrated')) return;
  const langs = ['en', 'ja', 'zh'];
  for (const target of langs) {
    if (localStorage.getItem(`vocab_kids_progress_${target}`)) continue; // already exists
    for (const native of langs) {
      if (native === target) continue;
      const oldData = localStorage.getItem(`vocab_kids_progress_${native}_${target}`);
      if (oldData) {
        localStorage.setItem(`vocab_kids_progress_${target}`, oldData);
        break; // use the first found combo for this target
      }
    }
  }
  localStorage.setItem('vocab_progress_v2_migrated', 'true');
}

// Migrate from device-global keys (`vocab_kids_progress_${target}`) into the
// guest's user-scoped slot (`vocab_kids_progress_guest_${target}`). Before
// this migration, every account on a device shared the same localStorage —
// so the only data we can attribute to anyone is "stuff that was on this
// device before user scoping existed", and the safe assumption is that it
// belongs to whoever's currently using the device as a guest. Cloud-backed
// accounts get their own slots populated by syncOnLogin on next sign-in.
export function migrateProgressToUserScope() {
  if (localStorage.getItem('vocab_progress_v3_migrated')) return;
  const langs = ['en', 'ja', 'zh'];
  for (const target of langs) {
    const legacyProg = localStorage.getItem(`vocab_kids_progress_${target}`);
    const guestProgKey = `vocab_kids_progress_guest_${target}`;
    if (legacyProg && !localStorage.getItem(guestProgKey)) {
      localStorage.setItem(guestProgKey, legacyProg);
    }
    if (legacyProg !== null) localStorage.removeItem(`vocab_kids_progress_${target}`);

    const legacyReview = localStorage.getItem(`vocab_review_states_${target}`);
    const guestReviewKey = `vocab_review_states_guest_${target}`;
    if (legacyReview && !localStorage.getItem(guestReviewKey)) {
      localStorage.setItem(guestReviewKey, legacyReview);
    }
    if (legacyReview !== null) localStorage.removeItem(`vocab_review_states_${target}`);
  }
  localStorage.setItem('vocab_progress_v3_migrated', 'true');
}

// (moveScopeSlots / migrateScopesToAnon are gone with the anonymous-session
// era: the login-auth-core guest is the device's ONE persistent local 'guest'
// slot, so there is no per-anon-uid scope left to shuffle data between.)

// One-time migration from old single-language keys to new pair keys
export function migrateOldProgress() {
  if (localStorage.getItem('vocab_progress_migrated')) return;
  const oldEn = localStorage.getItem('vocab_kids_progress_en');
  const oldJa = localStorage.getItem('vocab_kids_progress_ja');
  if (oldEn && !localStorage.getItem('vocab_kids_progress_zh_en')) {
    localStorage.setItem('vocab_kids_progress_zh_en', oldEn);
  }
  if (oldJa && !localStorage.getItem('vocab_kids_progress_zh_ja')) {
    localStorage.setItem('vocab_kids_progress_zh_ja', oldJa);
  }
  localStorage.setItem('vocab_progress_migrated', 'true');
}

export function getProgress(langKey = 'zh_en') {
  try {
    const data = localStorage.getItem(getKey(langKey));
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

export function saveProgress(progress, langKey = 'zh_en') {
  localStorage.setItem(getKey(langKey), JSON.stringify(progress));
  // Notify App.jsx that local progress changed — it sets a dirty flag so the
  // background heartbeat only spends a cloud round-trip when there's actually
  // new state to push. Without this, the tab pushes every interval forever
  // even when the user has been idle the whole time.
  try { window.dispatchEvent(new CustomEvent('app:progress-changed')); } catch {}
}

export function markWordLearned(wordId, langKey = 'zh_en') {
  const progress = getProgress(langKey);
  if (!progress[wordId]) {
    progress[wordId] = { timestamp: Date.now(), mastered: false };
  } else if (!progress[wordId].timestamp) {
    progress[wordId].timestamp = Date.now();
  }
  saveProgress(progress, langKey);
  return progress;
}

export function toggleMastered(wordId, mastered, langKey = 'zh_en') {
  const progress = getProgress(langKey);
  if (progress[wordId]) {
    progress[wordId].mastered = mastered;
    progress[wordId].masteredAt = mastered ? Date.now() : null;
    saveProgress(progress, langKey);
  }
  return progress;
}

// ── Review session word states (errorCount, sessionCorrect) — persisted per
// user-scope + target language. Caller passes the same `${userScope}_${target}`
// composite that progress uses, keeping the two slots aligned per account.
export function getReviewWordStates(langKey = 'guest_en') {
  try {
    const data = localStorage.getItem(`vocab_review_states_${langKey}`);
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

export function saveReviewWordStates(states, langKey = 'guest_en') {
  localStorage.setItem(`vocab_review_states_${langKey}`, JSON.stringify(states));
}

// ── Cumulative login-day tracking ──
// Counts the number of distinct calendar days (local time) the user has opened
// the app. Stored per user id (or 'guest' when signed out) so it survives
// across reloads and is independent of signup time.
const LOGIN_DAYS_KEY = (uid) => `login_days_${uid || 'guest'}`;

function todayLocalIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function bumpLoginDay(uid) {
  try {
    const key = LOGIN_DAYS_KEY(uid);
    const raw = localStorage.getItem(key);
    const days = raw ? JSON.parse(raw) : [];
    const today = todayLocalIso();
    if (!days.includes(today)) {
      days.push(today);
      localStorage.setItem(key, JSON.stringify(days));
    }
    return days.length;
  } catch {
    return 1;
  }
}

export function getLoginDayCount(uid) {
  try {
    const raw = localStorage.getItem(LOGIN_DAYS_KEY(uid));
    const days = raw ? JSON.parse(raw) : [];
    return Math.max(1, days.length);
  } catch {
    return 1;
  }
}

// ── Daily check-in popup tracking ──
// Separate from login_days: tracks whether today's check-in popup has been
// shown/dismissed, so we only surface it once per calendar day.
const LAST_CHECKIN_KEY = (uid) => `last_checkin_${uid || 'guest'}`;

export function shouldShowCheckin(uid) {
  try {
    const today = todayLocalIso();
    // Each uid (including 'guest') has its own daily dismissal state — the
    // check-in popup follows each account independently. Signing up after
    // dismissing the guest popup gets a fresh "Day 1" check-in on the new
    // account because we no longer carry guest state forward.
    if (localStorage.getItem(LAST_CHECKIN_KEY(uid)) === today) return false;
    return true;
  } catch {
    return false;
  }
}

export function markCheckinShown(uid) {
  try {
    localStorage.setItem(LAST_CHECKIN_KEY(uid), todayLocalIso());
  } catch {}
}

// (The old per-day gate_words counters are gone: the 5-word gate reads the
// guest slot's learned-word count directly — see App.jsx countLearnedWords —
// and authSetup's one-time fold purged the leftover gate_words_* keys.)

// Update SRS fields on a word's progress entry
export function updateWordSRS(wordId, srsUpdate, langKey = 'zh_en') {
  const progress = getProgress(langKey);
  if (!progress[wordId]) {
    progress[wordId] = { timestamp: Date.now(), mastered: false };
  }
  Object.assign(progress[wordId], srsUpdate);
  saveProgress(progress, langKey);
  return progress;
}
