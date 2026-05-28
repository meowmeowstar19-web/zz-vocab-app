import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { words, wordsShuffled, categories } from '../data/words';
import { jaData } from '../data/jaData';
import { oralPhrases, oralPhrasesShuffled, oralCategories, ORAL_CATEGORY_LABELS } from '../data/oralPhrases';
import { vocabCategoryCovers, oralCategoryCovers } from '../data/categoryCovers';
import { speakWordByLang, playCorrectSound, playWrongSound, playSlaySound } from '../hooks/useAudio';
import RubyText, { stripRuby } from './RubyText';
import { getProgress, markWordLearned, toggleMastered, saveProgress, updateWordSRS, getReviewWordStates, saveReviewWordStates } from '../utils/storage';
import {
  getWordText, getSentence, getPhonetic, isWordAvailable,
  getTranslationPair, getFontFamily, UI_TEXT, CATEGORY_LABELS,
} from '../utils/langHelpers';
import {
  getDueReviewWords, calcBudget, buildInterleaved, getInterval,
  getReviewFormat, SESSION_GAPS, SESSION_FORMATS, D_KNOW_GAP,
} from '../utils/srs';
import { usePostHog } from '@posthog/react';
import { getFigmaAssetUrl, getImageUrl } from '../utils/assetUrl';

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getOptions(correctWord, wordPool, nativeLang) {
  const correctText = getWordText(correctWord, nativeLang);
  const others = wordPool.filter(w => w.id !== correctWord.id && getWordText(w, nativeLang) !== correctText);
  // Dedup by displayed text — two different entries can share the same native-lang
  // translation (e.g. "you're welcome" and "Don't mention it." both → "不客气"), and
  // without this dedup both could land in the wrong-options list, producing two
  // identical buttons.
  const seen = new Set([correctText]);
  const wrongOnes = [];
  for (const w of shuffle(others)) {
    const t = getWordText(w, nativeLang);
    if (seen.has(t)) continue;
    seen.add(t);
    wrongOnes.push(t);
    if (wrongOnes.length === 3) break;
  }
  return shuffle([correctText, ...wrongOnes]);
}

function getImageOptions(correctWord, wordPool) {
  const others = wordPool.filter(w => w.id !== correctWord.id && w.img !== correctWord.img);
  const wrongOnes = shuffle(others).slice(0, 3);
  return shuffle([correctWord, ...wrongOnes]);
}

// ── Review Queue Algorithm ──
const REVIEW_DAY = 24 * 60 * 60 * 1000;

function getReviewQuestionType(wordState, isOralMode = false) {
  const { errorCount, sessionCorrect } = wordState;
  if (errorCount >= 2) return 'A';
  if (errorCount === 1) return isOralMode ? 'C' : 'B';
  // Normal mode: one pass per format — B (image), C (text), D (know/don't-know).
  // Oral mode has no images, so B is dropped: pass goes C → D only.
  if (isOralMode) return sessionCorrect >= 1 ? 'D' : 'C';
  if (sessionCorrect >= 2) return 'D';
  if (sessionCorrect === 1) return 'C';
  return 'B';
}

function buildReviewQueueFromWords(eligibleWords, progress, wordStates = {}) {
  const now = Date.now();
  const newGroup = [], midGroup = [], oldGroup = [];
  for (const word of eligibleWords) {
    const age = now - (progress[word.id]?.timestamp || 0);
    if (age < 7 * REVIEW_DAY) newGroup.push(word);
    else if (age < 30 * REVIEW_DAY) midGroup.push(word);
    else oldGroup.push(word);
  }
  // Within each group: high-error words (errorCount >= 2) bubble to the front,
  // the rest are shuffled randomly — so frequently-wrong words appear earlier.
  function sortGroup(group) {
    const highErr = shuffle(group.filter(w => (wordStates[w.id]?.errorCount || 0) >= 2));
    const rest    = shuffle(group.filter(w => (wordStates[w.id]?.errorCount || 0) < 2));
    return [...highErr, ...rest];
  }
  // Round-robin interleave: new, mid, old — old words appear throughout, not just at the back
  const result = [];
  const iters = [sortGroup(newGroup), sortGroup(midGroup), sortGroup(oldGroup)].filter(g => g.length > 0).map(g => ({ arr: g, i: 0 }));
  let any = true;
  while (any) {
    any = false;
    for (const it of iters) {
      if (it.i < it.arr.length) { result.push(it.arr[it.i++]); any = true; }
    }
  }
  return result;
}

const LEVELS = ['all', 'beginner', 'intermediate', 'advanced', 'oral'];
const LEVEL_LABELS = { all: '全部难度', beginner: 'Level 1', intermediate: 'Level 2', advanced: 'Level 3' };
const ORAL_LEVEL_LABEL = { zh: '口语', en: 'Speaking', ja: '会話' };
const TAG_COLORS_BASE = ['#e3ffbb', '#ecf7ff', '#fffcda', '#fff0f6'];

// Tab labels for category modal
const CATEGORY_TAB_LABELS = {
  zh: { level: '难度', detail: '单词', oral: '短语' },
  en: { level: 'Level', detail: 'Words', oral: 'Phrases' },
  ja: { level: '難度', detail: '単語', oral: 'フレーズ' },
};

// Category cover images are auto-generated in src/data/categoryCovers.js
// from the "Cover For" column in update_data_folder/WordList.xlsx.

// Module-level cache for sentence translations (persists for session)
const _sentenceCache = new Map();

export default function LearningPage({
  isReview = false, onExitReview,
  nativeLang = 'zh', targetLang = 'en',
  // Per-user storage scope ('guest' or `u_${uid}`) — composed into storageKey
  // below so each account on the device has isolated progress / review-state
  // slots in localStorage.
  userScope = 'guest',
  selectedCategory = 'all', selectedLevel = 'beginner',
  onCategoryChange, onLevelChange,
  isVisible = true,
  contentHFromParent,
  onCategoryModalChange,
  // Called whenever a new word is presented (learn or review). Used by App
  // to track the 5-word/day guest login gate.
  onWordViewed,
  // Called BEFORE an answer/skip/Got-it click is processed. Returns false
  // when a guest is past today's word limit — App pops the gate modal and
  // we discard the click so the answer doesn't register and the current
  // word stays on screen behind the modal.
  requestNextWord,
  // Bumped by App after syncOnLogin merges cloud data into localStorage.
  // Triggers a re-read of `progress` so the top-right "已学" count reflects
  // words learned on another device without needing a tab switch / remount.
  refreshKey = 0,
}) {
  const posthog = usePostHog();
  const langKey = `${nativeLang}_${targetLang}`; // for session identity + sentence cache
  // Progress is now keyed by user-scope + target language so account A's
  // progress lives in a different localStorage slot than account B's.
  const storageKey = `${userScope}_${targetLang}`;
  const t = UI_TEXT[nativeLang] || UI_TEXT.zh;
  const isOralMode = selectedLevel === 'oral';
  const catLabels = isOralMode
    ? (ORAL_CATEGORY_LABELS[nativeLang] || ORAL_CATEGORY_LABELS.zh)
    : (CATEGORY_LABELS[nativeLang] || CATEGORY_LABELS.zh);
  const activeWords = isOralMode ? oralPhrases : words;
  const activeWordsShuffled = isOralMode ? oralPhrasesShuffled : wordsShuffled;
  const activeCategories = isOralMode ? oralCategories : categories;

  const [showCategories, _setShowCategories] = useState(false);
  const setShowCategories = useCallback((val) => {
    _setShowCategories(val);
    onCategoryModalChange?.(val);
  }, [onCategoryModalChange]);
  const [categoryTab, setCategoryTab] = useState('detail'); // 'detail' | 'oral' (level tab hidden)
  const [pendingCategory, setPendingCategory] = useState(selectedCategory);
  const [pendingLevel, setPendingLevel] = useState(selectedLevel);
  const selectedCatCardRef = useRef(null);
  const catScrollContainerRef = useRef(null);

  // Scroll the currently-selected category card into view *within the modal's
  // inner scroll container* when the modal opens. Using scrollIntoView scrolls
  // every scrollable ancestor (including the outer page), so we compute the
  // offset manually and only move the inner container.
  useLayoutEffect(() => {
    if (!showCategories) return;
    const container = catScrollContainerRef.current;
    const card = selectedCatCardRef.current;
    if (!container || !card) return;
    const cardRect = card.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const cardTopInContainer = (cardRect.top - containerRect.top) + container.scrollTop;
    const target = cardTopInContainer - (container.clientHeight - cardRect.height) / 2;
    container.scrollTop = Math.max(0, target);
  }, [showCategories, categoryTab]);

  // categoryReviewMode: true when the user enters a small category that is already
  // fully learned. The session then runs the *review queue* algorithm restricted to
  // that category — same rules as the global Review screen, but scoped.
  const [categoryReviewMode, setCategoryReviewMode] = useState(false);
  // effectiveIsReview drives queue/handler logic; the visual `isReview` prop still
  // controls the back button + review background, so categoryReviewMode keeps the
  // normal learning UI (including the category button to switch categories).
  const effectiveIsReview = isReview || categoryReviewMode;

  const [currentIndex, setCurrentIndex] = useState(0); // used only in review mode
  const [options, setOptions] = useState([]);
  const [imageOpts, setImageOpts] = useState([]); // word objects for format B
  const [selected, setSelected] = useState(null);
  const [isCorrect, setIsCorrect] = useState(null);
  const [wrongSelections, setWrongSelections] = useState(new Set());
  const [wrongImageIds, setWrongImageIds] = useState(new Set()); // for format B
  const [progress, setProgress] = useState(() => getProgress(storageKey));
  const [phonetic, setPhonetic] = useState('');
  const [showSentence, setShowSentence] = useState(false);
  const [sentenceTranslation, setSentenceTranslation] = useState('');
  const autoAdvanceTimer = useRef(null);
  const hasSpoken = useRef(false);
  const dModeResultRef = useRef(null); // 'know' | 'dontknow' — set by D-mode buttons before advanceToNext
  const containerRef = useRef(null);
  const [contentH, setContentH] = useState(() => contentHFromParent || 795);
  const [animKey, setAnimKey] = useState(null);
  const animTimerRef = useRef(null);

  const triggerAnim = useCallback((key) => {
    setAnimKey(key);
    if (animTimerRef.current) clearTimeout(animTimerRef.current);
    animTimerRef.current = setTimeout(() => setAnimKey(null), 460);
  }, []);

  // ── SRS Session State ──
  const [srsCard, setSrsCard] = useState(null); // current card from SRS queue
  const [sessionKey, setSessionKey] = useState(0); // increment to force session rebuild
  const [categoryDoneVisible, setCategoryDoneVisible] = useState(false);
  // Shown after one complete pass of a categoryReviewMode cycle (a small category
  // the user re-enters after already learning it). Same UI as categoryDoneVisible
  // but triggered from the review-queue end, not the SRS session end.
  const [categoryCycleDone, setCategoryCycleDone] = useState(false);
  const completedCatNameRef = useRef('');
  const baseQueueRef = useRef([]); // initial interleaved queue
  const baseIdxRef = useRef(0);   // how many consumed from base queue
  const pendingRef = useRef([]);   // scheduled session reviews [{word, step, format, dueAt}]
  const totalShownRef = useRef(0); // total cards shown in this session
  const sessionInitKey = useRef(''); // to detect when session should rebuild
  const sessionLoadingRef = useRef(false); // true while session is being (re)built — blocks category-done false-positive

  // ── Review Queue State ──
  const reviewQueueRef = useRef([]);       // [{word}] current cycle's queue
  const reviewPointerRef = useRef(0);      // current position in queue
  const reviewWordStatesRef = useRef({});  // wordId → {errorCount, sessionCorrect}
  const [reviewCard, setReviewCard] = useState(null); // {word, format}

  // Auto-redirect message shown in review when (a) the chosen category has no
  // learned words yet, or (b) the user finished a 2-round pass on a specific
  // category. After 1.5s we switch to "all" and let the queue rebuild.
  const [reviewRedirect, setReviewRedirect] = useState(null); // 'empty' | 'roundsDone' | null
  const reviewRedirectTimerRef = useRef(null);
  const triggerReviewRedirect = useCallback((kind) => {
    if (reviewRedirectTimerRef.current) clearTimeout(reviewRedirectTimerRef.current);
    setReviewCard(null);
    setReviewRedirect(kind);
    reviewRedirectTimerRef.current = setTimeout(() => {
      reviewRedirectTimerRef.current = null;
      setReviewRedirect(null);
      onCategoryChange?.('all');
    }, 1500);
  }, [onCategoryChange]);

  // Derived: quizFormat and currentWord — oral mode uses C/D (text only, no images)
  const rawFormat = effectiveIsReview ? (reviewCard?.format || 'B') : (srsCard?.format || 'A');
  const quizFormat = isOralMode ? (rawFormat === 'D' ? 'D' : 'C') : rawFormat;
  // Current step: 0 = first encounter (new), 1+ = session review
  const currentStep = effectiveIsReview ? null : (srsCard?.step ?? 0);

  // All words available for this language pair (for reviews & option generation)
  const allWordsFiltered = useMemo(() => {
    return activeWords.filter(w => isWordAvailable(w, nativeLang, targetLang));
  }, [nativeLang, targetLang, isOralMode]);

  // ── Review Queue Initialization & helpers ──
  const showNextReviewCard = useCallback((queue, pointer, wordStates) => {
    const word = queue[pointer];
    if (!word) { setReviewCard(null); return; }
    if (!wordStates[word.id]) wordStates[word.id] = { errorCount: 0, sessionCorrect: 0 };
    setReviewCard({ word, format: getReviewQuestionType(wordStates[word.id], isOralMode) });
  }, [isOralMode]);

  useEffect(() => {
    if (!effectiveIsReview) {
      setReviewCard(null);
      // Drop any stale redirect banner if we exited review.
      if (reviewRedirectTimerRef.current) {
        clearTimeout(reviewRedirectTimerRef.current);
        reviewRedirectTimerRef.current = null;
      }
      setReviewRedirect(null);
      return;
    }
    // A redirect is in-flight (e.g. the category change just triggered this re-run).
    // Skip rebuild — the upcoming category prop change will re-run this effect cleanly.
    if (reviewRedirect) return;
    const prog = getProgress(storageKey);
    // Restrict the review pool to the selected sub-category (and level, when applicable)
    // for both global review (isReview) and categoryReviewMode. The eligible filter
    // below still limits to learned, non-mastered words.
    let pool = allWordsFiltered;
    if (selectedCategory !== 'all') {
      pool = pool.filter(w => w.category === selectedCategory);
      if (selectedLevel !== 'all' && selectedLevel !== 'oral') {
        pool = pool.filter(w => w.level === selectedLevel);
      }
    }
    const eligible = pool.filter(w => prog[w.id]?.timestamp && !prog[w.id].mastered);
    if (eligible.length === 0) {
      // No learned words in this category → auto-redirect to "all".
      // For "all" itself, fall through to the existing all-done screen.
      if (selectedCategory !== 'all') {
        completedCatNameRef.current = catLabels[selectedCategory] || '';
        triggerReviewRedirect('empty');
        return;
      }
      setReviewCard(null);
      return;
    }
    // Load persisted word states so card types (B/C/A) and error weights survive re-entry.
    const savedStates = getReviewWordStates(storageKey);
    // Per-word "mastered for this cycle" threshold:
    //   normal categories: sessionCorrect >= 3 (B + C + D all passed)
    //   oral categories:   sessionCorrect >= 2 (C + D — oral has no images)
    const masteredThreshold = isOralMode ? 2 : 3;
    // categoryReviewMode fresh-start rule: if EVERY in-scope word already cleared
    // the threshold with no outstanding errors, zero those words out so the user
    // gets a fresh pass. Partial progress is preserved — that handles the
    // "exited mid-review, resume" case required by the spec.
    if (categoryReviewMode) {
      const allAlreadyMastered = eligible.every(w => {
        const s = savedStates[w.id];
        return s && s.sessionCorrect >= masteredThreshold && s.errorCount === 0;
      });
      if (allAlreadyMastered) {
        for (const w of eligible) savedStates[w.id] = { errorCount: 0, sessionCorrect: 0 };
        saveReviewWordStates(savedStates, storageKey);
      }
    }
    reviewWordStatesRef.current = savedStates;
    const queue = buildReviewQueueFromWords(eligible, prog, savedStates);
    reviewQueueRef.current = queue;
    reviewPointerRef.current = 0;
    showNextReviewCard(queue, 0, reviewWordStatesRef.current);
  }, [effectiveIsReview, categoryReviewMode, selectedCategory, selectedLevel, langKey, reviewRedirect]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cancel a pending redirect timer on unmount so it can't fire after we're gone.
  useEffect(() => () => {
    if (reviewRedirectTimerRef.current) clearTimeout(reviewRedirectTimerRef.current);
  }, []);

  // Speak function based on target language
  const speakCurrent = useCallback((text) => {
    speakWordByLang(stripRuby(text), targetLang);
  }, [targetLang]);

  // Measure container height for responsive layout.
  // Skip when offsetHeight is 0 — this page stays mounted while other tabs are
  // shown (display:none), and a resize during that time would otherwise zero out
  // contentH and lock the layout into ultra-compact mode after returning.
  useLayoutEffect(() => {
    const measure = () => {
      const h = containerRef.current?.offsetHeight;
      if (h && h > 0) setContentH(h);
    };
    measure();
    window.addEventListener('resize', measure);
    // Catch BFCache restores on mobile browsers — `resize` doesn't fire, but
    // the viewport (and our container) may have shrunk since the saved state
    // was taken, leaving contentH stale and the responsive scaling at full
    // size while the container is too short → choices overlap word info.
    window.addEventListener('pageshow', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('pageshow', measure);
    };
  }, []);

  // Re-measure whenever the page becomes visible again, in case the window was
  // resized while we were hidden (offsetHeight readings during display:none are 0
  // and get skipped above).
  useLayoutEffect(() => {
    if (!isVisible) return;
    const h = containerRef.current?.offsetHeight;
    if (h && h > 0) setContentH(h);
  }, [isVisible]);


  // ── Continuous responsive scaling (two-segment, matches Figma reference) ──
  // Full (FULL_H): image=100%, choices=100%
  // Short 1 (S1_H): image=70%, choices=88%  (Figma short screen 1)
  // Short 2 (MIN_H): image=65%, choices=80% (Figma short screen 2)
  const FULL_H = 776;
  const S1_H = 630;
  const MIN_H = 530;
  const ULTRA_H = 430; // ultra-compact: choices would overflow into nav

  const responsive2 = (v0, v1, v2) => {
    if (contentH >= FULL_H) return v0;
    if (contentH >= S1_H) {
      const t = (FULL_H - contentH) / (FULL_H - S1_H);
      return v0 + (v1 - v0) * t;
    }
    if (contentH <= MIN_H) return v2;
    const t = (S1_H - contentH) / (S1_H - MIN_H);
    return v1 + (v2 - v1) * t;
  };
  // Keep responsive as alias for two-point shorthand
  const responsive = (full, min) => responsive2(full, full + (min - full) * ((FULL_H - S1_H) / (FULL_H - MIN_H)), min);

  // Ultra-compact factor: 0 at MIN_H, 1 at ULTRA_H (for screens so short choices overlap nav)
  const ultraT = contentH < MIN_H ? Math.min(1, (MIN_H - contentH) / (MIN_H - ULTRA_H)) : 0;

  // Image: 100% → 70% → 65% → ~49% (more aggressive shrinking below MIN_H)
  const imgScale = responsive2(1.0, 0.70, 0.65) * (1 - 0.25 * ultraT);
  const imgSize = Math.round(270 * imgScale);
  const imgMarginTop = Math.round(responsive2(0, -25, -32));
  const imgPadTop = Math.max(10, Math.round(responsive2(12, 10, 10)));
  // Frame decoration scales proportionally with image (Figma node 181:610: photo 270×270 at (51,18), frame 357×314 at (10,-6) relative to pic-section)
  const frameTop = Math.round(-24 * imgScale);
  const frameLeft = Math.round(-41 * imgScale);
  const frameW = imgSize + Math.round(87 * imgScale);
  const frameH = imgSize + Math.round(44 * imgScale);
  // Review-mode plain hand-drawn frame (Figma node 181:564: photo 270×270 at (66,41), frame 275×277 at (64,38))
  const noDecorFrameTop = Math.round(-3 * imgScale);
  const noDecorFrameLeft = Math.round(-2 * imgScale);
  const noDecorFrameW = imgSize + Math.round(5 * imgScale);
  const noDecorFrameH = imgSize + Math.round(7 * imgScale);
  const imgRadius = Math.round(20 * imgScale);

  // Font sizes per Figma (node 181:609): word 24, phonetic 18, sentence 18, translation 16
  // CJK (zh/ja) text gets -2px for visual balance; scale at smaller screens
  const isCJK = (lang) => lang === 'zh' || lang === 'ja';
  const wordTextFS = Math.round(responsive2(22, 22, 19)) - (isCJK(targetLang) ? 2 : 0);
  const phoneticFS = Math.round(responsive2(18, 16, 13)) - (targetLang === 'ja' ? 2 : 0);
  const sentenceFS_base = Math.round(responsive2(18, 16, 13));
  const translationFS_base = Math.round(responsive2(16, 15, 11));


  // Choices: 100% → 88% → 80% → ~64% (more aggressive shrinking below MIN_H)
  const choiceScale = responsive2(1.0, 0.88, 0.80) * (1 - 0.20 * ultraT);
  // Choices padding-top: drops quickly from 26 to 10 once below MIN_H (reaches 10 within 30px)
  const choicesPadTop = contentH >= MIN_H ? 36 : Math.max(20, Math.round(36 - 16 * Math.min(1, (MIN_H - contentH) / 30)));
  // Natural (full-size) height of the choices section (Figma: card 109h, row gap 13, skip 91×88)
  const TEXT_CHOICES_H = 36 + 115 * 2 + 7 + 20;   // 293
  const IMG_CHOICES_H = 36 + 145 * 2 + 10 + 20;   // 356
  const skipTop_full = Math.round(36 + 115 + 7 / 2 - 85 / 2);
  const imgSkipTop_full = Math.round(36 + 145 + 10 / 2 - 85 / 2);

  // Decoration thresholds
  const showCatDecor = contentH >= 550;        // cat on choices (hide only on very short screens)
  const isCompact = contentH < FULL_H;
  const navLeftDecorW = Math.round(responsive2(83, 56, 49));

  // Reload progress when target language changes (storage key changed) OR
  // when App signals a sync-arrival via refreshKey. Without the refreshKey
  // dep, the cross-device cloud merge updates localStorage but this
  // component keeps showing the pre-merge `progress` snapshot — the
  // top-right "已学" count stays stale until a tab switch / remount.
  useEffect(() => {
    setProgress(getProgress(storageKey));
  }, [storageKey, refreshKey]);

  // Reset review index whenever either language changes
  useEffect(() => {
    setCurrentIndex(0);
  }, [langKey]);

  // Detect categoryReviewMode: true iff the user is currently inside a *specific*
  // sub-category whose words are all already learned. We snapshot at category-switch
  // time only (deps exclude `progress`) so finishing a word mid-session doesn't
  // abruptly flip the user from learning into review — that path goes through the
  // category-done popup + auto-switch to "all" instead.
  useEffect(() => {
    if (isReview) { setCategoryReviewMode(false); return; }
    if (selectedCategory === 'all') { setCategoryReviewMode(false); return; }
    const prog = getProgress(storageKey);
    let pool = activeWords.filter(w => isWordAvailable(w, nativeLang, targetLang) && w.category === selectedCategory);
    if (selectedLevel !== 'all' && selectedLevel !== 'oral') {
      pool = pool.filter(w => w.level === selectedLevel);
    }
    const fullyDone = pool.length > 0 && pool.every(w => prog[w.id]?.timestamp);
    setCategoryReviewMode(fullyDone);
  }, [isReview, selectedCategory, selectedLevel, isOralMode, nativeLang, targetLang, langKey, sessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Review mode: wordPool (unchanged) ──
  const wordPool = useMemo(() => {
    if (!isReview) return []; // not used in SRS mode
    const prog = progress;
    let pool = selectedCategory === 'all' ? activeWordsShuffled : activeWords.filter(w => w.category === selectedCategory);
    pool = pool.filter(w => isWordAvailable(w, nativeLang, targetLang));
    if (selectedLevel !== 'all' && selectedLevel !== 'oral') pool = pool.filter(w => w.level === selectedLevel);
    return shuffle(pool.filter(w => prog[w.id] && !prog[w.id].mastered));
  }, [selectedCategory, selectedLevel, progress, isReview, nativeLang, targetLang, isOralMode]);

  // ── Has the user ever learned ANY word in the current scope? ──
  // Used to differentiate "review complete" from "nothing to review yet": when
  // wordPool is empty AND the user has 0 learned entries here, we show a
  // friendlier go-learn-first prompt instead of the celebratory done state.
  const hasAnyLearnedInScope = useMemo(() => {
    if (!isReview) return true;
    const prog = progress;
    let pool = selectedCategory === 'all' ? activeWordsShuffled : activeWords.filter(w => w.category === selectedCategory);
    pool = pool.filter(w => isWordAvailable(w, nativeLang, targetLang));
    if (selectedLevel !== 'all' && selectedLevel !== 'oral') pool = pool.filter(w => w.level === selectedLevel);
    return pool.some(w => prog[w.id]);
  }, [selectedCategory, selectedLevel, progress, isReview, nativeLang, targetLang, isOralMode]);

  // ── SRS Session Initialization (learning mode only) ──
  const showNextCard = useCallback(() => {
    const total = totalShownRef.current;

    // 1. Pending session reviews that are due (B, C, C2) — oldest first
    const due = pendingRef.current
      .filter(r => r.dueAt <= total)
      .sort((a, b) => a.dueAt - b.dueAt);

    if (due.length > 0) {
      const next = due[0];
      pendingRef.current = pendingRef.current.filter(r => r !== next);
      setSrsCard({ word: next.word, format: next.format, type: 'sessionReview', step: next.step });
      return;
    }

    // 2. Next new word (or cross-session review) from base queue
    const idx = baseIdxRef.current;
    if (idx < baseQueueRef.current.length) {
      baseIdxRef.current = idx + 1;
      setSrsCard(baseQueueRef.current[idx]);
      return;
    }

    // 3. Base queue exhausted (all words in category learned) — drain remaining pending
    if (pendingRef.current.length > 0) {
      const earliest = [...pendingRef.current].sort((a, b) => a.dueAt - b.dueAt)[0];
      pendingRef.current = pendingRef.current.filter(r => r !== earliest);
      setSrsCard({ word: earliest.word, format: earliest.format, type: 'sessionReview', step: earliest.step });
      return;
    }

    // Session done — clear loading flag so the category-done popup is allowed to fire
    // eslint-disable-next-line no-console
    console.log('[SRS done]', {
      totalShown: totalShownRef.current,
      baseQueueLength: baseQueueRef.current.length,
      baseIdx: baseIdxRef.current,
      pendingLength: pendingRef.current.length,
    });
    sessionLoadingRef.current = false;
    setSrsCard(null);
  }, []);

  useEffect(() => {
    if (effectiveIsReview) {
      setSrsCard(null);
      sessionInitKey.current = ''; // invalidate so session rebuilds when user returns
      // Clear any stale SRS-done popup state — review has its own redirect path now,
      // and the categoryDone popup belongs to the learning flow.
      setCategoryDoneVisible(false);
      setCategoryCycleDone(false);
      return;
    }

    // storageKey is included so an account switch (different userScope, same
    // langs) forces a full SRS session rebuild — otherwise the in-memory
    // queue would keep showing the previous account's cards.
    const key = `${storageKey}_${langKey}_${selectedCategory}_${selectedLevel}_${sessionKey}`;
    const isInitializing = sessionInitKey.current !== key;
    // Signal to category-done effect: don't fire while we're (re)building the session
    sessionLoadingRef.current = isInitializing;
    // Don't rebuild if same key (prevents re-init on progress updates)
    if (!isInitializing) return;
    sessionInitKey.current = key;

    const prog = getProgress(storageKey);

    // Full pool for the currently selected subcategory (level OR detail OR oral cat).
    // New words and due-review words are BOTH drawn from here — reviews never cross
    // into other subcategories, so studying "adjectives" won't surface "animals" reviews.
    let subcatPool = selectedCategory === 'all'
      ? [...activeWords]
      : activeWords.filter(w => w.category === selectedCategory);
    subcatPool = subcatPool.filter(w => isWordAvailable(w, nativeLang, targetLang));
    if (selectedLevel !== 'all' && selectedLevel !== 'oral') subcatPool = subcatPool.filter(w => w.level === selectedLevel);

    // New words (not yet learned) within this subcategory
    let newPool = subcatPool.filter(w => !prog[w.id]?.timestamp);
    newPool = shuffle(newPool);

    // Due review words — restricted to this subcategory only
    const dueWords = getDueReviewWords(prog, subcatPool);
    const { reviewBudget } = calcBudget(dueWords.length);

    // Use ALL available new words — session continues until category is truly exhausted
    const reviewSlice = dueWords.slice(0, reviewBudget);

    const queue = buildInterleaved(newPool, reviewSlice, prog);

    // eslint-disable-next-line no-console
    console.log('[SRS init]', {
      category: selectedCategory,
      level: selectedLevel,
      subcatPoolSize: subcatPool.length,
      subcatPoolIds: subcatPool.map(w => w.id),
      newPoolIds: newPool.map(w => w.id),
      dueWordIds: dueWords.map(w => w.id),
      reviewBudget,
      queue: queue.map(c => `${c.word.id}(${c.type}/${c.format})`),
      progressSnapshot: Object.fromEntries(
        subcatPool.map(w => [w.id, {
          timestamp: !!prog[w.id]?.timestamp,
          mastered: !!prog[w.id]?.mastered,
          srsLevel: prog[w.id]?.srsLevel,
          nextReviewAt: prog[w.id]?.nextReviewAt,
        }])
      ),
    });

    baseQueueRef.current = queue;
    baseIdxRef.current = 0;
    pendingRef.current = [];
    totalShownRef.current = 0;

    // Show first card
    if (queue.length > 0) {
      baseIdxRef.current = 1;
      setSrsCard(queue[0]);
    } else {
      setSrsCard(null);
    }
  }, [effectiveIsReview, storageKey, langKey, selectedCategory, selectedLevel, nativeLang, targetLang, allWordsFiltered, showNextCard, sessionKey]);

  // Force rebuild SRS session when category/level confirmed
  const resetSrsSession = useCallback(() => {
    sessionInitKey.current = ''; // force rebuild on next effect run
    setSessionKey(k => k + 1);
  }, []);

  // ── Category-done detection (SRS learning path) ──
  // Fires when the SRS session runs out of cards but more words exist globally.
  // Shows a popup with 2 actions ("重新复习" vs "学习新的") — no auto-switch.
  useEffect(() => {
    if (effectiveIsReview || srsCard !== null || !isVisible || sessionLoadingRef.current) return;

    const prog = getProgress(storageKey);
    const unlearned = allWordsFiltered.filter(w => !prog[w.id]?.timestamp);
    if (unlearned.length === 0) return; // truly all done — show the all-done screen

    completedCatNameRef.current = catLabels[selectedCategory] || '';
    setCategoryDoneVisible(true);
  }, [srsCard, effectiveIsReview, isVisible, langKey, allWordsFiltered, nativeLang, selectedCategory, selectedLevel]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Unified currentWord ──
  const currentWord = effectiveIsReview ? (reviewCard?.word || null) : (srsCard?.word || null);
  const displayWord = currentWord ? getWordText(currentWord, targetLang) : '';

  const displaySentence = useMemo(() => {
    if (!currentWord) return '';
    // Oral phrases: use sentenceZh when target is Chinese
    if (currentWord.sentenceZh && targetLang === 'zh') return currentWord.sentenceZh;
    const sentence = getSentence(currentWord, targetLang);
    if (!sentence && targetLang === 'zh') return currentWord.sentence || '';
    return sentence;
  }, [currentWord, targetLang]);

  const sentenceLang = useMemo(() => {
    if (!currentWord) return targetLang;
    // Oral phrases: sentenceZh is Chinese
    if (currentWord.sentenceZh && targetLang === 'zh') return 'zh';
    const sentence = getSentence(currentWord, targetLang);
    if (!sentence && targetLang === 'zh') return 'en';
    return targetLang;
  }, [currentWord, targetLang]);

  const sameCategoryWords = useMemo(() => {
    if (!currentWord) return activeWords;
    const base = activeWords.filter(w => w.category === currentWord.category);
    return base.filter(w => isWordAvailable(w, nativeLang, targetLang));
  }, [currentWord, nativeLang, targetLang, isOralMode]);

  const tagColorMap = useMemo(() => {
    const cats = activeCategories.filter(c => c !== 'all');
    const map = {};
    cats.forEach((cat, idx) => {
      const gridPos = idx + 1;
      const gridCol = gridPos % 4;
      const gridRow = Math.floor(gridPos / 4);
      map[cat] = TAG_COLORS_BASE[(gridCol + gridRow) % TAG_COLORS_BASE.length];
    });
    return map;
  }, [isOralMode]);

  // ── Generate options when word or format changes ──
  useEffect(() => {
    if (!currentWord) return;
    const pool = sameCategoryWords.length >= 4 ? sameCategoryWords : allWordsFiltered;

    if (quizFormat === 'D') {
      // D mode: no options needed — just know/don't-know buttons
      setOptions([]);
      setImageOpts([]);
    } else if (quizFormat === 'B') {
      setImageOpts(getImageOptions(currentWord, pool));
      setOptions([]);
    } else {
      setOptions(getOptions(currentWord, pool, nativeLang));
      setImageOpts([]);
    }
    setSelected(null);
    setIsCorrect(null);
    setWrongSelections(new Set());
    setWrongImageIds(new Set());
    setShowSentence(false);
    hasSpoken.current = false;
    dModeResultRef.current = null;
    // srsCard/reviewCard refs change even when same word re-appears — required so
    // state resets when a word cycles back (e.g. cycle rebuild → Monday again).
  }, [currentWord?.id, quizFormat, srsCard, reviewCard]);

  // Phonetics
  useEffect(() => {
    if (!currentWord) { setPhonetic(''); return; }
    const staticPhonetic = getPhonetic(currentWord, targetLang);
    if (staticPhonetic !== null) { setPhonetic(staticPhonetic); return; }
    setPhonetic('');
    if (isOralMode) return; // no API fallback for phrases
    let cancelled = false;
    const parts = currentWord.en.split(/\s+/).map(w => w.toLowerCase().replace(/[^a-z]/g, '')).filter(Boolean);
    (async () => {
      for (const w of parts) {
        try {
          const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${w}`);
          if (!res.ok) continue;
          const data = await res.json();
          if (!Array.isArray(data)) continue;
          const p = data[0]?.phonetic || data[0]?.phonetics?.find(ph => ph.text)?.text || '';
          if (p && !cancelled) { setPhonetic(p); return; }
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [currentWord?.id, targetLang, isOralMode]);

  // Sentence translation — translate to whichever language differs from sentenceLang
  const translationLang = sentenceLang !== nativeLang ? nativeLang : targetLang;
  const needsTranslation = sentenceLang !== translationLang;

  useEffect(() => {
    if (!currentWord || !displaySentence || !needsTranslation) { setSentenceTranslation(''); return; }
    // Use pre-loaded translations: Chinese, English, Japanese sentences are all in word data
    if (translationLang === 'zh' && currentWord.sentenceZh) {
      setSentenceTranslation(currentWord.sentenceZh);
      return;
    }
    if (translationLang === 'en' && currentWord.sentence) {
      setSentenceTranslation(currentWord.sentence);
      return;
    }
    if (translationLang === 'ja') {
      const jaSentence = currentWord.jaSentence || jaData[currentWord.en]?.sentence;
      if (jaSentence) { setSentenceTranslation(jaSentence); return; }
    }
    // Fallback to API for any missing translations
    const cacheKey = `${currentWord.id}_${langKey}`;
    if (_sentenceCache.has(cacheKey)) { setSentenceTranslation(_sentenceCache.get(cacheKey)); return; }
    setSentenceTranslation('');
    const langpair = getTranslationPair(sentenceLang, translationLang);
    let cancelled = false;
    fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(displaySentence)}&langpair=${langpair}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const tt = data?.responseData?.translatedText;
        if (tt && tt !== displaySentence && !cancelled) {
          _sentenceCache.set(cacheKey, tt);
          setSentenceTranslation(tt);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentWord?.id, langKey, displaySentence, sentenceLang, translationLang, needsTranslation]);

  // Notify the parent that a new word is being presented so it can enforce
  // the guest daily login gate. Fires only when the *word id* changes — we
  // deliberately exclude `onWordViewed` from the deps so that re-renders in
  // the parent (e.g. closing the gate modal) don't re-fire this effect with
  // the same word and immediately re-trigger the gate.
  useEffect(() => {
    if (currentWord?.id) onWordViewed?.(currentWord.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWord?.id]);

  // Auto-speak on word change — always reset hasSpoken first, then speak only if tab is visible
  // reviewCard is included so the effect re-fires when the same word reappears (re-inserted after wrong answer)
  useLayoutEffect(() => {
    hasSpoken.current = false; // reset for every new word, regardless of visibility
    if (currentWord && isVisible) {
      hasSpoken.current = true;
      speakCurrent(displayWord);
    }
  }, [currentWord?.id, reviewCard]); // eslint-disable-line react-hooks/exhaustive-deps

  // Speak the current word in two cases that the layoutEffect above misses:
  //   1) Tab restored to learn — isVisible flips false → true.
  //   2) Fresh mount after login — isVisible was true at mount but the SRS
  //      session settled on its first card AFTER the layoutEffect ran (it
  //      saw currentWord=null and bailed out without speaking). Including
  //      currentWord?.id in the deps catches the late-arriving first word.
  useEffect(() => {
    if (isVisible && currentWord && !hasSpoken.current) {
      hasSpoken.current = true;
      speakCurrent(displayWord);
    }
  }, [isVisible, currentWord?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { if (autoAdvanceTimer.current) clearTimeout(autoAdvanceTimer.current); };
  }, []);

  useEffect(() => {
    setCurrentIndex(0);
  }, [isReview]);

  // ── Advance logic ──
  const advanceToNext = useCallback(() => {
    if (effectiveIsReview) {
      const card = reviewCard;
      if (!card) return;
      // D-mode (know/don't-know) replaces the wrongSelections signal:
      // "认识" = right, "不认识" = wrong. Reset the ref so the next card starts clean.
      const isDMode = card.format === 'D';
      const dResult = dModeResultRef.current;
      const hadWrong = isDMode
        ? dResult === 'dontknow'
        : (wrongSelections.size > 0 || wrongImageIds.size > 0);
      if (isDMode) dModeResultRef.current = null;
      const wordId = card.word.id;
      const state = reviewWordStatesRef.current[wordId] || { errorCount: 0, sessionCorrect: 0 };

      let newState;
      if (hadWrong) {
        newState = { errorCount: state.errorCount + 1, sessionCorrect: state.sessionCorrect };
        // Re-insert word at current pointer + gap based on cumulative error count
        const gap = newState.errorCount <= 1 ? 6 : newState.errorCount === 2 ? 4 : 2;
        // Insert gap cards after the NEXT card (pointer+1), not after the current one.
        // No clamping — splice auto-appends if insertAt > queue.length.
        const insertAt = reviewPointerRef.current + 1 + gap;
        reviewQueueRef.current.splice(insertAt, 0, card.word);
      } else {
        newState = { errorCount: Math.max(0, state.errorCount - 1), sessionCorrect: state.sessionCorrect + 1 };
      }
      reviewWordStatesRef.current[wordId] = newState;
      // Persist states so card types (B/C/A) and error counts survive tab switches & re-entry
      saveReviewWordStates(reviewWordStatesRef.current, storageKey);

      reviewPointerRef.current++;

      // If cycle exhausted, decide whether to continue (rebuild queue) or finish.
      // · specific-category review → finish once every in-scope word is review-mastered
      //   (errorCount === 0 and sessionCorrect >= threshold). Threshold is 3 in normal
      //   mode (B → C → D each passed once) or 2 in oral mode (C → D — no images).
      // · global ('all') review → rebuild indefinitely, user exits manually.
      if (reviewPointerRef.current >= reviewQueueRef.current.length) {
        const prog = getProgress(storageKey);
        let basePool = allWordsFiltered;
        if (selectedCategory !== 'all') {
          basePool = basePool.filter(w => w.category === selectedCategory);
          if (selectedLevel !== 'all' && selectedLevel !== 'oral') {
            basePool = basePool.filter(w => w.level === selectedLevel);
          }
        }
        const eligible = basePool.filter(w => prog[w.id]?.timestamp && !prog[w.id].mastered);
        if (eligible.length === 0) {
          if (selectedCategory !== 'all') {
            completedCatNameRef.current = catLabels[selectedCategory] || '';
            triggerReviewRedirect('empty');
            return;
          }
          setReviewCard(null);
          return;
        }

        if (selectedCategory !== 'all') {
          const masteredThreshold = isOralMode ? 2 : 3;
          const allMastered = eligible.every(w => {
            const s = reviewWordStatesRef.current[w.id];
            return s && s.sessionCorrect >= masteredThreshold && s.errorCount === 0;
          });
          if (allMastered) {
            completedCatNameRef.current = catLabels[selectedCategory] || '';
            triggerReviewRedirect('roundsDone');
            return;
          }
        }

        const queue = buildReviewQueueFromWords(eligible, prog, reviewWordStatesRef.current);
        reviewQueueRef.current = queue;
        reviewPointerRef.current = 0;
        // Word states intentionally NOT reset — type (B→C→A) and error weight carries over
      }

      showNextReviewCard(reviewQueueRef.current, reviewPointerRef.current, reviewWordStatesRef.current);
      return;
    }

    // SRS mode: handle scheduling and advance
    const card = srsCard;
    if (!card) return;

    const hadWrong = wrongSelections.size > 0 || wrongImageIds.size > 0;
    const now = Date.now();

    if (card.type === 'new') {
      // Just learned a new word → schedule B review
      markWordLearned(card.word.id, storageKey);
      updateWordSRS(card.word.id, { srsLevel: 0, lastReviewedAt: now }, storageKey);

      pendingRef.current.push({
        word: card.word,
        step: 1,
        format: SESSION_FORMATS[1], // 'B'
        dueAt: totalShownRef.current + SESSION_GAPS[1], // +5
      });

    } else if (card.type === 'sessionReview') {
      const step = card.step;
      const isDMode = card.format === 'D';
      const dResult = dModeResultRef.current; // 'know' | 'dontknow'

      if (isDMode) {
        // D mode (step 3): self-assessment — no wrong/right, just know/don't-know
        dModeResultRef.current = null; // reset
        if (dResult === 'know') {
          // 认识: graduate to cross-session level 4, word still comes back but less frequently
          updateWordSRS(card.word.id, {
            srsLevel: 4,
            nextReviewAt: now + getInterval(4),
            lastReviewedAt: now,
          }, storageKey);
        } else {
          // 不认识: reschedule as B (image quiz) so user re-learns the word
          const gap = SESSION_GAPS[1]; // B's gap = 5
          pendingRef.current.push({
            word: card.word,
            step: 1,
            format: 'B',
            dueAt: totalShownRef.current + gap,
          });
          updateWordSRS(card.word.id, { srsLevel: Math.max(step - 1, 0), lastReviewedAt: now }, storageKey);
        }
      } else if (hadWrong) {
        // Struggled: reschedule same step at half gap
        const gap = Math.max(3, Math.floor(SESSION_GAPS[step] / 2));
        pendingRef.current.push({
          word: card.word,
          step,
          format: SESSION_FORMATS[step],
          dueAt: totalShownRef.current + gap,
        });
        updateWordSRS(card.word.id, { srsLevel: Math.max(step - 1, 0), lastReviewedAt: now }, storageKey);
      } else {
        if (step < 3) {
          // Schedule next step — oral mode skips step 2 (C→C→D instead of A→B→C→D)
          const nextStep = (isOralMode && step === 1) ? 3 : step + 1;
          const nextFormat = isOralMode ? (nextStep === 3 ? 'D' : 'C') : SESSION_FORMATS[nextStep];
          pendingRef.current.push({
            word: card.word,
            step: nextStep,
            format: nextFormat,
            dueAt: totalShownRef.current + SESSION_GAPS[nextStep],
          });
          updateWordSRS(card.word.id, { srsLevel: step, lastReviewedAt: now }, storageKey);
        } else {
          // Step 3 complete (non-D format, shouldn't normally happen) → graduate
          updateWordSRS(card.word.id, {
            srsLevel: 4,
            nextReviewAt: now + getInterval(4),
            lastReviewedAt: now,
          }, storageKey);
        }
      }

    } else if (card.type === 'review') {
      // Cross-session review
      const prog = getProgress(storageKey);
      const p = prog[card.word.id] || {};
      const currentLevel = p.srsLevel ?? 4;

      if (hadWrong) {
        // Demote
        let newLevel;
        if (currentLevel <= 7) newLevel = 4;
        else if (currentLevel <= 11) newLevel = 7;
        else newLevel = 9;
        updateWordSRS(card.word.id, {
          srsLevel: newLevel,
          nextReviewAt: now + getInterval(newLevel),
          lastReviewedAt: now,
        }, storageKey);
      } else {
        // Level up
        const newLevel = Math.min(currentLevel + 1, 14);
        updateWordSRS(card.word.id, {
          srsLevel: newLevel,
          nextReviewAt: now + getInterval(newLevel),
          lastReviewedAt: now,
          inPool: newLevel >= 12,
        }, storageKey);
      }
    }

    totalShownRef.current++;
    setProgress(getProgress(storageKey));
    showNextCard();
  }, [effectiveIsReview, storageKey, srsCard, wrongSelections, wrongImageIds, showNextCard, reviewCard, allWordsFiltered, showNextReviewCard]);

  // ── Click handlers ──
  const handleOptionClick = useCallback((option) => {
    if (isCorrect) return;
    // Guest past today's limit: pop the gate, drop the click. The current
    // word stays visible behind the modal — no answer registers, no advance.
    if (requestNextWord && requestNextWord() === false) return;
    triggerAnim(option);
    const correctAnswer = getWordText(currentWord, nativeLang);
    if (option === correctAnswer) {
      posthog?.capture('word_answered', { correct: true, word: currentWord?.en, mode: 'choice', is_review: effectiveIsReview, native_lang: nativeLang, target_lang: targetLang });
      setSelected(option);
      setIsCorrect(true);
      playCorrectSound();
      // Persist the "learned" mark now so a tab switch during the 800ms advance
      // delay sees this word in storage (wordlist counter otherwise stays at 0).
      if (!effectiveIsReview && srsCard?.type === 'new') {
        markWordLearned(srsCard.word.id, storageKey);
      }
      autoAdvanceTimer.current = setTimeout(advanceToNext, 800);
    } else {
      posthog?.capture('word_answered', { correct: false, word: currentWord?.en, mode: 'choice', is_review: effectiveIsReview, native_lang: nativeLang, target_lang: targetLang });
      setSelected(option);
      setIsCorrect(false);
      playWrongSound();
      setWrongSelections(prev => new Set([...prev, option]));
      setShowSentence(true); // auto-reveal translation on wrong answer
    }
  }, [currentWord, isCorrect, advanceToNext, nativeLang, targetLang, effectiveIsReview, triggerAnim, posthog, srsCard, storageKey]);

  const handleImageClick = useCallback((optWord) => {
    if (isCorrect) return;
    if (requestNextWord && requestNextWord() === false) return;
    triggerAnim(`img-${optWord.id}`);
    if (optWord.id === currentWord.id) {
      posthog?.capture('word_answered', { correct: true, word: currentWord?.en, mode: 'image', is_review: effectiveIsReview, native_lang: nativeLang, target_lang: targetLang });
      setIsCorrect(true);
      playCorrectSound();
      if (!effectiveIsReview && srsCard?.type === 'new') {
        markWordLearned(srsCard.word.id, storageKey);
      }
      autoAdvanceTimer.current = setTimeout(advanceToNext, 800);
    } else {
      posthog?.capture('word_answered', { correct: false, word: currentWord?.en, mode: 'image', is_review: effectiveIsReview, native_lang: nativeLang, target_lang: targetLang });
      setIsCorrect(false);
      playWrongSound();
      setWrongImageIds(prev => new Set([...prev, optWord.id]));
      setShowSentence(true); // auto-reveal translation on wrong answer
    }
  }, [currentWord, isCorrect, advanceToNext, nativeLang, targetLang, effectiveIsReview, triggerAnim, posthog, srsCard, storageKey]);

  // ── D mode handlers ──
  const handleDKnow = useCallback(() => {
    if (!currentWord) return;
    if (requestNextWord && requestNextWord() === false) return;
    posthog?.capture('word_answered', { correct: true, word: currentWord?.en, mode: 'recall', is_review: effectiveIsReview, native_lang: nativeLang, target_lang: targetLang });
    triggerAnim('dKnow');
    playCorrectSound();
    dModeResultRef.current = 'know';
    autoAdvanceTimer.current = setTimeout(advanceToNext, 600);
  }, [currentWord, advanceToNext, nativeLang, targetLang, effectiveIsReview, triggerAnim, posthog]);

  const handleDDontKnow = useCallback(() => {
    if (!currentWord) return;
    if (requestNextWord && requestNextWord() === false) return;
    posthog?.capture('word_answered', { correct: false, word: currentWord?.en, mode: 'recall', is_review: effectiveIsReview, native_lang: nativeLang, target_lang: targetLang });
    triggerAnim('dDontKnow');
    playWrongSound();
    dModeResultRef.current = 'dontknow';
    // Show the answer briefly: reveal the sentence translation, then advance
    setShowSentence(true);
    autoAdvanceTimer.current = setTimeout(advanceToNext, 1200);
  }, [currentWord, advanceToNext, nativeLang, targetLang, effectiveIsReview, triggerAnim, posthog]);

  const handleSpeak = useCallback(() => {
    if (currentWord) speakCurrent(displayWord);
  }, [currentWord, displayWord, speakCurrent]);


  const handleSkip = useCallback(() => {
    if (!currentWord) return;
    if (requestNextWord && requestNextWord() === false) return;
    posthog?.capture('word_skipped', { word: currentWord?.en, is_review: effectiveIsReview, native_lang: nativeLang, target_lang: targetLang });
    triggerAnim('skip');
    if (autoAdvanceTimer.current) clearTimeout(autoAdvanceTimer.current);
    playSlaySound();
    if (!effectiveIsReview) markWordLearned(currentWord.id, storageKey);
    toggleMastered(currentWord.id, true, storageKey);
    if (effectiveIsReview) {
      const skippedId = currentWord.id;
      // Remove all occurrences of this word from the review queue
      reviewQueueRef.current = reviewQueueRef.current.filter((w, idx) => idx < reviewPointerRef.current || w.id !== skippedId);
      delete reviewWordStatesRef.current[skippedId];
      setTimeout(() => {
        const prog = getProgress(storageKey);
        // Pool scope: stay within the selected sub-category for both global review (isReview)
        // and categoryReviewMode. The eligible filter below limits to learned, non-mastered.
        let basePool = allWordsFiltered;
        if (selectedCategory !== 'all') {
          basePool = basePool.filter(w => w.category === selectedCategory);
          if (selectedLevel !== 'all' && selectedLevel !== 'oral') basePool = basePool.filter(w => w.level === selectedLevel);
        }
        const eligible = basePool.filter(w => prog[w.id]?.timestamp && !prog[w.id].mastered);
        if (eligible.length === 0) {
          if (selectedCategory !== 'all') {
            completedCatNameRef.current = catLabels[selectedCategory] || '';
            triggerReviewRedirect('empty');
            setProgress(prog);
            return;
          }
          setReviewCard(null);
          return;
        }
        if (reviewPointerRef.current >= reviewQueueRef.current.length) {
          if (selectedCategory !== 'all') {
            const masteredThreshold = isOralMode ? 2 : 3;
            const allMastered = eligible.every(w => {
              const s = reviewWordStatesRef.current[w.id];
              return s && s.sessionCorrect >= masteredThreshold && s.errorCount === 0;
            });
            if (allMastered) {
              completedCatNameRef.current = catLabels[selectedCategory] || '';
              triggerReviewRedirect('roundsDone');
              setProgress(prog);
              return;
            }
          }
          const queue = buildReviewQueueFromWords(eligible, prog, reviewWordStatesRef.current);
          reviewQueueRef.current = queue;
          reviewPointerRef.current = 0;
          // Word states kept across cycles
        }
        showNextReviewCard(reviewQueueRef.current, reviewPointerRef.current, reviewWordStatesRef.current);
        setProgress(prog);
      }, 400);
    } else {
      // In SRS mode, also remove any pending reviews for this word
      pendingRef.current = pendingRef.current.filter(r => r.word.id !== currentWord.id);
      totalShownRef.current++;
      setTimeout(() => {
        setProgress(getProgress(storageKey));
        showNextCard();
      }, 400);
    }
  }, [currentWord, effectiveIsReview, storageKey, nativeLang, targetLang, posthog, showNextCard, triggerAnim, allWordsFiltered, showNextReviewCard]);

  // Counter text
  const counterText = useMemo(() => {
    if (effectiveIsReview) {
      // Denominator: unique words in the review queue (constant across wrong-answer re-inserts,
      // because splice inserts the SAME word object so its id is already in the set).
      // Numerator: unique words the user has already moved past at least once.
      const queue = reviewQueueRef.current;
      const pointer = reviewPointerRef.current;
      if (queue.length === 0) return '0/0';
      const totalIds = new Set();
      for (const w of queue) totalIds.add(w.id);
      const pastIds = new Set();
      for (let i = 0; i < pointer; i++) pastIds.add(queue[i].id);
      return `${pastIds.size}/${totalIds.size}`;
    }
    // SRS mode: learned/total in current category+level filter
    let pool = selectedCategory === 'all' ? [...activeWords] : activeWords.filter(w => w.category === selectedCategory);
    pool = pool.filter(w => isWordAvailable(w, nativeLang, targetLang));
    if (selectedLevel !== 'all' && selectedLevel !== 'oral') pool = pool.filter(w => w.level === selectedLevel);
    const total = pool.length;
    const learned = pool.filter(w => progress[w.id]?.timestamp).length;
    return `${learned}/${total}`;
  }, [effectiveIsReview, reviewCard, currentWord, selectedCategory, selectedLevel, nativeLang, targetLang, progress]);

  const handleOpenCategories = useCallback(() => {
    setPendingCategory(selectedCategory);
    setPendingLevel(selectedLevel);
    // Set initial tab based on current mode (level tab hidden, default to detail)
    if (selectedLevel === 'oral') {
      setCategoryTab('oral');
    } else {
      setCategoryTab('detail');
    }
    setShowCategories(true);
  }, [selectedCategory, selectedLevel]);

  const handleConfirmCategories = useCallback(() => {
    window.speechSynthesis.cancel();
    setCategoryDoneVisible(false);
    setCategoryCycleDone(false);
    onCategoryChange?.(pendingCategory);
    onLevelChange?.(pendingLevel);
    setCurrentIndex(0);
    resetSrsSession();
    setShowCategories(false);
  }, [pendingCategory, pendingLevel, onCategoryChange, onLevelChange, resetSrsSession]);

  // ── Category-done popup button handlers ──
  // "Review Again": stay on the current category/level, switch into categoryReviewMode
  // (which replays the finished list with B/C question-type cycling). In SRS-done
  // state this activates review mode; in cycle-done state it rebuilds the queue.
  const handleReviewAgain = useCallback(() => {
    setCategoryDoneVisible(false);
    setCategoryCycleDone(false);
    setCategoryReviewMode(true);

    // Rebuild the review queue immediately so the next render already has a card
    const prog = getProgress(storageKey);
    let pool = allWordsFiltered;
    if (selectedCategory !== 'all') {
      pool = pool.filter(w => w.category === selectedCategory);
      if (selectedLevel !== 'all' && selectedLevel !== 'oral') {
        pool = pool.filter(w => w.level === selectedLevel);
      }
    }
    const eligible = pool.filter(w => prog[w.id]?.timestamp && !prog[w.id].mastered);
    if (eligible.length === 0) { setReviewCard(null); return; }

    // "重新复习" = explicit fresh cycle. Zero out the review states for in-scope words
    // so each one enters in B format and must pass through B → C again to finish.
    const savedStates = getReviewWordStates(storageKey);
    for (const w of eligible) savedStates[w.id] = { errorCount: 0, sessionCorrect: 0 };
    saveReviewWordStates(savedStates, storageKey);
    reviewWordStatesRef.current = savedStates;
    const queue = buildReviewQueueFromWords(eligible, prog, savedStates);
    reviewQueueRef.current = queue;
    reviewPointerRef.current = 0;
    showNextReviewCard(queue, 0, savedStates);
    setProgress(prog);
  }, [allWordsFiltered, selectedCategory, selectedLevel, storageKey, showNextReviewCard]);

  // "Learn New": exit review mode for this category and jump to the "All" category,
  // so the SRS engine pulls the next batch of unlearned words from anywhere.
  const handleLearnNew = useCallback(() => {
    setCategoryDoneVisible(false);
    setCategoryCycleDone(false);
    setCategoryReviewMode(false);
    const progNow = getProgress(storageKey);
    const hasUnlearnedAtLevel = selectedLevel === 'all' || selectedLevel === 'oral'
      ? allWordsFiltered.some(w => !progNow[w.id]?.timestamp)
      : allWordsFiltered.some(w => w.level === selectedLevel && !progNow[w.id]?.timestamp);
    onCategoryChange?.('all');
    onLevelChange?.(hasUnlearnedAtLevel ? selectedLevel : 'all');
    resetSrsSession();
  }, [allWordsFiltered, selectedLevel, storageKey, onCategoryChange, onLevelChange, resetSrsSession]);

  // Font for target language
  const targetFont = getFontFamily(targetLang);
  const isTargetJa = targetLang === 'ja';

  const levelDisplayText = pendingLevel === 'all'
    ? t.allLevels
    : pendingLevel === 'oral'
      ? (ORAL_LEVEL_LABEL[nativeLang] || ORAL_LEVEL_LABEL.zh)
      : `${t.levelPrefix}: ${LEVEL_LABELS[pendingLevel]}`;

  // ── Auto-redirect banner (review only) ──
  // Shown for 1.5s when the user is in review on a specific category and either
  // (a) the category has no learned words yet, or (b) the 2-round pass finished.
  // After the timer fires we switch to "all" and let the queue rebuild.
  if (!currentWord && reviewRedirect && effectiveIsReview) {
    const headline = reviewRedirect === 'empty' ? t.reviewEmptyCategory : t.reviewRoundsDone;
    return (
      <div className="relative flex flex-col h-full">
        <img
          src={getFigmaAssetUrl(isReview ? 'vocablist-study-background.jpg' : 'study_background.jpg')}
          alt=""
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          style={{ zIndex: 0 }}
        />
        <div className="relative flex flex-col h-full" style={{ zIndex: 2 }}>
          <div className="shrink-0 relative flex items-center justify-between px-5" style={{ height: 45, paddingTop: 16, zIndex: 10 }}>
            {isReview ? (
              <button onClick={onExitReview} className="w-[27px] h-[27px] flex items-center justify-center active:scale-90">
                <img src={getFigmaAssetUrl('back-button.png')} alt="返回" className="w-full h-full object-contain" />
              </button>
            ) : (
              <button data-testid="learn-category-btn" onClick={handleOpenCategories} className="w-[30px] h-[30px] active:scale-90">
                <img src={getFigmaAssetUrl('category-btn.png')} alt="分类" className="w-full h-full object-contain" />
              </button>
            )}
          </div>
          <div className="flex-1 flex items-center justify-center px-6">
            <div className="bg-white rounded-2xl px-7 py-7 shadow-xl flex flex-col items-center text-center"
              style={{ border: '2px solid #000', maxWidth: 320 }}>
              <div className="text-4xl mb-3">{reviewRedirect === 'empty' ? '📚' : '🎉'}</div>
              <div className="text-base font-extrabold text-textMain mb-1">
                {completedCatNameRef.current ? `「${completedCatNameRef.current}」` : ''}{headline}
              </div>
              <div className="text-textSub text-sm mt-2">{t.reviewSwitchingToAll}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Category done popup (more words exist in other categories) ──
  // Fires from TWO sources: SRS session exhausted (categoryDoneVisible) or
  // review cycle finished (categoryCycleDone). Preserves the outer learning
  // layout (background, decorations, top bar with category button & counter) —
  // only the word-card + choices area is replaced by the popup card.
  if (!currentWord && (categoryDoneVisible || categoryCycleDone)) {
    return (
      <div className="relative flex flex-col h-full">
        {/* ── BACKGROUND ── */}
        <img
          src={getFigmaAssetUrl(isReview ? 'vocablist-study-background.jpg' : 'study_background.jpg')}
          alt=""
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          style={{ zIndex: 0 }}
        />

        {/* ── DECORATIVE OVERLAYS (normal mode only) ── */}
        {!isReview && (
          <>
            <img src={getFigmaAssetUrl('nav-decor-top-1.png')} alt=""
              className="absolute pointer-events-none select-none"
              style={{ left: 0, bottom: -4, width: navLeftDecorW, zIndex: 3 }} />
            <img src={getFigmaAssetUrl('nav-decor-top-2.png')} alt=""
              className="absolute pointer-events-none select-none"
              style={{ right: 8, bottom: -4, width: 37, zIndex: 3 }} />
            <img src={getFigmaAssetUrl('nav-decor-3.png')} alt=""
              className="absolute pointer-events-none select-none"
              style={{ left: 105, bottom: -17, width: 37, zIndex: 3 }} />
          </>
        )}

        {/* ── CONTENT ── */}
        <div className="relative flex flex-col h-full" style={{ zIndex: 2 }}>
          {/* ── TOP BAR (same as learning page) ── */}
          <div className="shrink-0 relative flex items-center justify-between px-5" style={{ height: 45, paddingTop: 16, zIndex: 10 }}>
            {isReview ? (
              <button onClick={onExitReview} className="w-[27px] h-[27px] flex items-center justify-center active:scale-90">
                <img src={getFigmaAssetUrl('back-button.png')} alt="返回" className="w-full h-full object-contain" />
              </button>
            ) : (
              <button data-testid="learn-category-btn" onClick={handleOpenCategories} className="w-[30px] h-[30px] active:scale-90">
                <img src={getFigmaAssetUrl('category-btn.png')} alt="分类" className="w-full h-full object-contain" />
              </button>
            )}
            <span className="text-[14px] text-[#999]">{counterText}</span>
          </div>

          {/* ── POPUP in the card area ── */}
          <div className="flex-1 flex items-center justify-center px-6">
            <div className="bg-white rounded-2xl px-8 py-8 shadow-xl flex flex-col items-center text-center"
              style={{ border: '2px solid #000', maxWidth: 320 }}>
              <div className="text-5xl mb-3">🎊</div>
              <div className="text-xl font-extrabold text-textMain mb-1">{t.allDone}</div>
              {completedCatNameRef.current && (
                <div className="text-textSub text-sm mt-1">
                  {completedCatNameRef.current}{t.allLearned}
                </div>
              )}
              <div className="flex gap-3 mt-5 w-full justify-center">
                <button
                  onClick={handleReviewAgain}
                  className="px-5 py-2.5 rounded-full text-sm font-bold active:scale-95"
                  style={{ backgroundColor: '#fbf2e2', color: '#000', border: '2px solid #000' }}
                >
                  {t.reviewAgain}
                </button>
                <button
                  onClick={handleLearnNew}
                  className="px-5 py-2.5 rounded-full text-sm font-bold active:scale-95"
                  style={{ backgroundColor: '#FFDF4E', color: '#000', border: '2px solid #000' }}
                >
                  {t.learnNew}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── All done state ──
  if (!currentWord) {
    return (
      <div className="flex flex-col h-full relative">
        <div className="absolute inset-0 z-0">
          {isReview ? (
            <img src={getFigmaAssetUrl('vocablist-study-background.jpg')} alt="" className="w-full h-full object-cover" />
          ) : (
            <img src={getFigmaAssetUrl('study_background.jpg')} alt="" className="w-full h-full object-cover" />
          )}
        </div>
        {isReview && (
          <div className="relative shrink-0 flex items-center px-5" style={{ height: 45, paddingTop: 16, zIndex: 10 }}>
            <div className="flex items-center" style={{ gap: 11 }}>
              <button onClick={onExitReview} className="w-[27px] h-[27px] flex items-center justify-center active:scale-90">
                <img src={getFigmaAssetUrl('back-button.png')} alt="返回" className="w-full h-full object-contain" />
              </button>
              <button data-testid="learn-category-btn" onClick={handleOpenCategories} className="w-[28px] h-[28px] flex items-center justify-center active:scale-90">
                <img src={getFigmaAssetUrl('category-btn.png')} alt="分类" className="w-full h-full object-contain" />
              </button>
            </div>
          </div>
        )}
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6">
          {(() => {
            const showEmptyReview = isReview && !hasAnyLearnedInScope;
            if (showEmptyReview) {
              // Match the WordListPage empty-state styling so review and list
              // empty surfaces feel like the same thing.
              const noLearnedText = isOralMode
                ? (t.noLearnedPhrases || t.noLearned)
                : t.noLearned;
              return (
                <>
                  <div className="text-4xl mb-2">😭</div>
                  <div className="text-sm font-bold text-textSub">{noLearnedText}</div>
                  <div className="text-xs mt-1 text-textLight">{t.learnedTip}</div>
                  <button onClick={onExitReview}
                    className="mt-4 px-6 py-2.5 bg-[#2b2a26] text-white rounded-full text-sm font-bold shadow">
                    {t.backToList}
                  </button>
                </>
              );
            }
            return (
              <>
                <div className="text-6xl mb-3">🎉</div>
                <div className="text-xl font-extrabold text-textMain mb-1">
                  {isReview ? t.reviewDone : t.allDone}
                </div>
                <div className="text-textSub text-sm text-center">
                  {isReview
                    ? t.reviewAll
                    : (selectedCategory === 'all' ? t.allWords : catLabels[selectedCategory]) + t.allLearned
                  }
                </div>
                {isReview ? (
                  <button onClick={onExitReview}
                    className="mt-4 px-6 py-2.5 bg-[#2b2a26] text-white rounded-full text-sm font-bold shadow">
                    {t.backToList}
                  </button>
                ) : (
                  <button onClick={() => { onCategoryChange?.('all'); onLevelChange?.('all'); resetSrsSession(); }}
                    className="mt-4 px-6 py-2.5 bg-[#2b2a26] text-white rounded-full text-sm font-bold shadow">
                    {t.restart}
                  </button>
                )}
              </>
            );
          })()}
        </div>
        {renderCategoryModal()}
      </div>
    );
  }

  const correctAnswer = getWordText(currentWord, nativeLang);
  const showBigImage = quizFormat === 'A';

  return (
    <div className="relative flex flex-col h-full">
      {/* ── BACKGROUND ── */}
      {isReview ? (
        <img
          src={getFigmaAssetUrl('vocablist-study-background.jpg')}
          alt=""
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          style={{ zIndex: 0 }}
        />
      ) : (
        <img
          src={getFigmaAssetUrl('study_background.jpg')}
          alt=""
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          style={{ zIndex: 0 }}
        />
      )}

      {/* ── DECORATIVE OVERLAYS (normal mode only) ── */}
      {!isReview && (
        <>
          <img src={getFigmaAssetUrl('nav-decor-top-1.png')} alt=""
            className="absolute pointer-events-none select-none"
            style={{ left: 0, bottom: -4, width: navLeftDecorW, zIndex: 3 }} />
          <img src={getFigmaAssetUrl('nav-decor-top-2.png')} alt=""
            className="absolute pointer-events-none select-none"
            style={{ right: 8, bottom: -4, width: 37, zIndex: 3 }} />
          <img src={getFigmaAssetUrl('nav-decor-3.png')} alt=""
            className="absolute pointer-events-none select-none"
            style={{ left: 105, bottom: -17, width: 37, zIndex: 3 }} />
        </>
      )}

      {/* ── CONTENT ── */}
      <div ref={containerRef} className="relative flex flex-col h-full" style={{
        zIndex: 2,
        // Subtract choicesPadTop so the flex content area ends at the *visible* card top, not the choices region top — this makes the bottom spacer naturally line up with the cards
        paddingBottom: (quizFormat === 'B' ? IMG_CHOICES_H : TEXT_CHOICES_H) * choiceScale - choicesPadTop * choiceScale,
      }}>

        {/* ── TOP BAR ── */}
        <div className="shrink-0 relative flex items-center justify-between px-5" style={{ height: 45, paddingTop: 16, zIndex: 10 }}>
          {isReview ? (
            <div className="flex items-center" style={{ gap: 11 }}>
              <button onClick={onExitReview} className="w-[27px] h-[27px] flex items-center justify-center active:scale-90">
                <img src={getFigmaAssetUrl('back-button.png')} alt="返回" className="w-full h-full object-contain" />
              </button>
              <button data-testid="learn-category-btn" onClick={handleOpenCategories} className="w-[28px] h-[28px] flex items-center justify-center active:scale-90">
                <img src={getFigmaAssetUrl('category-btn.png')} alt="分类" className="w-full h-full object-contain" />
              </button>
            </div>
          ) : (
            <button
              data-testid="learn-category-btn"
              onClick={handleOpenCategories}
              className="w-[28px] h-[28px] active:scale-90"
            >
              <img src={getFigmaAssetUrl('category-btn.png')} alt="分类" className="w-full h-full object-contain" />
            </button>
          )}

          <span className="text-[14px] text-[#999]">{counterText}</span>
        </div>

        {/* ── IMAGE AREA (Format A only) ── */}
        {showBigImage && (
          <div className="shrink-0 flex justify-center" style={{ paddingTop: imgPadTop, marginTop: imgMarginTop }}>
            <div className="relative" style={{ width: imgSize, height: imgSize }}>
              <div
                className="absolute inset-0 overflow-hidden"
                style={{ borderRadius: imgRadius }}
              >
                <img
                  src={getImageUrl(currentWord.img)}
                  alt={stripRuby(displayWord)}
                  className="w-full h-full object-cover"
                />
              </div>
              <img
                src={getFigmaAssetUrl(isReview ? 'frame-photo-no-decor.png' : 'pic_square_wrapper_clean.png')}
                alt=""
                className="absolute pointer-events-none select-none"
                style={isReview ? {
                  top: noDecorFrameTop, left: noDecorFrameLeft,
                  width: noDecorFrameW, height: noDecorFrameH,
                  maxWidth: 'none', zIndex: 1,
                } : {
                  top: frameTop, left: frameLeft,
                  width: frameW, height: frameH,
                  maxWidth: 'none', zIndex: 1,
                }}
              />
            </div>
          </div>
        )}

        {/* ── WORD INFO TOP SPACER ── */}
        {/* With image (format A): flex-grow on both spacers centers the wordInfo between image and choices.
            Without image (format B): fixed top spacing so wordInfo sits near the top (Figma 181:868 → vocab-section at y=99, 54px below topbar). */}
        {showBigImage ? (
          <div style={{ flex: 1, minHeight: 0 }} />
        ) : (
          <div style={{ height: Math.round(54 * imgScale), flexShrink: 0 }} />
        )}

        {/* ── WORD INFO ── */}
        <div className="shrink-0 flex flex-col items-center px-6" style={{
          paddingBottom: 4,
          overflow: 'visible',
          zIndex: 5,
        }}>
          {/* Main word display */}
          <RubyText
            text={isTargetJa ? displayWord : displayWord.toLowerCase()}
            className="text-textMain text-center"
            style={{
              fontSize: wordTextFS,
              fontFamily: targetFont,
              fontWeight: 900,
              lineHeight: isCJK(targetLang) ? 1.35 : 1.25,
            }}
          />

          {/* Speaker + phonetic / reading */}
          <button
            onClick={handleSpeak}
            className="flex items-center gap-1.5 text-[#999] active:scale-95"
            style={{ marginTop: isTargetJa ? 4 : 5 }}
          >
            <img src={getFigmaAssetUrl('icon-speaker.png')} alt="发音" style={{ width: 19, height: 15, flexShrink: 0 }} />
            {phonetic && (
              <span style={{ fontSize: phoneticFS, fontFamily: isTargetJa ? '"Hiragino Sans", sans-serif' : 'inherit' }} className="text-center">
                {phonetic}
              </span>
            )}
          </button>

          {/* Example sentence — hidden in D mode */}
          {displaySentence && quizFormat !== 'D' && (
            <p
              className="text-textMain text-center"
              style={{
                marginTop: isTargetJa ? 5 : 6,
                fontSize: sentenceFS_base - (isCJK(sentenceLang) ? 2 : 0),
                fontWeight: 'normal',
                lineHeight: isCJK(sentenceLang) ? 1.5 : 1.25,
                fontFamily: sentenceLang === 'en' ? 'Arial, sans-serif' : getFontFamily(sentenceLang),
              }}
            >
              {displaySentence}
            </p>
          )}

          {/* Translation — always visible in formats A & B (& oral C step 0); cover in C; hidden in D */}
          {displaySentence && quizFormat !== 'D' && needsTranslation && (
            quizFormat === 'A' || quizFormat === 'B' || (isOralMode && quizFormat === 'C' && currentStep === 0) ? (
              <p
                className="text-center px-2"
                style={{ marginTop: 5, fontSize: translationFS_base - (isCJK(translationLang) ? 2 : 0), color: sentenceTranslation ? '#555' : '#bbb', lineHeight: isCJK(translationLang) ? 1.5 : 1.25 }}
              >
                {sentenceTranslation || t.translating}
              </p>
            ) : (
              <button
                onClick={() => setShowSentence(tt => !tt)}
                className="flex items-center justify-center active:scale-95"
                style={{ marginTop: 6, minWidth: 234, height: 24, flexShrink: 0 }}
              >
                {showSentence ? (
                  <p style={{ fontSize: translationFS_base - (isCJK(translationLang) ? 2 : 0), color: sentenceTranslation ? '#555' : '#bbb', lineHeight: isCJK(translationLang) ? 1.5 : 1.25 }} className="text-center px-2">
                    {sentenceTranslation || t.translating}
                  </p>
                ) : (
                  <div className="rounded-sm" style={{
                    width: 268, height: 24,
                    background: 'linear-gradient(90deg, #ffffff 0%, #F1FFDB 48%, #ffffff 100%)',
                  }} />
                )}
              </button>
            )
          )}
        </div>

        {/* ── WORD INFO BOTTOM SPACER (pairs with top spacer to center word block) ── */}
        <div style={{ flex: 1, minHeight: 0 }} />

        {/* ── CHOICES AREA (absolutely pinned to bottom, never moves) ── */}
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          height: (quizFormat === 'B' ? IMG_CHOICES_H : TEXT_CHOICES_H) * choiceScale,
          zIndex: 4, overflow: 'visible',
        }}>
         <div style={{
           transform: choiceScale < 0.995 ? `scale(${choiceScale})` : undefined,
           transformOrigin: 'top center',
         }}>
          <div className="relative px-[15px]" style={{ paddingTop: choicesPadTop, paddingBottom: 20 }}>

          {/* 2 x 2 grid: image choices (B), text choices (A/C), or D-mode (know/don't-know) */}
          {quizFormat === 'D' ? (
            /* ── Format D: Know / Don't Know — identical to C layout, just 2 buttons ── */
            <div className="grid grid-cols-2 gap-x-[13px]" style={{ rowGap: 7 }}>
              {[
                { key: 'know', label: t.dKnow, handler: handleDKnow, animId: 'dKnow', idx: 0 },
                { key: 'dontknow', label: t.dDontKnow, handler: handleDDontKnow, animId: 'dDontKnow', idx: 1 },
              ].map(({ key, label, handler, animId, idx }) => {
                const isKnowFlash = key === 'know' && dModeResultRef.current === 'know';
                const isDontKnowFlash = key === 'dontknow' && dModeResultRef.current === 'dontknow';
                const isWiggling = animKey === animId;
                return (
                  <div key={key} className="relative" style={{
                    height: 115,
                    animation: isWiggling ? 'btnWiggle 0.46s ease-out' : undefined,
                  }}>
                    {/* Cat decor on top-left cell — same as C mode */}
                    {idx === 0 && !isReview && showCatDecor && (
                      <img src={getFigmaAssetUrl('word-decor.png')} alt=""
                        className="absolute pointer-events-none select-none"
                        style={{ left: 15, top: -26, width: 52, zIndex: 5 }} />
                    )}
                    {/* Background card */}
                    <div
                      className="absolute rounded-[8px]"
                      style={{
                        left: 2, right: 2, top: 3, bottom: 3,
                        backgroundColor: isKnowFlash ? '#ECFFD0' : isDontKnowFlash ? '#FFECEA' : '#ffffff',
                        transition: 'background-color 0.15s',
                      }}
                    />
                    {/* Decoration frame — same as C mode */}
                    <img
                      src={getFigmaAssetUrl('text-container.png')}
                      alt=""
                      className="absolute inset-0 w-full h-full pointer-events-none select-none object-fill"
                      style={{ zIndex: 1 }}
                    />
                    {/* Clickable button */}
                    <button
                      onClick={handler}
                      disabled={dModeResultRef.current !== null}
                      className="absolute inset-0 flex items-center justify-center rounded-[8px] text-textMain font-normal"
                      style={{ fontSize: 17, zIndex: 2, padding: 10, transition: 'none' }}
                    >
                      {label}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : quizFormat === 'B' ? (
            /* ── Format B: Image choices with pic-container frame ── */
            <div className="grid grid-cols-2 gap-x-[13px]" style={{ rowGap: 10 }}>
              {imageOpts.map((optWord, idx) => {
                const isThisCorrect = isCorrect && optWord.id === currentWord.id;
                const isThisWrong = wrongImageIds.has(optWord.id);

                const isWiggling = animKey === `img-${optWord.id}`;
                return (
                  <div key={`${currentWord.id}-img-${idx}`} className="relative" style={{
                    height: 145,
                    animation: isWiggling ? 'btnWiggle 0.46s ease-out' : undefined,
                  }}>
                    {/* Word image inside rounded rect */}
                    <div
                      className="absolute rounded-[12px] overflow-hidden"
                      style={{
                        left: 2, right: 2, top: 3, bottom: 3,
                        backgroundColor: isThisCorrect ? '#ECFFD0' : isThisWrong ? '#FFECEA' : '#ffffff',
                        transition: 'background-color 0.15s',
                      }}
                    >
                      <img
                        src={getImageUrl(optWord.img)}
                        alt=""
                        className="w-full h-full object-cover"
                        style={{ opacity: isThisWrong ? 0.35 : 1, transition: 'opacity 0.15s' }}
                      />
                    </div>
                    {/* pic-container decoration frame */}
                    <img
                      src={getFigmaAssetUrl('pic-container.png')}
                      alt=""
                      className="absolute inset-0 w-full h-full pointer-events-none select-none object-fill"
                      style={{ zIndex: 1 }}
                    />
                    {/* Clickable overlay */}
                    <button
                      onClick={() => handleImageClick(optWord)}
                      disabled={!!isCorrect || isThisWrong}
                      className="absolute inset-0 rounded-[12px]"
                      style={{ zIndex: 2 }}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            /* ── Format A/C: Text choices ── */
            <div className="grid grid-cols-2 gap-x-[13px]" style={{ rowGap: 7 }}>
              {options.map((option, idx) => {
                const isThisCorrect = isCorrect && option === correctAnswer;
                const isThisWrong = wrongSelections.has(option);

                const isWiggling = animKey === option;
                return (
                  <div key={`${currentWord.id}-${idx}`} className="relative" style={{
                    height: 115,
                    animation: isWiggling ? 'btnWiggle 0.46s ease-out' : undefined,
                  }}>
                    {/* Cat decor on top-left cell — hidden on short screens */}
                    {idx === 0 && !isReview && showCatDecor && (
                      <img src={getFigmaAssetUrl('word-decor.png')} alt=""
                        className="absolute pointer-events-none select-none"
                        style={{ left: 15, top: -26, width: 52, zIndex: 5 }} />
                    )}
                    {/* Heart decor on bottom-right cell (Figma 181:616: word-decor-2 at left:90.26%, top:135 of 390×263 section) */}
                    {idx === 3 && !isReview && showCatDecor && (
                      <img src={getFigmaAssetUrl('nav-decor-2.png')} alt=""
                        className="absolute pointer-events-none select-none"
                        style={{ right: -18, top: -12, width: 40, transform: 'rotate(-10deg)', zIndex: 5 }} />
                    )}
                    {/* Background card */}
                    <div
                      className="absolute rounded-[8px]"
                      style={{
                        left: 2, right: 2, top: 3, bottom: 3,
                        backgroundColor: isThisCorrect ? '#ECFFD0' : isThisWrong ? '#FFECEA' : '#ffffff',
                        transition: 'background-color 0.15s',
                      }}
                    />
                    {/* Decoration frame */}
                    <img
                      src={getFigmaAssetUrl(quizFormat === 'C' ? 'text-container.png' : 'choice-btn.png')}
                      alt=""
                      className="absolute inset-0 w-full h-full pointer-events-none select-none object-fill"
                      style={{ zIndex: 1 }}
                    />
                    {/* Clickable button */}
                    <button
                      onClick={() => handleOptionClick(option)}
                      disabled={!!isCorrect || isThisWrong}
                      className="absolute inset-0 flex items-center justify-center rounded-[8px] text-textMain font-normal"
                      style={{ fontSize: 17, zIndex: 2, padding: 10, transition: 'none' }}
                    >
                      <RubyText text={option} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── SKIP BUTTON ── */}
          <div
            className="absolute left-1/2 -translate-x-1/2 pointer-events-none"
            style={{ top: quizFormat === 'B' ? imgSkipTop_full : skipTop_full, zIndex: 6 }}
          >
            <div className="relative pointer-events-auto" style={{
              width: 88, height: 85,
              animation: animKey === 'skip' ? 'btnWiggle 0.46s ease-out' : undefined,
            }}>
              <img
                src={getFigmaAssetUrl('skip-btn.png')}
                alt=""
                className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
                style={{ transform: 'translateY(-5px)' }}
              />
              <button
                data-testid="learn-skip-btn"
                onClick={handleSkip}
                className="absolute inset-0 flex items-start justify-center active:scale-95"
                style={{ paddingTop: Math.round(85 * 0.42) }}
              >
                <span
                  className="relative text-[#8a5d45]"
                  style={{
                    fontWeight: 900,
                    fontSize: nativeLang === 'en' ? 17 : 22,
                  }}
                >
                  {t.skip}
                </span>
              </button>
            </div>
          </div>
          </div>
         </div>
        </div>
      </div>

      {/* ── CATEGORY MODAL (full-page, Figma redesign) ── */}
      {renderCategoryModal()}
    </div>
  );

  function renderCategoryModal() {
    if (!showCategories) return null;
    const tabLabels = CATEGORY_TAB_LABELS[nativeLang] || CATEGORY_TAB_LABELS.zh;
        // Level tab temporarily hidden
        const tabs = [{ key: 'detail', label: tabLabels.detail }, { key: 'oral', label: tabLabels.oral }];
        // Uniform tab width: within a language, all tabs share the widest label's width.
        // CJK chars are roughly twice as wide as Latin letters at the same font size,
        // so we approximate per-char pixel widths (14px font, weight 500).
        const approxLabelWidth = (s) => {
          let w = 0;
          for (const ch of s) {
            const code = ch.charCodeAt(0);
            if (code > 0x2e80) w += 15;            // CJK / kana
            else if (/[A-Z]/.test(ch)) w += 9.5;   // uppercase Latin
            else if (/[a-z]/.test(ch)) w += 7.5;   // lowercase Latin
            else w += 6;                            // digits/punct
          }
          return Math.ceil(w);
        };
        const tabInnerW = Math.max(...tabs.map(t => approxLabelWidth(t.label)));
        const tabWidth = tabInnerW + 32 + 3; // + paddingX (16*2) + border (1.5*2)
        const detailCatLabels = CATEGORY_LABELS[nativeLang] || CATEGORY_LABELS.zh;
        const oralCatLabels = ORAL_CATEGORY_LABELS[nativeLang] || ORAL_CATEGORY_LABELS.zh;

        // BUG FIX: Use vocab words pool for level/detail tabs regardless of current mode
        const vocabPool = words.filter(w => isWordAvailable(w, nativeLang, targetLang));

        const allLevelDefs = [
          { key: 'beginner', label: 'Level 1', num: '1' },
          { key: 'intermediate', label: 'Level 2', num: '2' },
          { key: 'advanced', label: 'Level 3', num: '3' },
        ];
        const levelItems = allLevelDefs.filter(lv => vocabPool.some(w => w.level === lv.key));
        const detailCats = categories.filter(c => c !== 'all' && vocabPool.some(w => w.category === c));
        const dynamicCatImages = {};
        detailCats.forEach(cat => {
          const firstWord = vocabPool.find(w => w.category === cat);
          if (firstWord) dynamicCatImages[cat] = firstWord.img;
        });
        const oralCats = oralCategories.filter(c => c !== 'all');

        // Progress helper: count learned / total for a word pool
        const getCatProgress = (wordPool) => {
          const learned = wordPool.filter(w => progress[w.id]?.timestamp).length;
          return { learned, total: wordPool.length };
        };

        // Per-row decoration picker (matches Figma 343:232 spec):
        // For each row of 3 cards → at most 1 letter at top-right, at most 1 star
        // (BL or TR). If both would land on same card at TR, star moves to BL.
        const getRowDecor = (rowSeed) => {
          let h = 0;
          const s = String(rowSeed || 'x');
          for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
          const next = () => { h = (h * 9301 + 49297) & 0x7fffffff; return h; };
          const letterPick = next() % 4; // 0:none 1..3:card idx+1
          const starPick = next() % 4;
          let starAtTR = (next() % 2) === 1;
          if (letterPick !== 0 && starPick === letterPick && starAtTR) starAtTR = false;
          return {
            letterIdx: letterPick === 0 ? -1 : letterPick - 1,
            starIdx: starPick === 0 ? -1 : starPick - 1,
            starAtTR,
          };
        };

        // Shared card renderer with progress bar (matches Figma card: ~108x auto)
        const renderCatCard = (key, imgSrc, label, isSelected, onClick, prog, decor = {}, opts = {}) => {
          const { hasLetter = false, hasStar = false, starAtTR = false } = decor;
          const { imageContain = false } = opts;
          return (
          <button key={key} ref={isSelected ? selectedCatCardRef : null} onClick={onClick} className="relative flex flex-col items-center active:scale-95" style={{ overflow: 'visible' }}>
            <div style={{
              position: 'relative',
              width: 102, boxSizing: 'border-box', backgroundColor: '#fbf2e2',
              border: `2px solid ${isSelected ? '#FFDF4E' : '#000'}`,
              borderRadius: 10, display: 'flex', flexDirection: 'column', alignItems: 'center',
              padding: '4px 6px 8px',
            }}>
              {/* Category image */}
              <div style={{ width: 90, height: 90, borderRadius: 10, overflow: 'hidden', backgroundColor: imageContain ? '#fff' : '#e8dcc8', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {imgSrc ? (
                  imageContain ? (
                    <img src={imgSrc} alt={label} style={{ width: '55%', height: '68%', objectFit: 'contain' }} />
                  ) : (
                    <img src={imgSrc} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  )
                ) : (
                  <span style={{ fontSize: 44, lineHeight: 1 }}>{key === 'beginner' ? '1' : key === 'intermediate' ? '2' : key === 'advanced' ? '3' : ''}</span>
                )}
              </div>
              {/* Progress bar — own row (Figma 472:339/340; 75.27 / 107.8 ≈ 70% of card) */}
              <div style={{
                width: '75%', marginTop: 10, height: 9, borderRadius: 100,
                backgroundColor: '#ffffff', border: '1px solid #000',
                position: 'relative', overflow: 'hidden', boxSizing: 'border-box',
              }}>
                <div style={{
                  height: '100%', borderRadius: 100,
                  backgroundColor: prog.total > 0 && prog.learned >= prog.total ? '#C7F59A' : '#ffcc00',
                  width: prog.total > 0 ? `${(prog.learned / prog.total) * 100}%` : '0%',
                }} />
              </div>
              {/* Count — 2nd row below bar (equal spacing above and below) */}
              <span style={{ fontSize: 12, fontWeight: 500, color: '#000', marginTop: 5, lineHeight: 1, textAlign: 'center' }}>
                {prog.learned}/{prog.total}
              </span>
              {/* Category label — 3rd row */}
              <span style={{ fontSize: 12, fontWeight: 500, color: '#000', marginTop: 5, lineHeight: 1, textAlign: 'center' }}>
                {label}
              </span>
            </div>
            {/* Selection check badge — sits above corner decorations, at the very corner */}
            {isSelected && (
              <div style={{
                position: 'absolute', top: -8, right: -8,
                width: 22, height: 22, borderRadius: '50%',
                backgroundColor: '#FFDF4E', border: '2px solid #000',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 5,
              }}>
                <svg width="11" height="8" viewBox="0 0 11 8" fill="none">
                  <polyline points="1.5 4 4 6.5 9.5 1.5" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            )}
          </button>
          );
        };

        return (
          <div data-testid="category-modal" className="absolute inset-0 flex flex-col overflow-hidden" style={{ zIndex: 50, backgroundColor: '#faf2e2' }}>
            {/* Outer page background (outside the bordered frame) */}
            <img
              src={getFigmaAssetUrl('category-bg.jpg')} alt=""
              className="absolute inset-0 w-full h-full object-cover pointer-events-none"
              style={{ zIndex: 0 }}
            />
            {/* Content layer — fixed shell */}
            <div className="relative flex flex-col h-full">

              {/* ── Fixed top: Transparent header — tabs sit directly on modal bg ── */}
              <div className="shrink-0" style={{
                padding: '15px 16px 15px', position: 'relative', zIndex: 3,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
              }}>
                <button
                  onClick={() => setShowCategories(false)}
                  className="flex items-center justify-center active:scale-90"
                  style={{ position: 'absolute', left: 19, top: '50%', transform: 'translateY(-50%)', width: 27, height: 27 }}
                >
                  <img src={getFigmaAssetUrl('back-button.png')} alt="返回" className="w-full h-full object-contain" />
                </button>
                {tabs.map(tab => {
                  const isActive = categoryTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      onClick={() => {
                        if (categoryTab !== tab.key) {
                          setCategoryTab(tab.key);
                          if (tab.key === 'detail') { setPendingCategory('all'); setPendingLevel('all'); }
                          else if (tab.key === 'oral') { setPendingCategory('all'); setPendingLevel('oral'); }
                        }
                      }}
                      style={{
                        width: tabWidth, height: 32, paddingLeft: 16, paddingRight: 16,
                        borderRadius: 8, border: '1.5px solid #000',
                        backgroundColor: isActive ? '#FFDF4E' : '#F5F4EF',
                        color: '#000',
                        fontSize: 14, fontWeight: 500, lineHeight: '20px', letterSpacing: 0.1,
                      }}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              {/* ── Middle: Bordered content frame (outer fixed, inner scrollable) ── */}
              {/* minHeight: 0 so flex-1 can shrink on short viewports; otherwise the
                  fixed-bottom confirm button gets clipped by the parent overflow-hidden. */}
              <div className="flex-1 relative" style={{
                margin: '0 13px 15px',
                border: '2px solid #000', borderRadius: 10,
                minHeight: 0,
                overflow: 'hidden',
              }}>
                {/* Scrollable card area inside the frame */}
                <div ref={catScrollContainerRef} className="absolute inset-0 overflow-y-auto scrollbar-hide" style={{ zIndex: 1, WebkitOverflowScrolling: 'touch', padding: '14px 12px 18px' }}>

                  {/* === LEVEL TAB === */}
                  {categoryTab === 'level' && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 13, justifyContent: 'flex-start', maxWidth: 332, margin: '0 auto' }}>
                      {levelItems.map((lv, idx) => {
                        const isSelected = pendingLevel === lv.key && categoryTab === 'level';
                        const pool = vocabPool.filter(w => w.level === lv.key);
                        const prog = getCatProgress(pool);
                        const rowIdx = Math.floor(idx / 3);
                        const colIdx = idx % 3;
                        const row = getRowDecor(`level-${rowIdx}`);
                        const decor = {
                          hasLetter: row.letterIdx === colIdx,
                          hasStar: row.starIdx === colIdx,
                          starAtTR: row.starAtTR,
                        };
                        return renderCatCard(
                          lv.key, null, lv.label, isSelected,
                          () => { setPendingLevel(lv.key); setPendingCategory('all'); },
                          prog, decor,
                        );
                      })}
                    </div>
                  )}

                  {/* === DETAIL CATEGORY TAB === */}
                  {categoryTab === 'detail' && (() => {
                    // Build items: "all" card first, followed by each concrete category
                    const detailItems = [
                      { key: 'all', label: detailCatLabels.all || '全部', imgSrc: getFigmaAssetUrl('all-smile-face.png'), pool: vocabPool },
                      ...detailCats.map(cat => {
                        const imgFile = vocabCategoryCovers[cat] || dynamicCatImages[cat];
                        return {
                          key: cat,
                          label: detailCatLabels[cat],
                          imgSrc: imgFile ? getImageUrl(imgFile) : null,
                          pool: vocabPool.filter(w => w.category === cat),
                        };
                      }),
                    ];
                    return (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 13, justifyContent: 'flex-start', maxWidth: 332, margin: '0 auto' }}>
                        {detailItems.map((item, idx) => {
                          const isSelected = pendingCategory === item.key && categoryTab === 'detail';
                          const prog = getCatProgress(item.pool);
                          const rowIdx = Math.floor(idx / 3);
                          const colIdx = idx % 3;
                          const row = getRowDecor(`detail-${rowIdx}`);
                          const decor = {
                            hasLetter: row.letterIdx === colIdx,
                            // Suppress star on row 0 (keeps the "全部" card area clean)
                            hasStar: rowIdx !== 0 && row.starIdx === colIdx,
                            starAtTR: row.starAtTR,
                          };
                          return renderCatCard(
                            item.key, item.imgSrc, item.label, isSelected,
                            () => { setPendingCategory(item.key); setPendingLevel('all'); },
                            prog, decor,
                            { imageContain: item.key === 'all' },
                          );
                        })}
                      </div>
                    );
                  })()}

                  {/* === ORAL TAB === */}
                  {categoryTab === 'oral' && (() => {
                    // Build items: "all" card first, followed by each concrete oral category
                    const oralItems = [
                      { key: 'all', label: oralCatLabels.all || '全部', imgSrc: getFigmaAssetUrl('all-smile-face.png'), pool: oralPhrases },
                      ...oralCats.map(cat => {
                        const imgFile = oralCategoryCovers[cat];
                        return {
                          key: cat,
                          label: oralCatLabels[cat],
                          imgSrc: imgFile ? getImageUrl(imgFile) : null,
                          pool: oralPhrases.filter(w => w.category === cat),
                        };
                      }),
                    ];
                    return (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 13, justifyContent: 'flex-start', maxWidth: 332, margin: '0 auto' }}>
                        {oralItems.map((item, idx) => {
                          const isSelected = pendingCategory === item.key && categoryTab === 'oral';
                          const prog = getCatProgress(item.pool);
                          const rowIdx = Math.floor(idx / 3);
                          const colIdx = idx % 3;
                          const row = getRowDecor(`oral-${rowIdx}`);
                          const decor = {
                            hasLetter: row.letterIdx === colIdx,
                            // Suppress star on row 0 (keeps the "全部" card area clean)
                            hasStar: rowIdx !== 0 && row.starIdx === colIdx,
                            starAtTR: row.starAtTR,
                          };
                          return renderCatCard(
                            item.key, item.imgSrc, item.label, isSelected,
                            () => { setPendingCategory(item.key); setPendingLevel('oral'); },
                            prog, decor,
                            { imageContain: item.key === 'all' },
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* ── Fixed bottom: confirm button ── */}
              <div className="shrink-0 relative flex justify-center" style={{ paddingTop: 6, paddingBottom: 35, zIndex: 3 }}>
                <button
                  onClick={handleConfirmCategories}
                  className="flex items-center justify-center active:scale-95"
                  style={{
                    width: 158, height: 51, borderRadius: 100,
                    backgroundColor: '#FFDF4E', border: '2px solid #000',
                    position: 'relative', zIndex: 1,
                  }}
                >
                  <span style={{ fontSize: 24, fontWeight: 400, color: '#000' }}>{t.ok}</span>
                </button>
              </div>
            </div>
          </div>
        );
  }
}
