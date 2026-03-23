// ── Spaced Repetition System (SRS) Engine ──
// Levels 0-3: in-session (card-gap based)
// Levels 4-14: cross-session (time-interval based)
// Level 12+: maintenance pool (7-10 day cycle)

// Session step gaps (in number of cards)
export const SESSION_GAPS = [0, 5, 7, 10]; // step 0: learn, step 1: B delay, step 2: C delay
export const SESSION_FORMATS = ['A', 'B', 'C', 'C']; // quiz format per step

// In-session C injection
export const B_DELAY = 5;          // cards after learning before B review
export const C_ELIGIBLE_DELAY = 6; // cards after B before eligible for C
export const C_INJECT_INTERVAL = 6; // minimum cards between C injections

// Cross-session intervals in milliseconds
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const INTERVALS = {
  4: 30 * MIN,    // 30 minutes
  5: 2 * HOUR,    // 2 hours
  6: 8 * HOUR,    // 8 hours
  7: 1 * DAY,     // 1 day
  8: 2 * DAY,     // 2 days
  9: 3 * DAY,     // 3 days
  10: 5 * DAY,    // 5 days
  11: 7 * DAY,    // 7 days
  12: 8 * DAY,    // maintenance pool ~7-10 days
  13: 9 * DAY,
  14: 10 * DAY,
};

// Get the interval for a given level
export function getInterval(level) {
  if (level <= 3) return 0; // session-internal, no time interval
  if (level >= 14) return INTERVALS[14];
  return INTERVALS[level] || INTERVALS[14];
}

// Quiz format for cross-session review levels
const REVIEW_FORMATS = {
  4: 'B', 5: 'C', 6: 'C',
  7: 'B', 8: 'C', 9: 'C',
  10: 'B', 11: 'C',
  12: 'B', 13: 'C', 14: 'C',
};

export function getReviewFormat(level) {
  return REVIEW_FORMATS[level] || 'C';
}

// ── Get due review words ──
export function getDueReviewWords(progress, allWords, now = Date.now()) {
  const due = [];
  for (const w of allWords) {
    const p = progress[w.id];
    if (!p || !p.timestamp) continue; // not learned
    if (p.mastered) continue; // skipped

    // Words stuck in session (app was closed mid-session) — level 0-3 with no nextReviewAt
    if (p.srsLevel !== undefined && p.srsLevel < 4 && !p.nextReviewAt) {
      due.push(w);
      continue;
    }

    // Words learned before SRS was added (have timestamp but no srsLevel)
    if (p.srsLevel === undefined && p.timestamp) {
      due.push(w);
      continue;
    }

    // Words with scheduled review that's due
    if (p.nextReviewAt && p.nextReviewAt <= now) {
      due.push(w);
      continue;
    }
  }

  // Sort by priority: lower level first, then more overdue first
  due.sort((a, b) => {
    const pa = progress[a.id], pb = progress[b.id];
    const la = pa.srsLevel ?? 4, lb = pb.srsLevel ?? 4;

    // Lower level = more fragile = higher priority
    if (la !== lb) return la - lb;

    // More overdue = higher priority (earlier nextReviewAt first)
    const na = pa.nextReviewAt || 0, nb = pb.nextReviewAt || 0;
    return na - nb;
  });

  return due;
}

// ── Energy budget ──
export const SESSION_ENERGY = 50;
export const NEW_WORD_ENERGY = 3;
export const REVIEW_WORD_ENERGY = 1;

export function calcBudget(dueCount) {
  if (dueCount >= 40) return { newBudget: 3, reviewBudget: 40 };
  if (dueCount >= 25) return { newBudget: 5, reviewBudget: 25 };
  if (dueCount >= 10) return { newBudget: 8, reviewBudget: Math.min(dueCount, 20) };
  return { newBudget: 12, reviewBudget: dueCount };
}

// ── Build interleaved queue ──
export function buildInterleaved(newWords, reviewWords, progress) {
  const queue = [];

  if (newWords.length === 0 && reviewWords.length === 0) return queue;
  if (newWords.length === 0) {
    return reviewWords.map(w => ({
      word: w,
      format: getReviewFormat(progress[w.id]?.srsLevel ?? 4),
      type: 'review',
    }));
  }
  if (reviewWords.length === 0) {
    return newWords.map(w => ({ word: w, format: 'A', type: 'new', step: 0 }));
  }

  // Calculate interleaving ratio: how many new words between each review
  const newPerReview = Math.max(1, Math.round(newWords.length / reviewWords.length));
  let ni = 0, ri = 0;

  while (ni < newWords.length || ri < reviewWords.length) {
    // Add batch of new words
    for (let i = 0; i < newPerReview && ni < newWords.length; i++) {
      queue.push({ word: newWords[ni], format: 'A', type: 'new', step: 0 });
      ni++;
    }
    // Add 1 review word
    if (ri < reviewWords.length) {
      const rw = reviewWords[ri];
      const p = progress[rw.id] || {};
      const level = p.srsLevel ?? 4;
      queue.push({ word: rw, format: getReviewFormat(level), type: 'review', level });
      ri++;
    }
  }

  return queue;
}

// ── Answer handling: compute SRS updates ──
// Returns an object with fields to merge into the word's progress entry
export function computeSrsUpdate(wordProgress, correct, hadWrong, cardType, cardStep) {
  const p = { ...wordProgress };
  const now = Date.now();
  p.lastReviewedAt = now;

  if (cardType === 'new') {
    // Just learned — set initial SRS level
    p.srsLevel = 0;
    return p;
  }

  if (cardType === 'sessionReview') {
    const step = cardStep || 1;
    if (correct && !hadWrong) {
      // Clean correct: advance step
      p.srsLevel = step;
      if (step >= 3) {
        // Done with session steps, transition to cross-session
        p.srsLevel = 4;
        p.nextReviewAt = now + getInterval(4);
      }
    } else if (correct && hadWrong) {
      // Struggled but got it: stay at same step level, will be rescheduled
      p.srsLevel = Math.max(step - 1, 0);
    }
    return p;
  }

  if (cardType === 'review') {
    const currentLevel = p.srsLevel ?? 4;
    if (correct && !hadWrong) {
      // Clean correct: level up
      const newLevel = Math.min(currentLevel + 1, 14);
      p.srsLevel = newLevel;
      p.nextReviewAt = now + getInterval(newLevel);
      if (newLevel >= 12) p.inPool = true;
    } else if (correct && hadWrong) {
      // Struggled: don't advance, reschedule at same interval
      p.srsLevel = currentLevel;
      p.nextReviewAt = now + getInterval(currentLevel);
    } else {
      // Wrong (shouldn't happen with current UI, but handle for safety)
      let newLevel;
      if (currentLevel <= 7) newLevel = 4;
      else if (currentLevel <= 11) newLevel = 7;
      else newLevel = 9;
      p.srsLevel = newLevel;
      p.nextReviewAt = now + getInterval(newLevel);
    }
    return p;
  }

  return p;
}
