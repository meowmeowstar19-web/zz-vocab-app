// ── Spaced Repetition System (SRS) Engine ──
// Levels 0-3: in-session (card-gap based)
// Levels 4-14: cross-session (time-interval based)
// Level 12+: maintenance pool (7-10 day cycle)

// Session step gaps (in number of cards)
export const SESSION_GAPS = [0, 5, 7, 10]; // step 0: learn, step 1: B delay, step 2: C delay, step 3: D delay
export const SESSION_FORMATS = ['A', 'B', 'C', 'D']; // quiz format per step (D = know/don't-know self-assessment)

// D-mode gap when user taps "认识" — larger gap than C, word still returns but less often
export const D_KNOW_GAP = 15;

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

// ── Review words for the learning-screen blend ──
// Unlike getDueReviewWords (strict "is it due yet?"), this returns ALL learned,
// non-mastered words in scope so the learning screen can ALWAYS weave old words
// in alongside new ones — never gated on the SRS interval. Ordering:
//   1. Currently-due words first (recently-learned / most-fragile first — that's
//      getDueReviewWords's own sort: srsLevel ascending, then most overdue).
//   2. Then not-yet-due words, again fragile/recent first (srsLevel asc), then
//      whichever is closest to becoming due.
// Recently-learned words sit at low srsLevels with short intervals, so this
// naturally surfaces "刚学的旧词" before "很久很久的旧词".
export function getReviewWordsForBlend(progress, allWords, now = Date.now()) {
  const due = getDueReviewWords(progress, allWords, now);
  const dueIds = new Set(due.map(w => w.id));
  const notDue = [];
  for (const w of allWords) {
    if (dueIds.has(w.id)) continue;
    const p = progress[w.id];
    if (!p || !p.timestamp || p.mastered) continue;
    notDue.push(w);
  }
  notDue.sort((a, b) => {
    const pa = progress[a.id], pb = progress[b.id];
    const la = pa.srsLevel ?? 4, lb = pb.srsLevel ?? 4;
    if (la !== lb) return la - lb;                       // fragile / recent first
    return (pa.nextReviewAt || 0) - (pb.nextReviewAt || 0); // soonest-due next
  });
  return [...due, ...notDue];
}

// Upper bound on old-word reviews woven into a single learning sitting. Not a
// target — just keeps the queue sane; the dedicated 复习 tab handles unlimited
// review. Ordered fragile/recent-first, so the cap keeps the words that matter.
export const REVIEW_BLEND_CAP = 60;

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
// Chunk sizes for the new/old blend. We learn new words in bursts of 5 (matches
// the natural "5-at-a-time" rhythm), then consolidate with a burst of old-word
// reviews, then repeat. Grouping (vs strict 1:1 every-other-card alternation)
// keeps new-learning momentum and makes review feel like a deliberate round
// instead of whiplash. Equal chunks → still ~1:1 overall, just grouped.
export const NEW_CHUNK = 5;    // new words per burst
export const REVIEW_CHUNK = 5; // old-word reviews per burst

export function buildInterleaved(newWords, reviewWords, progress) {
  const queue = [];
  if (newWords.length === 0 && reviewWords.length === 0) return queue;

  const mkNew = w => ({ word: w, format: 'A', type: 'new', step: 0 });
  const mkReview = w => {
    const level = progress[w.id]?.srsLevel ?? 4;
    return { word: w, format: getReviewFormat(level), type: 'review', level };
  };

  if (newWords.length === 0) return reviewWords.map(mkReview);
  if (reviewWords.length === 0) return newWords.map(mkNew);

  // Burst of new words, then a burst of reviews, repeat. Whichever list is longer
  // tails the queue once the other runs out, so old words are never buried behind
  // a wall of new ones (and vice-versa when the new pool is small).
  let ni = 0, ri = 0;
  while (ni < newWords.length || ri < reviewWords.length) {
    for (let i = 0; i < NEW_CHUNK && ni < newWords.length; i++) queue.push(mkNew(newWords[ni++]));
    for (let i = 0; i < REVIEW_CHUNK && ri < reviewWords.length; i++) queue.push(mkReview(reviewWords[ri++]));
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
