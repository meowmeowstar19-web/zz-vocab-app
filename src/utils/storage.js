// Per-language-pair storage: each native+target combo gets its own key
const getKey = (langKey = 'zh_en') => `vocab_kids_progress_${langKey}`;

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

// ── Review session word states (errorCount, sessionCorrect) — persisted per target language ──
// This lets card types (B→C→A) and error weights survive between review sessions.
export function getReviewWordStates(targetLang = 'en') {
  try {
    const data = localStorage.getItem(`vocab_review_states_${targetLang}`);
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

export function saveReviewWordStates(states, targetLang = 'en') {
  localStorage.setItem(`vocab_review_states_${targetLang}`, JSON.stringify(states));
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
    return localStorage.getItem(LAST_CHECKIN_KEY(uid)) !== todayLocalIso();
  } catch {
    return false;
  }
}

export function markCheckinShown(uid) {
  try {
    localStorage.setItem(LAST_CHECKIN_KEY(uid), todayLocalIso());
  } catch {}
}

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
