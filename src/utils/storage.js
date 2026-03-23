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
    progress[wordId] = { timestamp: Date.now(), mastered: false, starred: false };
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

export function toggleStar(wordId, langKey = 'zh_en') {
  const progress = getProgress(langKey);
  if (!progress[wordId]) {
    progress[wordId] = { mastered: false, starred: true, starredAt: Date.now() };
  } else {
    const wasStarred = progress[wordId].starred;
    progress[wordId].starred = !wasStarred;
    progress[wordId].starredAt = wasStarred ? null : Date.now();
  }
  saveProgress(progress, langKey);
  return progress;
}

export function isLearned(wordId, langKey = 'zh_en') {
  const progress = getProgress(langKey);
  return !!progress[wordId];
}

export function isMastered(wordId, langKey = 'zh_en') {
  const progress = getProgress(langKey);
  return progress[wordId]?.mastered === true;
}

export function isStarred(wordId, langKey = 'zh_en') {
  const progress = getProgress(langKey);
  return progress[wordId]?.starred === true;
}

// Clear ALL learning progress across all language pairs
export function clearAllProgress() {
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('vocab_kids_progress_')) keysToRemove.push(key);
  }
  keysToRemove.forEach(key => localStorage.removeItem(key));
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

// Update SRS fields on a word's progress entry
export function updateWordSRS(wordId, srsUpdate, langKey = 'zh_en') {
  const progress = getProgress(langKey);
  if (!progress[wordId]) {
    progress[wordId] = { timestamp: Date.now(), mastered: false, starred: false };
  }
  Object.assign(progress[wordId], srsUpdate);
  saveProgress(progress, langKey);
  return progress;
}
