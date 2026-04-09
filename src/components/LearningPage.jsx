import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { words, wordsShuffled, categories } from '../data/words';
import { jaData } from '../data/jaData';
import { oralPhrases, oralPhrasesShuffled, oralCategories, ORAL_CATEGORY_LABELS } from '../data/oralPhrases';
import { vocabCategoryCovers, oralCategoryCovers } from '../data/categoryCovers';
import { speakWordByLang, playCorrectSound, playWrongSound, playSlaySound } from '../hooks/useAudio';
import { getProgress, markWordLearned, toggleStar, toggleMastered, saveProgress, updateWordSRS, getReviewWordStates, saveReviewWordStates } from '../utils/storage';
import {
  getWordText, getSentence, getPhonetic, isWordAvailable,
  getTranslationPair, getFontFamily, UI_TEXT, CATEGORY_LABELS,
} from '../utils/langHelpers';
import {
  getDueReviewWords, calcBudget, buildInterleaved, getInterval,
  getReviewFormat, SESSION_GAPS, SESSION_FORMATS, D_KNOW_GAP,
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

const LEVELS = ['all', 'beginner', 'intermediate', 'advanced', 'oral'];
const LEVEL_LABELS = { all: '全部难度', beginner: 'Level 1', intermediate: 'Level 2', advanced: 'Level 3' };
const ORAL_LEVEL_LABEL = { zh: '口语', en: 'Speaking', ja: '会話' };
const TAG_COLORS_BASE = ['#e3ffbb', '#ecf7ff', '#fffcda', '#fff0f6'];

// Tab labels for category modal
const CATEGORY_TAB_LABELS = {
  zh: { level: '难度', detail: '主题', oral: '口语' },
  en: { level: 'Level', detail: 'Themes', oral: 'Speaking' },
  ja: { level: '難易度', detail: 'テーマ', oral: '会話' },
};

// Category cover images are auto-generated in src/data/categoryCovers.js
// from the "Cover For" column in update_data_folder/Vocab_Confirmed.xlsx.

// Module-level cache for sentence translations (persists for session)
const _sentenceCache = new Map();

export default function LearningPage({
  isReview = false, onExitReview, onGoToStarred,
  nativeLang = 'zh', targetLang = 'en',
  selectedCategory = 'all', selectedLevel = 'beginner',
  onCategoryChange, onLevelChange,
  isVisible = true,
  contentHFromParent,
  onCategoryModalChange,
}) {
  const langKey = `${nativeLang}_${targetLang}`; // for session identity + sentence cache
  const storageKey = targetLang; // progress keyed by target language only
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
  const [categoryTab, setCategoryTab] = useState('level'); // 'level' | 'detail' | 'oral'
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

  // Derived: quizFormat and currentWord — oral mode uses C/D (text only, no images)
  const rawFormat = isReview ? (reviewCard?.format || 'B') : (srsCard?.format || 'A');
  const quizFormat = isOralMode ? (rawFormat === 'D' ? 'D' : 'C') : rawFormat;
  // Current step: 0 = first encounter (new), 1+ = session review
  const currentStep = isReview ? null : (srsCard?.step ?? 0);

  // All words available for this language pair (for reviews & option generation)
  const allWordsFiltered = useMemo(() => {
    return activeWords.filter(w => isWordAvailable(w, nativeLang, targetLang));
  }, [nativeLang, targetLang, isOralMode]);

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

  // Measure container height for responsive layout
  useLayoutEffect(() => {
    const measure = () => {
      if (containerRef.current) {
        setContentH(containerRef.current.offsetHeight);
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);


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
  const imgPadTop = Math.max(10, Math.round(responsive2(22, 10, 10)));
  // Frame decoration scales proportionally with image
  const frameTop = Math.round(-16 * imgScale);
  const frameLeft = Math.round(-45 * imgScale);
  const frameW = imgSize + Math.round(77 * imgScale);
  const frameH = imgSize + Math.round(47 * imgScale);
  const imgRadius = Math.round(20 * imgScale);

  // Font sizes: 24 / 16 / 14px base; scale ~80% only at very short screens
  // CJK (zh/ja) text gets -2px for visual balance
  const isCJK = (lang) => lang === 'zh' || lang === 'ja';
  const wordTextFS = Math.round(responsive2(24, 24, 19)) - (isCJK(targetLang) ? 2 : 0);
  const phoneticFS = Math.round(responsive2(16, 16, 13));
  const sentenceFS_base = Math.round(responsive2(16, 16, 13));
  const translationFS_base = Math.round(responsive2(15, 15, 11));


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
  const showCatDecor = contentH >= 550;        // cat on choices (hide only on very short screens)
  const showBigNavDecor = contentH >= FULL_H;  // large nav scene → frog when adapting
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
    let pool = selectedCategory === 'all' ? activeWordsShuffled : activeWords.filter(w => w.category === selectedCategory);
    pool = pool.filter(w => isWordAvailable(w, nativeLang, targetLang));
    if (selectedLevel !== 'all' && selectedLevel !== 'oral') pool = pool.filter(w => w.level === selectedLevel);
    return shuffle(pool.filter(w => prog[w.id] && !prog[w.id].mastered));
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
    completedCatNameRef.current = catLabels[selectedCategory] || '';
    setCategoryDoneVisible(true);

    categoryAutoSwitchRef.current = setTimeout(() => {
      categoryAutoSwitchRef.current = null;
      setCategoryDoneVisible(false);
      const progNow = getProgress(storageKey);

      // If under a specific category (detail or oral), find the next category with unlearned words
      if (selectedCategory !== 'all') {
        const catList = isOralMode
          ? oralCategories.filter(c => c !== 'all')
          : categories.filter(c => c !== 'all');
        const currentIdx = catList.indexOf(selectedCategory);
        // Search from after current, then wrap around
        const ordered = [...catList.slice(currentIdx + 1), ...catList.slice(0, currentIdx)];
        const nextCat = ordered.find(cat => {
          return allWordsFiltered.some(w => w.category === cat && !progNow[w.id]?.timestamp);
        });
        if (nextCat) {
          onCategoryChange?.(nextCat);
          onLevelChange?.(selectedLevel);
          resetSrsSession();
          return;
        }
      }

      // Fallback: switch to 'all' if no next category found
      const hasUnlearnedAtLevel = selectedLevel === 'all' || selectedLevel === 'oral'
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

  const isWordStarred = useMemo(() => {
    if (!currentWord) return false;
    return progress[currentWord.id]?.starred === true;
  }, [currentWord, progress]);

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
  }, [currentWord?.id, quizFormat]);

  // Phonetics (skip for oral phrases)
  useEffect(() => {
    if (!currentWord || isOralMode) { setPhonetic(''); return; }
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
      const jaSentence = jaData[currentWord.en]?.sentence;
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
      setShowSentence(true); // auto-reveal translation on wrong answer
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
      setShowSentence(true); // auto-reveal translation on wrong answer
    }
  }, [currentWord, isCorrect, advanceToNext, triggerAnim]);

  // ── D mode handlers ──
  const handleDKnow = useCallback(() => {
    if (!currentWord) return;
    triggerAnim('dKnow');
    playCorrectSound();
    dModeResultRef.current = 'know';
    autoAdvanceTimer.current = setTimeout(advanceToNext, 600);
  }, [currentWord, advanceToNext, triggerAnim]);

  const handleDDontKnow = useCallback(() => {
    if (!currentWord) return;
    triggerAnim('dDontKnow');
    playWrongSound();
    dModeResultRef.current = 'dontknow';
    // Show the answer briefly: reveal the sentence translation, then advance
    setShowSentence(true);
    autoAdvanceTimer.current = setTimeout(advanceToNext, 1200);
  }, [currentWord, advanceToNext, triggerAnim]);

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
    let pool = selectedCategory === 'all' ? [...activeWords] : activeWords.filter(w => w.category === selectedCategory);
    pool = pool.filter(w => isWordAvailable(w, nativeLang, targetLang));
    if (selectedLevel !== 'all' && selectedLevel !== 'oral') pool = pool.filter(w => w.level === selectedLevel);
    const total = pool.length;
    const learned = pool.filter(w => progress[w.id]?.timestamp).length;
    return `${learned}/${total}`;
  }, [isReview, reviewCard, currentWord, selectedCategory, selectedLevel, nativeLang, targetLang, progress]);

  const handleOpenCategories = useCallback(() => {
    setPendingCategory(selectedCategory);
    setPendingLevel(selectedLevel);
    // Set initial tab based on current mode, with current selection preserved
    if (selectedLevel === 'oral') {
      setCategoryTab('oral');
    } else if (selectedCategory !== 'all') {
      setCategoryTab('detail');
    } else {
      setCategoryTab('level');
      // If current level is 'all', auto-select first level so something is checked
      if (selectedLevel === 'all') setPendingLevel('beginner');
    }
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
    : pendingLevel === 'oral'
      ? (ORAL_LEVEL_LABEL[nativeLang] || ORAL_LEVEL_LABEL.zh)
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
      <div ref={containerRef} className="relative flex flex-col h-full" style={{
        zIndex: 2,
        paddingBottom: (quizFormat === 'B' ? IMG_CHOICES_H : TEXT_CHOICES_H) * choiceScale,
      }}>

        {/* ── TOP BAR ── */}
        <div className="shrink-0 relative flex items-center justify-between px-5" style={{ height: 40, paddingTop: 11, zIndex: 10 }}>
          {isReview ? (
            <button onClick={onExitReview} className="w-[27px] h-[27px] flex items-center justify-center active:scale-90">
              <img src="/assets/figma/back-button.png" alt="返回" className="w-full h-full object-contain" />
            </button>
          ) : (
            <button
              onClick={handleOpenCategories}
              className="w-[30px] h-[30px] active:scale-90"
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

        {/* ── WORD INFO TOP SPACER (shrinks when sentence is long, so content moves up) ── */}
        <div style={{ flexShrink: 1, height: showBigImage ? 36 : 96, minHeight: 0 }} />

        {/* ── WORD INFO ── */}
        <div className="shrink-0 flex flex-col items-center px-6" style={{
          paddingBottom: 4,
          overflow: 'visible',
          zIndex: 5,
        }}>
          {/* Main word display */}
          <span
            className="text-textMain text-center"
            style={{
              fontSize: wordTextFS,
              fontFamily: targetFont,
              fontWeight: 900,
              lineHeight: isCJK(targetLang) ? 1.5 : 1.25,
            }}
          >
            {displayWord.toLowerCase()}
          </span>

          {/* Speaker + phonetic / reading */}
          <button
            onClick={handleSpeak}
            className="flex items-center gap-1.5 text-[#999] active:scale-95"
            style={{ marginTop: 5 }}
          >
            <img src="/assets/figma/icon-speaker.svg" alt="发音" style={{ width: 19, height: 15, flexShrink: 0 }} />
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
                marginTop: 6,
                fontSize: sentenceFS_base - (isCJK(sentenceLang) ? 2 : 0),
                fontWeight: 'normal',
                lineHeight: isCJK(sentenceLang) ? 1.5 : 1.25,
                fontFamily: sentenceLang === 'en' ? 'Arial, sans-serif' : getFontFamily(sentenceLang),
              }}
            >
              {displaySentence}
            </p>
          )}

          {/* Translation — always visible in format A (& oral C step 0); cover in B/C; hidden in D */}
          {displaySentence && quizFormat !== 'D' && needsTranslation && (
            quizFormat === 'A' || (isOralMode && quizFormat === 'C' && currentStep === 0) ? (
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
                    background: isReview
                      ? 'linear-gradient(90deg, #ffffff 0%, #e0feb1 48%, #ffffff 100%)'
                      : 'linear-gradient(90deg, #fffdf4 0%, #ffd9ba 48%, #fffdf5 100%)',
                  }} />
                )}
              </button>
            )
          )}
        </div>

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
          <div className="relative px-[15px]" style={{ paddingTop: choicesPadTop, paddingBottom: 30 }}>

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
                      <img src="/assets/figma/word-decor.png" alt=""
                        className="absolute pointer-events-none select-none"
                        style={{ left: 15, top: -26, width: 52, zIndex: 5 }} />
                    )}
                    {/* Background card */}
                    <div
                      className="absolute rounded-[8px]"
                      style={{
                        left: 2, right: 2, top: 3, bottom: 3,
                        backgroundColor: isKnowFlash ? '#D4F0A9' : isDontKnowFlash ? '#FAD2CC' : '#ffffff',
                        transition: 'background-color 0.15s',
                      }}
                    />
                    {/* Decoration frame — same as C mode */}
                    <img
                      src="/assets/figma/text-container.png"
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
                      style={{ fontSize: 17, zIndex: 2, padding: 10, transition: 'none' }}
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

      {/* ── CATEGORY MODAL (full-page, Figma redesign) ── */}
      {showCategories && (() => {
        const tabLabels = CATEGORY_TAB_LABELS[nativeLang] || CATEGORY_TAB_LABELS.zh;
        const jaInvolved = nativeLang === 'ja' || targetLang === 'ja';
        const tabs = jaInvolved
          ? [{ key: 'level', label: tabLabels.level }, { key: 'detail', label: tabLabels.detail }]
          : [{ key: 'level', label: tabLabels.level }, { key: 'detail', label: tabLabels.detail }, { key: 'oral', label: tabLabels.oral }];
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
        const renderCatCard = (key, imgSrc, label, isSelected, onClick, prog, decor = {}) => {
          const { hasLetter = false, hasStar = false, starAtTR = false } = decor;
          return (
          <button key={key} onClick={onClick} className="relative flex flex-col items-center active:scale-95" style={{ overflow: 'visible' }}>
            <div style={{
              position: 'relative',
              width: 102, boxSizing: 'border-box', backgroundColor: '#fbf2e2',
              border: `2px solid ${isSelected ? '#ffd016' : '#000'}`,
              borderRadius: 10, display: 'flex', flexDirection: 'column', alignItems: 'center',
              padding: '4px 6px 8px',
            }}>
              {/* Letter decoration — top-right corner, rotated 38.7deg (Figma 402:418) */}
              {hasLetter && (
                <div className="pointer-events-none select-none" style={{
                  position: 'absolute', right: -8, top: -11,
                  width: 24, height: 24,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  zIndex: 3,
                }}>
                  <img src="/assets/figma/frame-decor-letter.png" alt=""
                    style={{ width: 18, height: 15, display: 'block', transform: 'rotate(38.7deg)' }} />
                </div>
              )}
              {/* Star decoration — BL or TR corner, rotated -50.81deg (Figma 425:231) */}
              {hasStar && (
                <div className="pointer-events-none select-none" style={{
                  position: 'absolute',
                  ...(starAtTR ? { right: -9, top: -11 } : { left: -9, bottom: -11 }),
                  width: 29, height: 29,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  zIndex: 3,
                }}>
                  <img src="/assets/figma/frame-decor-stas.png" alt=""
                    style={{ width: 20, height: 21, display: 'block', transform: 'rotate(-50.81deg)' }} />
                </div>
              )}
              {/* Category image */}
              <div style={{ width: 90, height: 90, borderRadius: 10, overflow: 'hidden', backgroundColor: '#e8dcc8', flexShrink: 0 }}>
                {imgSrc ? (
                  <img src={imgSrc} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: 44, lineHeight: 1 }}>{key === 'beginner' ? '1' : key === 'intermediate' ? '2' : key === 'advanced' ? '3' : ''}</span>
                  </div>
                )}
              </div>
              {/* Progress bar */}
              <div style={{
                width: 75, height: 12, borderRadius: 100,
                backgroundColor: '#f0dac2', border: '1.5px solid #000',
                marginTop: 10, position: 'relative', overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', borderRadius: 100, backgroundColor: '#ffcc00',
                  width: prog.total > 0 ? `${(prog.learned / prog.total) * 100}%` : '0%',
                }} />
              </div>
              {/* Progress text */}
              <span style={{ fontSize: 12, fontWeight: 500, color: '#000', marginTop: 2, lineHeight: '18px' }}>
                {prog.learned}/{prog.total}
              </span>
              {/* Category label */}
              <span style={{ fontSize: 12, fontWeight: 500, color: '#000', marginTop: 1, lineHeight: '18px', textAlign: 'center' }}>
                {label}
              </span>
            </div>
            {/* Selection check badge — sits above corner decorations, at the very corner */}
            {isSelected && (
              <div style={{
                position: 'absolute', top: -8, right: -8,
                width: 22, height: 22, borderRadius: '50%',
                backgroundColor: '#ffd016', border: '2px solid #000',
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
          <div className="absolute inset-0 flex flex-col overflow-hidden" style={{ zIndex: 50, backgroundColor: '#faf2e2' }}>
            {/* Content layer — fixed shell */}
            <div className="relative flex flex-col h-full">

              {/* ── Fixed top: Blue header bar ── */}
              <div className="shrink-0" style={{
                backgroundColor: '#646464', borderBottom: '2px solid #000',
                padding: '17px 16px 14px', position: 'relative', zIndex: 3,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              }}>
                <button
                  onClick={() => setShowCategories(false)}
                  className="flex items-center justify-center active:scale-90"
                  style={{ position: 'absolute', left: 19, top: '50%', transform: 'translateY(-50%)', width: 27, height: 27 }}
                >
                  <img src="/assets/figma/back-button.png" alt="返回" className="w-full h-full object-contain" />
                </button>
                {tabs.map(tab => {
                  const isActive = categoryTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      onClick={() => {
                        if (categoryTab !== tab.key) {
                          setCategoryTab(tab.key);
                          if (tab.key === 'level') { setPendingLevel('beginner'); setPendingCategory('all'); }
                          else if (tab.key === 'detail') { setPendingCategory(categories.find(c => c !== 'all') || 'animal'); setPendingLevel('all'); }
                          else if (tab.key === 'oral') { setPendingCategory(oralCats[0] || 'everyday'); setPendingLevel('oral'); }
                        }
                      }}
                      style={{
                        width: tabWidth, height: 32, paddingLeft: 16, paddingRight: 16,
                        borderRadius: 8, border: '1.5px solid #000',
                        backgroundColor: isActive ? '#FFD016' : '#fbf2e2',
                        color: '#000',
                        fontSize: 14, fontWeight: 500, lineHeight: '20px', letterSpacing: 0.1,
                      }}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              {/* Dog mascot decoration overlapping header */}
              <img src="/assets/figma/categroy-decor-3.png" alt="" className="pointer-events-none"
                style={{ position: 'absolute', left: 14, top: 48, width: 43, height: 58, zIndex: 2 }} />

              {/* ── Middle: Bordered content frame (outer fixed, inner scrollable) ── */}
              <div className="flex-1 relative overflow-hidden" style={{
                margin: '20px 13px 10px',
                border: '2px solid #000', borderRadius: 10,
              }}>
                {/* Beach background image inside the frame */}
                <img
                  src="/assets/figma/category-bg.png" alt=""
                  className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                  style={{ zIndex: 0 }}
                />

                {/* Scrollable card area inside the frame */}
                <div className="relative h-full overflow-y-auto" style={{ zIndex: 1, WebkitOverflowScrolling: 'touch', padding: '14px 12px 18px' }}>

                  {/* === LEVEL TAB === */}
                  {categoryTab === 'level' && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 13, justifyContent: 'flex-start' }}>
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
                  {categoryTab === 'detail' && (
                    <>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 13, justifyContent: 'flex-start' }}>
                        {detailCats.map((cat, idx) => {
                          const isSelected = pendingCategory === cat && categoryTab === 'detail';
                          const imgFile = vocabCategoryCovers[cat] || dynamicCatImages[cat];
                          const pool = vocabPool.filter(w => w.category === cat);
                          const prog = getCatProgress(pool);
                          const rowIdx = Math.floor(idx / 3);
                          const colIdx = idx % 3;
                          const row = getRowDecor(`detail-${rowIdx}`);
                          const decor = {
                            hasLetter: row.letterIdx === colIdx,
                            hasStar: row.starIdx === colIdx,
                            starAtTR: row.starAtTR,
                          };
                          return renderCatCard(
                            cat,
                            imgFile ? `/images/${encodeURIComponent(imgFile)}` : null,
                            detailCatLabels[cat], isSelected,
                            () => { setPendingCategory(cat); setPendingLevel('all'); },
                            prog, decor,
                          );
                        })}
                      </div>
                    </>
                  )}

                  {/* === ORAL TAB === */}
                  {categoryTab === 'oral' && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 13, justifyContent: 'flex-start' }}>
                      {oralCats.map((cat, idx) => {
                        const isSelected = pendingCategory === cat && categoryTab === 'oral';
                        const imgFile = oralCategoryCovers[cat];
                        const pool = oralPhrases.filter(w => w.category === cat);
                        const prog = getCatProgress(pool);
                        const rowIdx = Math.floor(idx / 3);
                        const colIdx = idx % 3;
                        const row = getRowDecor(`oral-${rowIdx}`);
                        const decor = {
                          hasLetter: row.letterIdx === colIdx,
                          hasStar: row.starIdx === colIdx,
                          starAtTR: row.starAtTR,
                        };
                        return renderCatCard(
                          cat,
                          imgFile ? `/images/${encodeURIComponent(imgFile)}` : null,
                          oralCatLabels[cat], isSelected,
                          () => { setPendingCategory(cat); setPendingLevel('oral'); },
                          prog, decor,
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* ── Fixed bottom: decorations + confirm button ── */}
              {/* zIndex: 3 so the rabbit ears (decor-1) and decor-2 stay on top
                  of the scrollable card grid above, which lives in a z-index:1
                  stacking context. Without this, on short screens the rabbit's
                  ears get covered by category cards extending down. */}
              <div className="shrink-0 relative flex justify-center" style={{ paddingTop: 6, paddingBottom: 20, zIndex: 3 }}>
                {/* Decorations */}
                <img src="/assets/figma/categroy-decor-1.png" alt="" className="pointer-events-none"
                  style={{ position: 'absolute', left: 13, bottom: 16, width: 71, height: 112 }} />
                <img src="/assets/figma/categroy-decor-2.png" alt="" className="pointer-events-none"
                  style={{ position: 'absolute', right: 15, bottom: 20, width: 40, height: 57 }} />
                <button
                  onClick={handleConfirmCategories}
                  className="flex items-center justify-center active:scale-95"
                  style={{
                    width: 158, height: 51, borderRadius: 100,
                    backgroundColor: '#ffd016', border: '2px solid #000',
                    position: 'relative', zIndex: 1,
                    transform: 'translateX(11px)',
                  }}
                >
                  <span style={{ fontSize: 24, fontWeight: 400, color: '#000' }}>{t.ok}</span>
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
