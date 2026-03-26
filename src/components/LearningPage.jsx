import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { words, wordsShuffled, categories } from '../data/words';
import { speakWordByLang, playCorrectSound, playWrongSound, playSlaySound } from '../hooks/useAudio';
import { getProgress, markWordLearned, toggleStar, toggleMastered, saveProgress, updateWordSRS, getReviewWordStates, saveReviewWordStates } from '../utils/storage';
import {
  getWordText, getSentence, getPhonetic, isWordAvailable,
  getTranslationPair, getFontFamily, UI_TEXT, CATEGORY_LABELS,
} from '../utils/langHelpers';
import {
  getDueReviewWords, calcBudget, buildInterleaved, getInterval,
  getReviewFormat, SESSION_GAPS, SESSION_FORMATS,
} from '../utils/srs';

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
  const wrongOnes = shuffle(others).slice(0, 3).map(w => getWordText(w, nativeLang));
  return shuffle([correctText, ...wrongOnes]);
}

function getImageOptions(correctWord, wordPool) {
  const others = wordPool.filter(w => w.id !== correctWord.id && w.img !== correctWord.img);
  const wrongOnes = shuffle(others).slice(0, 3);
  return shuffle([correctWord, ...wrongOnes]);
}

// ── Review Queue Algorithm ──
const REVIEW_DAY = 24 * 60 * 60 * 1000;

function getReviewQuestionType(wordState) {
  const { errorCount, sessionCorrect } = wordState;
  if (errorCount >= 2) return 'A';
  if (errorCount === 1) return 'B';
  return sessionCorrect > 0 ? 'C' : 'B';
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

const LEVELS = ['all', 'beginner', 'intermediate', 'advanced'];
const LEVEL_LABELS = { all: '全部难度', beginner: 'Level 1', intermediate: 'Level 2', advanced: 'Level 3' };
const TAG_COLORS_BASE = ['#e3ffbb', '#ecf7ff', '#fffcda', '#fff0f6'];

// Module-level cache for sentence translations (persists for session)
const _sentenceCache = new Map();

export default function LearningPage({
  isReview = false, onExitReview, onGoToStarred,
  nativeLang = 'zh', targetLang = 'en',
  selectedCategory = 'all', selectedLevel = 'beginner',
  onCategoryChange, onLevelChange,
  isVisible = true,
}) {
  const langKey = `${nativeLang}_${targetLang}`; // for session identity + sentence cache
  const storageKey = targetLang; // progress keyed by target language only
  const t = UI_TEXT[nativeLang] || UI_TEXT.zh;
  const catLabels = CATEGORY_LABELS[nativeLang] || CATEGORY_LABELS.zh;

  const [showCategories, setShowCategories] = useState(false);
  const [pendingCategory, setPendingCategory] = useState(selectedCategory);
  const [pendingLevel, setPendingLevel] = useState(selectedLevel);

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
  const containerRef = useRef(null);
  const [contentH, setContentH] = useState(() => Math.max(0, window.innerHeight - 60));
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
  const completedCatNameRef = useRef('');
  const categoryAutoSwitchRef = useRef(null);
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

  // Derived: quizFormat and currentWord
  const quizFormat = isReview ? (reviewCard?.format || 'B') : (srsCard?.format || 'A');

  // All words available for this language pair (for reviews & option generation)
  const allWordsFiltered = useMemo(() => {
    return words.filter(w => isWordAvailable(w, nativeLang, targetLang));
  }, [nativeLang, targetLang]);

  // ── Review Queue Initialization & helpers ──
  const showNextReviewCard = useCallback((queue, pointer, wordStates) => {
    const word = queue[pointer];
    if (!word) { setReviewCard(null); return; }
    if (!wordStates[word.id]) wordStates[word.id] = { errorCount: 0, sessionCorrect: 0 };
    setReviewCard({ word, format: getReviewQuestionType(wordStates[word.id]) });
  }, []);

  useEffect(() => {
    if (!isReview) { setReviewCard(null); return; }
    const prog = getProgress(storageKey);
    const eligible = allWordsFiltered.filter(w => prog[w.id]?.timestamp && !prog[w.id].mastered);
    if (eligible.length === 0) { setReviewCard(null); return; }
    // Load persisted word states so card types (B/C/A) and error weights survive re-entry
    const savedStates = getReviewWordStates(storageKey);
    reviewWordStatesRef.current = savedStates;
    const queue = buildReviewQueueFromWords(eligible, prog, savedStates);
    reviewQueueRef.current = queue;
    reviewPointerRef.current = 0;
    showNextReviewCard(queue, 0, reviewWordStatesRef.current);
  }, [isReview, langKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Speak function based on target language
  const speakCurrent = useCallback((text) => {
    speakWordByLang(text, targetLang);
  }, [targetLang]);

  // Measure container height for responsive layout (ResizeObserver reacts to actual size changes)
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContentH(el.offsetHeight);
    const ro = new ResizeObserver(() => setContentH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Continuous responsive scaling (two-segment, matches Figma reference) ──
  // Full (FULL_H): image=100%, choices=100%
  // Short 1 (S1_H): image=70%, choices=88%  (Figma short screen 1)
  // Short 2 (MIN_H): image=65%, choices=80% (Figma short screen 2)
  const FULL_H = 780;
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
  const imgPadTop = Math.max(10, Math.round(responsive2(22, 10, 10)));
  // Frame decoration scales proportionally with image
  const frameTop = Math.round(-16 * imgScale);
  const frameLeft = Math.round(-45 * imgScale);
  const frameW = imgSize + Math.round(77 * imgScale);
  const frameH = imgSize + Math.round(47 * imgScale);
  const imgRadius = Math.round(20 * imgScale);

  // Word info section — ensure minimum gap between image and word
  const wordInfoMinH = Math.round(responsive2(151, 120, 82));
  const wordInfoPadTop = 35;
  const wordInfoPadBot = Math.round(responsive2(6, 3, 2));

  // Font sizes: 24 / 16 / 14px base; scale ~80% only at very short screens
  const wordTextFS = Math.round(responsive2(24, 24, 19));
  const phoneticFS = Math.round(responsive2(16, 16, 13));
  const sentenceFS = Math.round(responsive2(16, 16, 13));
  const translationFS = Math.round(responsive2(14, 14, 11));

  // Choices: 100% → 88% → 80% → ~64% (more aggressive shrinking below MIN_H)
  const choiceScale = responsive2(1.0, 0.88, 0.80) * (1 - 0.20 * ultraT);
  // Choices padding-top: drops quickly from 26 to 10 once below MIN_H (reaches 10 within 30px)
  const choicesPadTop = contentH >= MIN_H ? 26 : Math.max(10, Math.round(26 - 16 * Math.min(1, (MIN_H - contentH) / 30)));
  // Natural (full-size) height of the choices section
  const TEXT_CHOICES_H = 26 + 115 * 2 + 7 + 30;   // 293
  const IMG_CHOICES_H = 26 + 145 * 2 + 10 + 30;   // 356
  const skipTop_full = Math.round(26 + 115 + 7 / 2 - 85 / 2);
  const imgSkipTop_full = Math.round(26 + 145 + 10 / 2 - 85 / 2);

  // Decoration thresholds
  const showCatDecor = contentH >= S1_H;       // cat on choices (hide at short screen 1)
  const showBigNavDecor = contentH >= S1_H;    // large nav scene; frog only on truly short screens
  const isCompact = contentH < FULL_H;
  const navLeftDecorW = Math.round(responsive2(78, 52, 46));

  // Reload progress when target language changes (storage key changed)
  useEffect(() => {
    setProgress(getProgress(storageKey));
  }, [storageKey]);

  // Reset review index whenever either language changes
  useEffect(() => {
    setCurrentIndex(0);
  }, [langKey]);

  // ── Review mode: wordPool (unchanged) ──
  const wordPool = useMemo(() => {
    if (!isReview) return []; // not used in SRS mode
    const prog = progress;
    let pool = selectedCategory === 'all' ? wordsShuffled : words.filter(w => w.category === selectedCategory);
    pool = pool.filter(w => isWordAvailable(w, nativeLang, targetLang));
    if (selectedLevel !== 'all') pool = pool.filter(w => w.level === selectedLevel);
    return shuffle(pool.filter(w => prog[w.id] && !prog[w.id].mastered));
  }, [selectedCategory, selectedLevel, progress, isReview, nativeLang, targetLang]);

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

    // Session done
    setSrsCard(null);
  }, []);

  useEffect(() => {
    if (isReview) {
      setSrsCard(null);
      sessionInitKey.current = ''; // invalidate so session rebuilds when user returns
      return;
    }

    const key = `${langKey}_${selectedCategory}_${selectedLevel}_${sessionKey}`;
    const isInitializing = sessionInitKey.current !== key;
    // Signal to category-done effect: don't fire while we're (re)building the session
    sessionLoadingRef.current = isInitializing;
    // Don't rebuild if same key (prevents re-init on progress updates)
    if (!isInitializing) return;
    sessionInitKey.current = key;

    const prog = getProgress(storageKey);

    // New words (filtered by category/level)
    let newPool = selectedCategory === 'all'
      ? [...wordsShuffled]
      : words.filter(w => w.category === selectedCategory);
    newPool = newPool.filter(w => isWordAvailable(w, nativeLang, targetLang));
    if (selectedLevel !== 'all') newPool = newPool.filter(w => w.level === selectedLevel);
    newPool = newPool.filter(w => !prog[w.id]?.timestamp);
    newPool = shuffle(newPool);

    // Due review words (global across categories)
    const dueWords = getDueReviewWords(prog, allWordsFiltered);
    const { reviewBudget } = calcBudget(dueWords.length);

    // Use ALL available new words — session continues until category is truly exhausted
    const reviewSlice = dueWords.slice(0, reviewBudget);

    const queue = buildInterleaved(newPool, reviewSlice, prog);

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
  }, [isReview, langKey, selectedCategory, selectedLevel, nativeLang, targetLang, allWordsFiltered, showNextCard, sessionKey]);

  // Force rebuild SRS session when category/level confirmed
  const resetSrsSession = useCallback(() => {
    sessionInitKey.current = ''; // force rebuild on next effect run
    setSessionKey(k => k + 1);
  }, []);

  // ── Category-done detection: auto-switch when a category is exhausted ──
  useEffect(() => {
    // Don't trigger when the page is hidden, or while the session is being (re)built
    if (isReview || srsCard !== null || !isVisible || sessionLoadingRef.current) return;

    const prog = getProgress(storageKey);
    const unlearned = allWordsFiltered.filter(w => !prog[w.id]?.timestamp);
    if (unlearned.length === 0) return; // truly all done — show the all-done screen

    // Current category/level exhausted but more words exist globally
    completedCatNameRef.current = (CATEGORY_LABELS[nativeLang] || CATEGORY_LABELS.zh)[selectedCategory] || '';
    setCategoryDoneVisible(true);

    categoryAutoSwitchRef.current = setTimeout(() => {
      categoryAutoSwitchRef.current = null;
      setCategoryDoneVisible(false);
      // Preserve current difficulty level if there are still unlearned words at that level
      const progNow = getProgress(storageKey);
      const hasUnlearnedAtLevel = selectedLevel === 'all'
        ? allWordsFiltered.some(w => !progNow[w.id]?.timestamp)
        : allWordsFiltered.some(w => w.level === selectedLevel && !progNow[w.id]?.timestamp);
      onCategoryChange?.('all');
      onLevelChange?.(hasUnlearnedAtLevel ? selectedLevel : 'all');
      resetSrsSession();
    }, 2200);

    return () => {
      if (categoryAutoSwitchRef.current) {
        clearTimeout(categoryAutoSwitchRef.current);
        categoryAutoSwitchRef.current = null;
      }
      setCategoryDoneVisible(false);
    };
  }, [srsCard, isReview, isVisible, langKey, allWordsFiltered, nativeLang, selectedCategory, selectedLevel]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Unified currentWord ──
  const currentWord = isReview ? (reviewCard?.word || null) : (srsCard?.word || null);
  const displayWord = currentWord ? getWordText(currentWord, targetLang) : '';

  const displaySentence = useMemo(() => {
    if (!currentWord) return '';
    const sentence = getSentence(currentWord, targetLang);
    if (!sentence && targetLang === 'zh') return currentWord.sentence || '';
    return sentence;
  }, [currentWord, targetLang]);

  const sentenceLang = useMemo(() => {
    if (!currentWord) return targetLang;
    const sentence = getSentence(currentWord, targetLang);
    if (!sentence && targetLang === 'zh') return 'en';
    return targetLang;
  }, [currentWord, targetLang]);

  const sameCategoryWords = useMemo(() => {
    if (!currentWord) return words;
    const base = words.filter(w => w.category === currentWord.category);
    return base.filter(w => isWordAvailable(w, nativeLang, targetLang));
  }, [currentWord, nativeLang, targetLang]);

  const isWordStarred = useMemo(() => {
    if (!currentWord) return false;
    return progress[currentWord.id]?.starred === true;
  }, [currentWord, progress]);

  const tagColorMap = useMemo(() => {
    const cats = categories.filter(c => c !== 'all');
    const map = {};
    cats.forEach((cat, idx) => {
      const gridPos = idx + 1;
      const gridCol = gridPos % 4;
      const gridRow = Math.floor(gridPos / 4);
      map[cat] = TAG_COLORS_BASE[(gridCol + gridRow) % TAG_COLORS_BASE.length];
    });
    return map;
  }, []);

  // ── Generate options when word or format changes ──
  useEffect(() => {
    if (!currentWord) return;
    const pool = sameCategoryWords.length >= 4 ? sameCategoryWords : allWordsFiltered;

    if (quizFormat === 'B') {
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
  }, [currentWord?.id, quizFormat]);

  // Phonetics
  useEffect(() => {
    if (!currentWord) { setPhonetic(''); return; }
    const staticPhonetic = getPhonetic(currentWord, targetLang);
    if (staticPhonetic !== null) { setPhonetic(staticPhonetic); return; }
    setPhonetic('');
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
  }, [currentWord?.id, targetLang]);

  // Sentence translation
  useEffect(() => {
    if (!currentWord || !displaySentence) { setSentenceTranslation(''); return; }
    if (sentenceLang === nativeLang) { setSentenceTranslation(''); return; }
    const cacheKey = `${currentWord.id}_${langKey}`;
    if (_sentenceCache.has(cacheKey)) { setSentenceTranslation(_sentenceCache.get(cacheKey)); return; }
    setSentenceTranslation('');
    const langpair = getTranslationPair(sentenceLang, nativeLang);
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
  }, [currentWord?.id, langKey, displaySentence, sentenceLang, nativeLang]);

  // Auto-speak on word change — always reset hasSpoken first, then speak only if tab is visible
  // reviewCard is included so the effect re-fires when the same word reappears (re-inserted after wrong answer)
  useLayoutEffect(() => {
    hasSpoken.current = false; // reset for every new word, regardless of visibility
    if (currentWord && isVisible) {
      hasSpoken.current = true;
      speakCurrent(displayWord);
    }
  }, [currentWord?.id, reviewCard]); // eslint-disable-line react-hooks/exhaustive-deps

  // When returning to the learn tab, speak the current word if not yet spoken
  useEffect(() => {
    if (isVisible && currentWord && !hasSpoken.current) {
      hasSpoken.current = true;
      speakCurrent(displayWord);
    }
  }, [isVisible]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { if (autoAdvanceTimer.current) clearTimeout(autoAdvanceTimer.current); };
  }, []);

  useEffect(() => {
    setCurrentIndex(0);
  }, [isReview]);

  // ── Advance logic ──
  const advanceToNext = useCallback(() => {
    if (isReview) {
      const card = reviewCard;
      if (!card) return;
      const hadWrong = wrongSelections.size > 0 || wrongImageIds.size > 0;
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

      // If cycle exhausted, rebuild with fresh shuffle (keep word states so type & error weight carries over)
      if (reviewPointerRef.current >= reviewQueueRef.current.length) {
        const prog = getProgress(storageKey);
        const eligible = allWordsFiltered.filter(w => prog[w.id]?.timestamp && !prog[w.id].mastered);
        if (eligible.length === 0) { setReviewCard(null); return; }
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

      if (hadWrong) {
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
          // Schedule next step
          const nextStep = step + 1;
          pendingRef.current.push({
            word: card.word,
            step: nextStep,
            format: SESSION_FORMATS[nextStep],
            dueAt: totalShownRef.current + SESSION_GAPS[nextStep],
          });
          updateWordSRS(card.word.id, { srsLevel: step, lastReviewedAt: now }, storageKey);
        } else {
          // Step 3 complete → graduate to cross-session level 4
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
  }, [isReview, storageKey, srsCard, wrongSelections, wrongImageIds, showNextCard, reviewCard, allWordsFiltered, showNextReviewCard]);

  // ── Click handlers ──
  const handleOptionClick = useCallback((option) => {
    if (isCorrect) return;
    triggerAnim(option);
    const correctAnswer = getWordText(currentWord, nativeLang);
    if (option === correctAnswer) {
      setSelected(option);
      setIsCorrect(true);
      playCorrectSound();
      autoAdvanceTimer.current = setTimeout(advanceToNext, 800);
    } else {
      setSelected(option);
      setIsCorrect(false);
      playWrongSound();
      setWrongSelections(prev => new Set([...prev, option]));
    }
  }, [currentWord, isCorrect, advanceToNext, nativeLang, triggerAnim]);

  const handleImageClick = useCallback((optWord) => {
    if (isCorrect) return;
    triggerAnim(`img-${optWord.id}`);
    if (optWord.id === currentWord.id) {
      setIsCorrect(true);
      playCorrectSound();
      autoAdvanceTimer.current = setTimeout(advanceToNext, 800);
    } else {
      setIsCorrect(false);
      playWrongSound();
      setWrongImageIds(prev => new Set([...prev, optWord.id]));
    }
  }, [currentWord, isCorrect, advanceToNext, triggerAnim]);

  const handleSpeak = useCallback(() => {
    if (currentWord) speakCurrent(displayWord);
  }, [currentWord, displayWord, speakCurrent]);

  const handleStar = useCallback(() => {
    if (!currentWord) return;
    toggleStar(currentWord.id, storageKey);
    setProgress(getProgress(storageKey));
  }, [currentWord, storageKey]);

  const handleSkip = useCallback(() => {
    if (!currentWord) return;
    triggerAnim('skip');
    if (autoAdvanceTimer.current) clearTimeout(autoAdvanceTimer.current);
    playSlaySound();
    if (!isReview) markWordLearned(currentWord.id, storageKey);
    toggleMastered(currentWord.id, true, storageKey);
    if (isReview) {
      const skippedId = currentWord.id;
      // Remove all occurrences of this word from the review queue
      reviewQueueRef.current = reviewQueueRef.current.filter((w, idx) => idx < reviewPointerRef.current || w.id !== skippedId);
      delete reviewWordStatesRef.current[skippedId];
      setTimeout(() => {
        const prog = getProgress(storageKey);
        const eligible = allWordsFiltered.filter(w => prog[w.id]?.timestamp && !prog[w.id].mastered);
        if (eligible.length === 0) { setReviewCard(null); return; }
        if (reviewPointerRef.current >= reviewQueueRef.current.length) {
          const queue = buildReviewQueueFromWords(eligible, prog);
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
  }, [currentWord, isReview, storageKey, showNextCard, triggerAnim, allWordsFiltered, showNextReviewCard]);

  // Counter text
  const counterText = useMemo(() => {
    if (isReview) {
      const total = reviewQueueRef.current.length;
      const pos = reviewPointerRef.current + 1;
      return total > 0 ? `${Math.min(pos, total)}/${total}` : '0/0';
    }
    // SRS mode: learned/total in current category+level filter
    let pool = selectedCategory === 'all' ? [...words] : words.filter(w => w.category === selectedCategory);
    pool = pool.filter(w => isWordAvailable(w, nativeLang, targetLang));
    if (selectedLevel !== 'all') pool = pool.filter(w => w.level === selectedLevel);
    const total = pool.length;
    const learned = pool.filter(w => progress[w.id]?.timestamp).length;
    return `${learned}/${total}`;
  }, [isReview, reviewCard, currentWord, selectedCategory, selectedLevel, nativeLang, targetLang, progress]);

  const handleOpenCategories = useCallback(() => {
    setPendingCategory(selectedCategory);
    setPendingLevel(selectedLevel);
    setShowCategories(true);
  }, [selectedCategory, selectedLevel]);

  const handleConfirmCategories = useCallback(() => {
    window.speechSynthesis.cancel();
    onCategoryChange?.(pendingCategory);
    onLevelChange?.(pendingLevel);
    setCurrentIndex(0);
    resetSrsSession();
    setShowCategories(false);
  }, [pendingCategory, pendingLevel, onCategoryChange, onLevelChange, resetSrsSession]);

  // Font for target language
  const targetFont = getFontFamily(targetLang);
  const isTargetJa = targetLang === 'ja';

  const levelDisplayText = pendingLevel === 'all'
    ? t.allLevels
    : `${t.levelPrefix}: ${LEVEL_LABELS[pendingLevel]}`;

  // ── Category done popup (more words exist in other categories) ──
  if (!currentWord && categoryDoneVisible) {
    return (
      <div className="flex flex-col h-full relative">
        <div className="absolute inset-0 z-0">
          <img src="/assets/figma/study_background.jpg" alt="" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6">
          <div className="bg-white rounded-2xl px-8 py-8 shadow-xl flex flex-col items-center text-center"
            style={{ border: '2px solid #000' }}>
            <div className="text-5xl mb-3">🎊</div>
            <div className="text-xl font-extrabold text-textMain mb-1">{t.categoryDone}</div>
            {completedCatNameRef.current && (
              <div className="text-textSub text-sm mt-1">
                {completedCatNameRef.current} {t.allLearned}
              </div>
            )}
            <div className="text-[#999] text-xs mt-3">{t.autoSwitching}</div>
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
            <img src="/assets/figma/vocablist-study-background.jpg" alt="" className="w-full h-full object-cover" />
          ) : (
            <img src="/assets/figma/study_background.jpg" alt="" className="w-full h-full object-cover" />
          )}
        </div>
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6">
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
        </div>
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
          src="/assets/figma/vocablist-study-background.jpg"
          alt=""
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          style={{ zIndex: 0 }}
        />
      ) : (
        <img
          src="/assets/figma/study_background.jpg"
          alt=""
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          style={{ zIndex: 0 }}
        />
      )}

      {/* ── DECORATIVE OVERLAYS (normal mode only) ── */}
      {!isReview && (
        <>
          <img src="/assets/figma/nav-decor-top-1.png" alt=""
            className="absolute pointer-events-none select-none"
            style={{ left: 0, bottom: -2, width: navLeftDecorW, zIndex: 3 }} />
          {showBigNavDecor ? (
            <img src="/assets/figma/nav-decor-top-2.png" alt=""
              className="absolute pointer-events-none select-none"
              style={{ right: 0, bottom: -10, width: 113, zIndex: 3 }} />
          ) : (
            /* Frog: CSS-cropped from source (matches Figma nav_decor_top_2_frog layer) */
            <div className="absolute pointer-events-none select-none overflow-hidden"
              style={{ right: 6, bottom: -10, width: 40, height: 38, zIndex: 3 }}>
              <img src="/assets/figma/nav-decor-frog.png" alt=""
                style={{
                  position: 'absolute', left: 0, top: '-115.8%',
                  width: '290%', height: '215.82%', maxWidth: 'none',
                }} />
            </div>
          )}
          <img src="/assets/figma/nav-decor-3.png" alt=""
            className="absolute pointer-events-none select-none"
            style={{ left: 105, bottom: -17, width: 37, zIndex: 3 }} />
        </>
      )}

      {/* ── CONTENT ── */}
      <div ref={containerRef} className="relative flex flex-col h-full" style={{ zIndex: 2 }}>

        {/* ── TOP BAR ── */}
        <div className="shrink-0 relative flex items-center justify-between px-5" style={{ height: 40, paddingTop: 11, zIndex: 10 }}>
          {isReview ? (
            <button onClick={onExitReview} className="w-[18px] h-[18px] flex items-center justify-center active:scale-90">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2A2A2A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleOpenCategories}
              className="w-[36px] h-[36px] active:scale-90"
            >
              <img src="/assets/figma/category-btn.png" alt="分类" className="w-full h-full object-contain" />
            </button>
          )}

          <span className="text-[14px] text-[#999]">{counterText}</span>
        </div>

        {/* ── IMAGE AREA (Format A only) ── */}
        {showBigImage && (
          <div className="shrink-0 flex justify-center" style={{ paddingTop: imgPadTop, marginTop: imgMarginTop }}>
            <div className="relative" style={{ width: imgSize, height: imgSize }}>
              <div
                className={`absolute inset-0 overflow-hidden ${isReview ? 'border-2 border-black' : ''}`}
                style={{ borderRadius: imgRadius }}
              >
                <img
                  src={`/images/${encodeURIComponent(currentWord.img)}`}
                  alt={displayWord}
                  className="w-full h-full object-cover"
                />
              </div>
              {!isReview && (
                <img
                  src="/assets/figma/pic_square_wrapper_clean.png"
                  alt=""
                  className="absolute pointer-events-none select-none"
                  style={{
                    top: frameTop, left: frameLeft,
                    width: frameW, height: frameH,
                    maxWidth: 'none', zIndex: 1,
                  }}
                />
              )}
            </div>
          </div>
        )}

        {/* ── WORD INFO ── */}
        <div className="shrink-0 flex flex-col items-center px-6" style={{
          minHeight: showBigImage ? wordInfoMinH : Math.round(responsive2(130, 105, 82)),
          paddingTop: showBigImage ? wordInfoPadTop : Math.round(responsive2(66, 24, 16)),
          paddingBottom: wordInfoPadBot,
        }}>
          {/* Main word display */}
          <span
            className="leading-tight text-textMain text-center"
            style={{
              fontSize: wordTextFS,
              fontFamily: targetFont,
              fontWeight: 900,
            }}
          >
            {displayWord.toLowerCase()}
          </span>

          {/* Speaker + phonetic / reading */}
          <button
            onClick={handleSpeak}
            className="flex items-center gap-1.5 mt-[6px] text-[#999] active:scale-95"
          >
            <img src="/assets/figma/icon-speaker.svg" alt="发音" style={{ width: 19, height: 15, flexShrink: 0 }} />
            {phonetic && (
              <span style={{ fontSize: phoneticFS, fontFamily: isTargetJa ? '"Hiragino Sans", sans-serif' : 'inherit' }} className="text-center">
                {phonetic}
              </span>
            )}
          </button>

          {/* Example sentence */}
          <p
            className="text-textMain text-center leading-snug"
            style={{
              marginTop: showBigImage ? 5 : 2,
              fontSize: sentenceFS,
              fontWeight: 'normal',
              // Use a readable normal-weight font (not Arial Black which is ultra-bold)
              fontFamily: sentenceLang === 'en' ? 'Arial, sans-serif' : getFontFamily(sentenceLang),
            }}
          >
            {displaySentence}
          </p>

          {/* Translation — always visible in format A; cover in other formats */}
          {sentenceLang !== nativeLang && (
            quizFormat === 'A' ? (
              <span
                className="mt-[5px] text-center leading-none px-2"
                style={{ fontSize: translationFS, color: sentenceTranslation ? '#555' : '#bbb', minHeight: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                {sentenceTranslation || t.translating}
              </span>
            ) : (
              <button
                onClick={() => setShowSentence(tt => !tt)}
                className="mt-[8px] flex items-center justify-center active:scale-95"
                style={{ minWidth: 234, height: 24, flexShrink: 0 }}
              >
                {showSentence ? (
                  <span style={{ fontSize: translationFS, color: sentenceTranslation ? '#555' : '#bbb' }} className="text-center leading-none px-2">
                    {sentenceTranslation || t.translating}
                  </span>
                ) : (
                  <div className="rounded-sm" style={{
                    width: 268, height: 24,
                    background: isReview
                      ? 'linear-gradient(90deg, #ffffff 0%, #e0feb1 48%, #ffffff 100%)'
                      : 'linear-gradient(90deg, #fffdf4 0%, #ffd9ba 48%, #fffdf5 100%)',
                  }} />
                )}
              </button>
            )
          )}
        </div>

        {/* ── SPACER ── */}
        <div className="flex-1 min-h-0" />

        {/* ── CHOICES AREA (uniformly scaled) ── */}
        <div className="shrink-0" style={{
          height: (quizFormat === 'B' ? IMG_CHOICES_H : TEXT_CHOICES_H) * choiceScale,
          position: 'relative', zIndex: 4, overflow: 'visible',
        }}>
         <div style={{
           transform: choiceScale < 0.995 ? `scale(${choiceScale})` : undefined,
           transformOrigin: 'top center',
         }}>
          <div className="relative px-[15px]" style={{ paddingTop: choicesPadTop, paddingBottom: 30 }}>

          {/* 2 x 2 grid: image choices (B) or text choices (A/C) */}
          {quizFormat === 'B' ? (
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
                        backgroundColor: isThisCorrect ? '#D4F0A9' : isThisWrong ? '#FAD2CC' : '#ffffff',
                        transition: 'background-color 0.15s',
                      }}
                    >
                      <img
                        src={`/images/${encodeURIComponent(optWord.img)}`}
                        alt=""
                        className="w-full h-full object-cover"
                        style={{ opacity: isThisWrong ? 0.35 : 1, transition: 'opacity 0.15s' }}
                      />
                    </div>
                    {/* pic-container decoration frame */}
                    <img
                      src="/assets/figma/pic-container.png"
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
                      <img src="/assets/figma/word-decor.png" alt=""
                        className="absolute pointer-events-none select-none"
                        style={{ left: 15, top: -26, width: 52, zIndex: 5 }} />
                    )}
                    {/* Leaf decor on bottom-right cell */}
                    {idx === 3 && !isReview && showCatDecor && (
                      <img src="/assets/figma/word-decor-2.png" alt=""
                        className="absolute pointer-events-none select-none"
                        style={{ right: -18, top: -7, width: 35, zIndex: 5 }} />
                    )}
                    {/* Background card */}
                    <div
                      className="absolute rounded-[8px]"
                      style={{
                        left: 2, right: 2, top: 3, bottom: 3,
                        backgroundColor: isThisCorrect ? '#D4F0A9' : isThisWrong ? '#FAD2CC' : '#ffffff',
                        transition: 'background-color 0.15s',
                      }}
                    />
                    {/* Decoration frame */}
                    <img
                      src={quizFormat === 'C' ? '/assets/figma/text-container.png' : '/assets/figma/choice-btn.png'}
                      alt=""
                      className="absolute inset-0 w-full h-full pointer-events-none select-none object-fill"
                      style={{ zIndex: 1 }}
                    />
                    {/* Clickable button */}
                    <button
                      onClick={() => handleOptionClick(option)}
                      disabled={!!isCorrect || isThisWrong}
                      className="absolute inset-0 flex items-center justify-center rounded-[8px] text-textMain font-normal"
                      style={{ fontSize: 20, zIndex: 2, transition: 'none' }}
                    >
                      {option}
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
                src="/assets/figma/skip-btn.png"
                alt=""
                className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
              />
              <button
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

      {/* ── CATEGORY MODAL ── */}
      {showCategories && (
        <div className="absolute inset-0 flex flex-col" style={{ zIndex: 50 }}>
          <div
            className="bg-white px-6 pt-2 pb-5 shadow-lg"
            style={{ animation: 'categoryExpand 0.25s ease-out', transformOrigin: 'top left' }}
          >
            <button
              onClick={() => setShowCategories(false)}
              className="w-[30px] h-[30px] mb-4 active:scale-90"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2A2A2A" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>

            <div className="relative mb-4">
              <select
                value={pendingLevel}
                onChange={(e) => setPendingLevel(e.target.value)}
                className="w-full appearance-none bg-white border-2 border-black rounded-full px-4 text-[14px] font-medium text-textMain focus:outline-none"
                style={{ height: 34 }}
              >
                {LEVELS.map(l => (
                  <option key={l} value={l}>
                    {l === 'all' ? t.allLevels : `${t.levelPrefix}: ${LEVEL_LABELS[l]}`}
                  </option>
                ))}
              </select>
              <svg className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none" width="14" height="10" viewBox="0 0 14 10" fill="none" stroke="#2A2A2A" strokeWidth="2">
                <polyline points="1 1 7 7 13 1" />
              </svg>
            </div>

            <div className="flex flex-wrap gap-2.5 mb-4">
              {categories.map((cat) => {
                const isSelected = pendingCategory === cat;
                const bgColor = isSelected
                  ? '#1b1b1b'
                  : cat === 'all' ? '#ffffff' : tagColorMap[cat];
                return (
                  <button
                    key={cat}
                    onClick={() => setPendingCategory(cat)}
                    className="px-4 rounded-full text-[14px] font-medium border-2 border-black"
                    style={{
                      height: 32,
                      backgroundColor: bgColor,
                      color: isSelected ? '#ffffff' : '#000000',
                      lineHeight: '28px',
                    }}
                  >
                    {catLabels[cat]}
                  </button>
                );
              })}
            </div>

            <div className="flex justify-center">
              <button
                onClick={handleConfirmCategories}
                className="flex items-center justify-center active:scale-95 border-2 border-black rounded-full"
                style={{
                  width: 130, height: 39,
                  backgroundColor: '#ffd016',
                }}
              >
                <span className="text-[18px] font-normal text-black">{t.ok}</span>
              </button>
            </div>
          </div>

          <div
            className="flex-1"
            style={{ backgroundColor: 'rgba(0,0,0,0.3)', animation: 'fadeIn 0.2s ease-out' }}
            onClick={() => setShowCategories(false)}
          />
        </div>
      )}
    </div>
  );
}
