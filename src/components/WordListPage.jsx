import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { words, categories as wordCategories } from '../data/words';
import { oralPhrases, oralCategories, ORAL_CATEGORY_LABELS } from '../data/oralPhrases';
import { devPhrases } from '../data/devPhrases';
import { jaData } from '../data/jaData';
import { canSwitchLanguageFreely } from '../config/languageWhitelist';
import { getProgress, saveProgress, toggleMastered } from '../utils/storage';
import { useCustomWords, addCustomWords, clearDraft } from '../utils/customWords';
import { speakWordByLang, speakDevPhrase, preloadAudioManifest } from '../hooks/useAudio';

// 进阶 (dev) phrases use a dedicated audio namespace, not the shared 'en' audio —
// route them to speakDevPhrase or they fall back to (ugly) browser TTS.
function speakWordOrDev(word, text, targetLang) {
  if (word?.level === 'dev') speakDevPhrase(text);
  else speakWordByLang(text, targetLang);
}
import RubyText, { stripRuby } from './RubyText';
import {
  getWordText, getSentence, getPhonetic, isWordAvailable,
  getTranslationPair, getFontFamily, UI_TEXT, LANGUAGES, getLangName,
  CATEGORY_LABELS,
} from '../utils/langHelpers';
import { usePostHog } from '@posthog/react';
import { getFigmaAssetUrl, getImageUrl } from '../utils/assetUrl';
import { MODAL_SCRIM, MODAL_CARD, SCROLL_HIDE } from '../general-ui/popKit.jsx';
import { useScrollWatch, SlimScrollBar, ScrollTopButton } from '../general-ui/scrollKit.jsx';
import { Icon } from '../general-ui/icons.jsx';
import { YELLOW } from '../general-ui/config.js';
import AddCustomWordsModal from './AddCustomWordsModal';

// Look up a sentence in `lang` from the word's static data (Excel / jaData).
function getStaticSentence(word, lang) {
  if (!word) return '';
  if (lang === 'zh') return word.sentenceZh || '';
  if (lang === 'en') return word.sentence || '';
  if (lang === 'ja') return word.jaSentence || jaData[word.en]?.sentence || '';
  return '';
}

// Translation cache persists for speed — keyed by wordId_langKey
const _translationCache = new Map();

function prefetchTranslation(word, targetLang, nativeLang, onDone) {
  // 自定义词组：例句是用户自己打的英文句，用户明确说了不要中文例句、也不要
  // 自动翻译 —— 那就连这次第三方请求都不发。
  if (word?.custom) return;
  let sentence = getSentence(word, targetLang);
  let sentenceLang = targetLang;
  if (!sentence && targetLang === 'zh') {
    sentence = word.sentence || '';
    sentenceLang = 'en';
  }
  if (!sentence || sentenceLang === nativeLang) return;
  const cacheKey = `${word.id}_${nativeLang}_${targetLang}`;
  if (_translationCache.has(cacheKey)) return;
  // Prefer the Excel / jaData sentence in the native language — skip the API if it exists.
  const staticT = getStaticSentence(word, nativeLang);
  if (staticT) {
    _translationCache.set(cacheKey, staticT);
    onDone(cacheKey, staticT);
    return;
  }
  const langpair = getTranslationPair(sentenceLang, nativeLang);
  fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(sentence)}&langpair=${langpair}`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      const t = data?.responseData?.translatedText;
      if (t && t !== sentence) {
        _translationCache.set(cacheKey, t);
        onDone(cacheKey, t);
      }
    })
    .catch(() => {});
}

// 随机顺序 = 按「词 id + 种子」算出来的固定排序号，不是当场 Math.random() 洗牌。
// 列表是从 progress 现算的，掌握掉一个词就会换来一个新的 progress 对象、
// useMemo 重跑一遍；以前重跑就等于重新洗一次牌，剩下的词全部换位置——用户看到的
// 就是「挪走一个词，整张列表刷新了」。
// 排序号只跟 (id, seed) 有关，跟列表长度无关，所以拿掉一个词，剩下的词彼此的
// 先后完全不变：那个词自己滑走，别人各就各位。想换一批顺序只有一个途径 ——
// 用户自己去点「随机 / 反向随机」（randomKey +1）。
// 注意别改回 seeded Fisher-Yates：同一个种子，长度 N 和 N-1 洗出来的顺序是两回事。
function shuffleSeedOf(id, seed) {
  let h = ((seed >>> 0) ^ 0x9e3779b9) >>> 0;
  const str = String(id);
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  }
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}

function stableShuffle(list, seed) {
  return list.sort((a, b) => {
    const d = shuffleSeedOf(a.id, seed) - shuffleSeedOf(b.id, seed);
    return d !== 0 ? d : String(a.id) < String(b.id) ? -1 : 1;
  });
}

// 音标/读音只认数据里标注过的那一份（Excel 的 ipa 列 → phoneticMap → 日文
// jaReading / 中文 pinyin），全部走 getPhonetic 这一个入口。
// 没标注的（进阶短语等）返回空 → pop 里干脆不显示音标。
// 旧写法是拿 dictionaryapi.dev 按空格把词组拆开逐词去查、谁先查到算谁的，而且
// 只传了 word.en 进来（口语短语自带的 ipa 根本用不上），于是
// "Have a falling-out" 会顶着 a 的音标 /æɪ/。宁可不显示，也不显示错的。
function getWordPhonetic(word, targetLang) {
  if (!word) return '';
  return getPhonetic(word, targetLang) || '';
}

// á → a, ō → o: pinyin tones and romaji macrons folded away, because nobody
// types them into a search box.
function foldMarks(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
}

// Everything one row can be found by, flattened into a single lowercase string.
// Ruby-annotated text goes in TWICE: opened up (`<ruby>遊<rt>あそ</rt></ruby>ぶ`
// → `遊 あそ ぶ`) so the furigana is searchable, and stripped (`遊ぶ`) so typing
// the whole word still matches — opened-up alone breaks the word in half.
// The phonetic column joins them folded, which is what lets a learner who
// can't type kana or hanzi yet find 玩 by "wan" and こんにちは by "konnichiwa".
// Only fields the user can actually read somewhere are indexed — matching on
// data they never see makes a hit look like a bug.
function searchHaystack(word, nativeLang, targetLang) {
  const target = getWordText(word, targetLang) || '';
  const native = getWordText(word, nativeLang) || '';
  const phonetic = getPhonetic(word, targetLang) || '';
  // Each variant only earns a slot when it actually differs — most rows have no
  // ruby and no tone marks, and a doubled string is just index to scan.
  const alt = (s) => { const p = stripRuby(s); return p === s ? '' : p; };
  const folded = foldMarks(phonetic);
  return [
    target, alt(target),
    native, alt(native),
    phonetic, folded === phonetic ? '' : folded,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/<[^>]*>/g, ' ')
    .toLowerCase();
}

/* ── Tab memory ──────────────────────────────────────────────────
 * 主 tab（词汇图鉴/时间/随机/反向随机/已斩单词）和它底下的子 tab（单词/短语/
 * 进阶）都记住用户上次的选择 —— 退出去再进单词本，还是原来那一套配置。
 * 只有用户手点才写进 storage。自动回落（进阶权限没了）必须传
 * { persist: false }：开屏那一帧 userEmail 还是空的、devUnlocked 判定为
 * false，一次误判就会把用户存的「进阶」永久抹成「单词」（2026-07-28 主题+tab
 * 每次开 app 被重置的老坑，见 App.jsx 顶部 handleCategoryChange 的同款注释）。
 */
const FILTER_KEY = 'app_wordlist_filter';
const SUBTAB_KEY = 'app_wordlist_subtab';
const FILTER_KEYS = ['vocabIllustrated', 'time', 'random', 'reverseRandom', 'mastered'];
const SUBTAB_KEYS = ['words', 'phrases', 'dev'];

// Anything not in the whitelist (old build, hand-edited storage) falls back to
// the default instead of leaving the page on a tab that no longer renders.
function readSavedTab(key, allowed, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return allowed.includes(saved) ? saved : fallback;
  } catch { return fallback; }
}

export default function WordListPage({ onStartReview, nativeLang = 'zh', targetLang = 'en', userScope = 'guest', refreshKey = 0, userEmail = '', authPending = false }) {
  const posthog = usePostHog();
  // 进阶 (dev) sub-tab: whitelisted user only, zh→en only. Personal study list,
  // kept entirely separate from the public 单词 / 短语 tabs.
  const devUnlocked = nativeLang === 'zh' && targetLang === 'en' && canSwitchLanguageFreely(userEmail);
  // Progress is scoped per-user and per-target so account switches don't
  // bleed mastered/learned flags between users on the same device.
  const langKey = `${userScope}_${targetLang}`;
  const t = UI_TEXT[nativeLang] || UI_TEXT.zh;

  const FILTERS = useMemo(() => [
    { key: 'vocabIllustrated', label: t.vocabIllustrated, accent: '#C7BAFB' },
    { key: 'time', label: t.timeOrder, accent: '#ff8bba' },
    { key: 'random', label: t.randomOrder, accent: '#8ECFFF' },
    { key: 'reverseRandom', label: t.reverseRandom, accent: '#FFB198' },
    { key: 'mastered', label: t.mastered, accent: '#ffd3d3' },
  ], [t]);

  const [filter, setFilterState] = useState(() => readSavedTab(FILTER_KEY, FILTER_KEYS, 'vocabIllustrated'));
  const [subTab, setSubTabState] = useState(() => readSavedTab(SUBTAB_KEY, SUBTAB_KEYS, 'words')); // 'words' | 'phrases' | 'dev'
  const [galleryCat, setGalleryCat] = useState('all');
  const [galleryShuffleKey, setGalleryShuffleKey] = useState(0);
  const [progress, setProgress] = useState(() => getProgress(langKey));
  const [revealedWords, setRevealedWords] = useState(new Set());
  const [translationCache, setTranslationCache] = useState(() => new Map(_translationCache));
  const [popupWord, setPopupWord] = useState(null);
  const [leavingWords, setLeavingWords] = useState(new Set());
  const [pendingMasteredWords, setPendingMasteredWords] = useState(new Map()); // wordId → newMasteredState
  const [randomKey, setRandomKey] = useState(0);
  const [query, setQuery] = useState('');
  const [showAddCustom, setShowAddCustom] = useState(false);
  // 用户自己手打的「自定义」词组 —— 跟 devPhrases 同构，进同一个 dev 池。
  const customWords = useCustomWords(userScope);

  // See「Tab memory」above: persist:false = an automatic, screen-only fallback.
  const setFilter = useCallback((key) => {
    setFilterState(key);
    try { localStorage.setItem(FILTER_KEY, key); } catch {}
  }, []);
  const setSubTab = useCallback((key, { persist = true } = {}) => {
    setSubTabState(key);
    if (!persist) return;
    try { localStorage.setItem(SUBTAB_KEY, key); } catch {}
  }, []);

  useEffect(() => {
    setProgress(getProgress(langKey));
    setRevealedWords(new Set());
    setPopupWord(null);
  }, [langKey]);

  // If the 进阶 sub-tab is active but the user is no longer unlocked, fall back.
  // authPending guard + persist:false, both mandatory: on every launch the auth
  // core paints before it resolves the session, so `userEmail` is '' for the
  // first frames and devUnlocked reads false for a user who *is* whitelisted.
  // Acting on that frame — or letting it reach storage — is what used to reset
  // the saved tab on every app open.
  useEffect(() => {
    if (authPending) return;
    if (subTab === 'dev' && !devUnlocked) setSubTab('words', { persist: false });
  }, [authPending, subTab, devUnlocked, setSubTab]);

  // Preload the dev-phrases audio manifest so the first tap plays the recording
  // (not a one-off TTS fallback) — same as LearningPage does.
  useEffect(() => {
    if (devUnlocked) preloadAudioManifest('dev-phrases');
  }, [devUnlocked]);

  useEffect(() => {
    setProgress(getProgress(langKey));
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setRevealedWords(new Set());
  }, [filter]);

  // Full pool — words + oral phrases (+ 进阶 phrases for the unlocked user only,
  // so dev content never reaches anyone else's totals or lists).
  const allWords = useMemo(() => {
    const pool = devUnlocked
      ? [...words, ...oralPhrases, ...devPhrases, ...customWords]
      : [...words, ...oralPhrases];
    // Last line of defence: id doubles as the React list key AND the storage key.
    // A duplicate id makes React reuse rows across sub-tabs — ghost 短语 rows stuck
    // on top of the 单词 list, rows surviving into the empty state. Data generation
    // already de-dups; keep the pool unique here so a bad row can never do that again.
    const seen = new Set();
    return pool.filter(w => !seen.has(w.id) && seen.add(w.id));
  }, [devUnlocked, customWords]);

  const eligibleWords = useMemo(() => {
    return allWords.filter(w => isWordAvailable(w, nativeLang, targetLang));
  }, [nativeLang, targetLang, allWords]);

  // Pool filtered by 单词/短语/进阶 sub-tab (used by non-gallery filters).
  // The 单词 tab must exclude BOTH oral and dev so 进阶 phrases never leak in.
  const subTabPool = useMemo(() => {
    if (subTab === 'phrases') return eligibleWords.filter(w => w.level === 'oral');
    if (subTab === 'dev') return eligibleWords.filter(w => w.level === 'dev');
    return eligibleWords.filter(w => w.level !== 'oral' && w.level !== 'dev');
  }, [eligibleWords, subTab]);

  const totalLearning = useMemo(() => {
    const prog = progress;
    return eligibleWords.filter(w => prog[w.id]?.timestamp && !prog[w.id].mastered).length;
  }, [progress, eligibleWords]);

  // Word categories available for gallery ("all" + each category).
  const galleryCategoryList = useMemo(() => {
    return ['all', ...wordCategories.filter(c => c !== 'all')];
  }, []);

  // Gallery view: learned OR mastered words in the selected category.
  // Order reshuffles each time the user taps a category (galleryShuffleKey).
  const galleryWords = useMemo(() => {
    const prog = progress;
    const list = words
      .filter(w => isWordAvailable(w, nativeLang, targetLang))
      .filter(w => galleryCat === 'all' || w.category === galleryCat)
      .filter(w => !!prog[w.id]?.timestamp || !!prog[w.id]?.mastered);
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }, [progress, nativeLang, targetLang, galleryCat, galleryShuffleKey]);

  const galleryCategoryTotal = useMemo(() => {
    return words.filter(w =>
      isWordAvailable(w, nativeLang, targetLang) &&
      (galleryCat === 'all' || w.category === galleryCat)
    ).length;
  }, [nativeLang, targetLang, galleryCat]);

  // One haystack per row, rebuilt only when the tab / language changes — not on
  // every keystroke. Hundreds of rows × a string rebuild per character is the
  // kind of thing a cheap phone feels.
  const searchIndex = useMemo(() => {
    const m = new Map();
    for (const w of subTabPool) m.set(w.id, searchHaystack(w, nativeLang, targetLang));
    return m;
  }, [subTabPool, nativeLang, targetLang]);

  const searchQuery = query.trim().toLowerCase();

  const wordList = useMemo(() => {
    const prog = progress;
    const showMastered = filter === 'mastered';
    let list = subTabPool.filter(w => {
      const p = prog[w.id];
      if (!p) return false;
      // Substring, not whole-word: typing a few characters of either language
      // is enough to pull the row up.
      if (searchQuery && !(searchIndex.get(w.id) || '').includes(searchQuery)) return false;
      if (showMastered) return p.mastered;
      return !!p.timestamp && !p.mastered;
    });
    if (showMastered) {
      list.sort((a, b) => (prog[b.id]?.masteredAt || 0) - (prog[a.id]?.masteredAt || 0));
    } else if (filter === 'time') {
      list.sort((a, b) => (prog[b.id]?.timestamp || 0) - (prog[a.id]?.timestamp || 0));
    } else if (filter === 'random' || filter === 'reverseRandom') {
      stableShuffle(list, randomKey * 2 + (filter === 'reverseRandom' ? 1 : 0));
    }
    return list;
  }, [progress, filter, randomKey, subTabPool, searchQuery, searchIndex]);

  const handleToggleMastered = useCallback((wordId) => {
    const currentMastered = progress[wordId]?.mastered || false;
    const newMastered = !currentMastered;
    posthog?.capture('word_mastered_toggled', { word_id: wordId, mastered: newMastered, content_type: subTab === 'words' ? 'word' : 'phrase', native_lang: nativeLang, target_lang: targetLang });

    // Step 1: show new check state visually (word stays in list, no storage update yet)
    setPendingMasteredWords(prev => new Map(prev).set(wordId, newMastered));

    // Step 2: after 150ms, start slide-out animation
    setTimeout(() => {
      setLeavingWords(prev => new Set(prev).add(wordId));

      // Step 3: after animation completes, commit to storage and refresh list
      setTimeout(() => {
        toggleMastered(wordId, newMastered, langKey);
        setPendingMasteredWords(prev => { const m = new Map(prev); m.delete(wordId); return m; });
        setLeavingWords(prev => { const s = new Set(prev); s.delete(wordId); return s; });
        setProgress(getProgress(langKey));
      }, 400);
    }, 300);
  }, [progress, langKey, subTab]);

  // 确认添加自定义词组。用户拍板：加完**立刻算「学习中」** —— 写进度是让这些词
  // 马上出现在单词本列表里（也计入顶部数字、进复习队列）的唯一开关，列表本身
  // 只显示有 progress 记录的词。
  // 时间戳按行序递减：时间顺序是倒序排的，这样第 1 行还是排在最上面。
  // 加完顺手切到「时间顺序」并清掉搜索词 —— 不然用户停在「已斩」或搜索结果里，
  // 刚加的词一个都看不见，会以为没加上。
  const handleAddCustom = useCallback((rows) => {
    const added = addCustomWords(userScope, rows);
    if (!added.length) return;
    const prog = getProgress(langKey);
    const now = Date.now();
    added.forEach((w, i) => {
      if (!prog[w.id]) prog[w.id] = { timestamp: now - i, mastered: false };
    });
    saveProgress(prog, langKey);
    setProgress(prog);
    clearDraft(userScope);
    setShowAddCustom(false);
    setQuery('');
    setFilter('time');
    posthog?.capture('custom_words_added', { count: added.length, native_lang: nativeLang, target_lang: targetLang });
  }, [userScope, langKey, setFilter, posthog, nativeLang, targetLang]);

  const handleTapWord = useCallback((word) => {
    if (!revealedWords.has(word.id)) {
      setRevealedWords(prev => new Set(prev).add(word.id));
      prefetchTranslation(word, targetLang, nativeLang, (cacheKey, tt) => {
        setTranslationCache(prev => new Map(prev).set(cacheKey, tt));
      });
    }
    setPopupWord(word);
    speakWordOrDev(word, stripRuby(getWordText(word, targetLang) || word.en), targetLang);
  }, [revealedWords, targetLang, nativeLang]);

  const handleSpeak = useCallback((e, word) => {
    e.stopPropagation();
    const text = stripRuby(getWordText(word, targetLang) || word.en);
    speakWordOrDev(word, text, targetLang);
  }, [targetLang]);

  // Preload images (first 20) + translations (all) so popup opens instantly
  useEffect(() => {
    wordList.forEach((w, i) => {
      if (i < 20 && w.img) preloadImage(getImageUrl(w.img));
      prefetchTranslation(w, targetLang, nativeLang, (cacheKey, tt) => {
        setTranslationCache(prev => new Map(prev).set(cacheKey, tt));
      });
    });
  }, [wordList, targetLang, nativeLang]);

  const targetFont = getFontFamily(targetLang);
  const isTargetJa = targetLang === 'ja';

  // Long-list affordances: the slim scrollbar (where am I in the list) and the
  // back-to-top button (shown only once we're past the first screen).
  const scrollRef = useRef(null);
  const { past, barRef, thumbRef, scrollToTop } = useScrollWatch(scrollRef);

  return (
    <div className="relative h-full">
      {/* Background — stays fixed behind scrolling content */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <img src={getFigmaAssetUrl('vocablist-background.jpg')} alt="" className="w-full h-full object-cover" />
      </div>

      {/* All content scrolls together. scrollbar-hide kills the native bar —
          SlimScrollBar below draws the one the user actually sees. */}
      <div ref={scrollRef} className="relative z-10 h-full overflow-y-auto scrollbar-hide">

        {/* ===== HEADER ===== */}
        <div className="flex flex-col items-center pt-6 pb-4">
          <span className="text-[14px] text-[#3f3e3e]">{t.learning}</span>
          <span className="text-[36px] font-extrabold text-black leading-none mt-1">{totalLearning}</span>
          <button
            data-testid="wordlist-review-btn"
            onClick={() => {
              posthog?.capture('review_session_started', { word_count: totalLearning, native_lang: nativeLang, target_lang: targetLang });
              onStartReview();
            }}
            className="mt-3 flex items-center justify-center bg-[#FFDF4E] text-black rounded-full border-[1.5px] border-black active:scale-95"
            style={{ width: 113, height: 39 }}
          >
            <span className="text-[18px]">{t.review}</span>
          </button>
        </div>

        {/* ===== FILTER BUTTONS ===== */}
        <div className="flex gap-2 px-3.5 py-2.5 overflow-x-auto scrollbar-hide">
          {FILTERS.map(f => {
            const isActive = filter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => {
                  setFilter(f.key);
                  if (f.key === 'random' || f.key === 'reverseRandom') {
                    setRandomKey(k => k + 1);
                    setRevealedWords(new Set());
                  }
                }}
                className="shrink-0 rounded-[5px] text-[14px] font-medium"
                style={{
                  height: 32,
                  paddingLeft: 12,
                  paddingRight: 12,
                  minWidth: 82,
                  backgroundColor: isActive ? '#fff9df' : f.accent,
                  border: isActive ? '1.5px solid #000' : `1.5px solid ${f.accent}`,
                  color: isActive ? '#000' : '#fff',
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        {/* ===== SUB-NAV (gallery: word categories; others: 单词/短语) ===== */}
        {filter === 'vocabIllustrated' ? (
          <div className="mx-3.5 mt-1" style={{
            borderTop: '1.5px solid #000',
            borderLeft: '1.5px solid #000',
            borderRight: '1.5px solid #000',
            borderTopLeftRadius: 10,
            borderTopRightRadius: 10,
            overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
            minHeight: 'calc(100vh - 240px)',
          }}>
            {/* Category sub-nav — flush at top, only top corners rounded via parent overflow */}
            <div className="scrollbar-hide shrink-0" style={{
              backgroundColor: '#ffffff', height: 36,
              display: 'flex', alignItems: 'center', overflowX: 'auto', WebkitOverflowScrolling: 'touch',
              padding: '0 12px', gap: 14,
            }}>
              {galleryCategoryList.map(cat => {
                const label = (CATEGORY_LABELS[nativeLang] || CATEGORY_LABELS.zh)[cat] || cat;
                const active = galleryCat === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => {
                      setGalleryCat(cat);
                      setGalleryShuffleKey(k => k + 1);
                      setRevealedWords(new Set());
                    }}
                    className="shrink-0 text-[14px]"
                    style={{
                      height: 36, padding: 0,
                      color: active ? '#000' : '#a8a5a5',
                      fontWeight: active ? 700 : 500,
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {/* Inner area with translucent bg */}
            <div className="flex-1" style={{ backgroundColor: 'rgba(255,255,255,0.1)', padding: '12px 12px 16px' }}>
              {/* Progress bar */}
              <div className="flex items-center gap-2">
                <div style={{
                  flex: 1, position: 'relative', height: 12,
                  backgroundColor: '#ffffff', border: '1.5px solid #000', borderRadius: 100,
                  overflow: 'hidden',
                }}>
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: galleryCategoryTotal > 0 ? `${(galleryWords.length / galleryCategoryTotal) * 100}%` : '0%',
                    backgroundColor: '#c7f59a', borderRadius: 100,
                  }} />
                </div>
                <span className="text-[12px] text-black" style={{ minWidth: 10, textAlign: 'right' }}>
                  {galleryWords.length}/{galleryCategoryTotal}
                </span>
              </div>
              {/* Gallery grid */}
              <div className="mt-3">
                <GalleryGrid
                  words={galleryWords}
                  revealedWords={revealedWords}
                  onTap={(w) => handleTapWord(w)}
                  nativeLang={nativeLang}
                  targetLang={targetLang}
                />
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex mx-[14px] mt-1 mb-2">
              {[
                { key: 'words', label: t.wordsTab },
                { key: 'phrases', label: t.phrasesTab },
                // 进阶 tab — whitelisted user in zh→en only.
                ...(devUnlocked ? [{ key: 'dev', label: '进阶' }] : []),
              ].map((tab, idx, arr) => {
                const active = subTab === tab.key;
                const isLeft = idx === 0;
                const isRight = idx === arr.length - 1;
                return (
                  <button
                    key={tab.key}
                    onClick={() => { setSubTab(tab.key); setRevealedWords(new Set()); }}
                    className="flex-1 text-[14px] font-medium"
                    style={{
                      height: 36,
                      borderTop: '1.5px solid #000',
                      borderBottom: '1.5px solid #000',
                      borderLeft: isLeft ? '1.5px solid #000' : 'none',
                      borderRight: '1.5px solid #000',
                      borderTopLeftRadius: isLeft ? 5 : 0,
                      borderBottomLeftRadius: isLeft ? 5 : 0,
                      borderTopRightRadius: isRight ? 5 : 0,
                      borderBottomRightRadius: isRight ? 5 : 0,
                      backgroundColor: active ? '#FFF9DF' : 'transparent',
                      color: '#000',
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Search — same width as the tab row above it, and it pins itself to
                the top of the scroll port once the list slides past. */}
            <StickySearchBar
              value={query}
              onChange={setQuery}
              placeholder={t.searchPlaceholder}
              clearLabel={t.close}
              scrollRef={scrollRef}
            />

            {/* 自定义添加 —— 只在「进阶」下出现，长得跟上面的搜索框同一套
                （同高、同宽、同底色、同描边），只是换成 ＋ 和一行说明文字。
                故意不吸顶：吸顶区一次钉两条会吃掉小半屏，而添加是低频动作。 */}
            {subTab === 'dev' && devUnlocked && (
              <button
                type="button"
                data-testid="wordlist-add-custom-btn"
                onClick={() => setShowAddCustom(true)}
                className="active:scale-[0.99]"
                style={{
                  margin: '0 14px 8px',
                  width: 'calc(100% - 28px)', height: 36, boxSizing: 'border-box',
                  display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px',
                  backgroundColor: 'rgba(255,255,255,0.60)',
                  backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
                  border: '1.5px solid #000', borderRadius: 5,
                  fontSize: 14, color: '#3f3e3e', fontFamily: 'inherit',
                }}
              >
                <Icon name="plus" size={16} color="#8a8585" stroke={2} />
                自定义添加词组
              </button>
            )}
          </>
        )}

        {/* ===== WORD LIST ===== */}
        {filter !== 'vocabIllustrated' && (
        wordList.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-textSub">
            {/* A search that found nothing is not an empty word book — say which
                one it is, or the user goes looking for a bug in their progress. */}
            <div className="text-4xl mb-2">
              {searchQuery ? '🔍' : filter === 'mastered' ? '⚔️' : '😭'}
            </div>
            <div className="text-sm font-bold">
              {searchQuery
                ? t.noSearchResult
                : filter === 'mastered'
                  ? (subTab === 'words' ? t.noMastered : (t.noMasteredPhrases || t.noMastered))
                  : (subTab === 'words' ? t.noLearned : (t.noLearnedPhrases || t.noLearned))
              }
            </div>
            <div className="text-xs mt-1 text-textLight">
              {searchQuery ? t.searchTip : filter === 'mastered' ? t.masteredTip : t.learnedTip}
            </div>
          </div>
        ) : (
          <div>
            {wordList.map(word => {
              const isRevealed = revealedWords.has(word.id);
              const isMastered = pendingMasteredWords.has(word.id)
                ? pendingMasteredWords.get(word.id)
                : progress[word.id]?.mastered;
              const isLeaving = leavingWords.has(word.id);
              const isReverse = filter === 'reverseRandom';
              const displayText = isReverse
                ? (getWordText(word, nativeLang) || word.en)
                : (getWordText(word, targetLang) || word.en);
              const nativeText = isReverse
                ? (getWordText(word, targetLang) || word.en)
                : getWordText(word, nativeLang);

              return (
                <div
                  key={word.id}
                  onClick={() => !isLeaving && handleTapWord(word)}
                  style={{
                    transition: 'opacity 0.35s ease, transform 0.35s ease, max-height 0.35s ease',
                    opacity: isLeaving ? 0 : 1,
                    transform: isLeaving ? 'translateX(-60px)' : 'translateX(0)',
                    maxHeight: isLeaving ? 0 : 200,
                    overflow: 'hidden',
                  }}
                >
                  {/* Word row */}
                  <div className="flex items-start px-3.5 pt-3">
                    {/* Speaker icon */}
                    <button
                      onClick={(e) => handleSpeak(e, word)}
                      className="shrink-0 mt-[7px] active:scale-90"
                    >
                      <img src={getFigmaAssetUrl('icon-speaker.png')} alt="发音" style={{ width: 19, height: 15, filter: 'brightness(0.45)' }} />
                    </button>

                    {/* Word info */}
                    <div className="flex-1 ml-2.5 min-w-0">
                      <RubyText
                        text={displayText}
                        className="text-black font-normal"
                        style={{
                          fontSize: (isReverse ? (nativeLang === 'ja') : isTargetJa) ? 20 : 18,
                          fontFamily: (isReverse ? nativeLang : targetLang) === 'en'
                            ? 'Arial, sans-serif'
                            : (isReverse ? getFontFamily(nativeLang) : targetFont),
                        }}
                      />
                    </div>

                    {/* Mastered checkbox */}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleToggleMastered(word.id); }}
                      className="shrink-0 mt-[5px] active:scale-90"
                    >
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                        {isMastered ? (
                          <>
                            <rect x="2" y="2" width="20" height="20" rx="3" fill="#2b2a26" />
                            <polyline points="7 12 10.5 15.5 17 9" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                          </>
                        ) : (
                          <rect x="2" y="2" width="20" height="20" rx="3" fill="none" stroke="#000" strokeWidth="1.5" />
                        )}
                      </svg>
                    </button>
                  </div>

                  {/* Cover / Translation — full-width bar; revealed text indented to align with word */}
                  <div className="mx-3.5" style={{ height: 24, marginTop: 8, marginBottom: 11 }}>
                    {!isRevealed ? (
                      <div style={{ height: 24, width: '100%', backgroundColor: 'rgba(255,255,255,0.60)', borderRadius: 4 }} />
                    ) : (
                      <div style={{ height: 24, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', paddingLeft: 29 }}>
                        <RubyText text={nativeText} className="text-[14px] text-[#3f3e3e]" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} />
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.5" style={{ flexShrink: 0 }}>
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <circle cx="8.5" cy="8.5" r="1.5" fill="#555" />
                          <path d="M21 15l-5-5L5 21" />
                        </svg>
                      </div>
                    )}
                  </div>

                  {/* Divider */}
                  <div style={{ height: 1, backgroundColor: 'rgba(0,0,0,0.08)' }} />
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* ===== SLIM SCROLLBAR + BACK TO TOP ===== */}
      <SlimScrollBar barRef={barRef} thumbRef={thumbRef} style={{ zIndex: 20 }} />
      <ScrollTopButton
        visible={past}
        onClick={scrollToTop}
        label={t.backToTop}
        style={{ position: 'absolute', right: 14, bottom: 16, zIndex: 20 }}
      />

      {/* ===== 自定义添加 POPUP ===== */}
      {showAddCustom && (
        <AddCustomWordsModal
          scope={userScope}
          onClose={() => setShowAddCustom(false)}
          onSubmit={handleAddCustom}
        />
      )}

      {/* ===== IMAGE POPUP ===== */}
      {popupWord && (
        <PopupDetail
          word={popupWord}
          onClose={() => setPopupWord(null)}
          cachedTranslation={translationCache.get(`${popupWord.id}_${nativeLang}_${targetLang}`) || ''}
          nativeLang={nativeLang}
          targetLang={targetLang}
        />
      )}
    </div>
  );
}

/* ── Image preload cache ── */
const _imgPreloaded = new Set();
function preloadImage(src) {
  if (!src || _imgPreloaded.has(src)) return;
  const img = new Image();
  img.src = src;
  _imgPreloaded.add(src);
}

/* ── Sticky search bar ───────────────────────────────────────────
 * Sits directly under the 单词/短语/进阶 tabs and spans exactly their width, and
 * pins itself to the top of the scroll port once the list scrolls past — in a
 * list hundreds of rows long, the way to search must never be scrolled away.
 * It floats as a pill rather than a full-width bar: the rows are inset by the
 * same 14px, so nothing but background art ever slides through the gutters.
 * `stuck` comes off a 1px sentinel parked just above the bar instead of a
 * scroll handler — same reasoning as scrollKit's useScrollWatch: re-rendering
 * this page on every scroll frame is what makes a cheap phone stutter.
 */
const STICKY_TOP = 12;   // how far below the top edge the pinned bar floats

function StickySearchBar({ value, onChange, placeholder, clearLabel, scrollRef }) {
  const sentinelRef = useRef(null);
  const [stuck, setStuck] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([e]) => setStuck(!e.isIntersecting),
      // The negative top margin pulls the root's edge down to exactly where the
      // bar pins, so the shadow arrives with the pin instead of STICKY_TOP px
      // of scrolling later.
      { root: scrollRef.current || null, rootMargin: `-${STICKY_TOP}px 0px 0px 0px`, threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRef]);

  return (
    <>
      <div ref={sentinelRef} aria-hidden="true" style={{ height: 1 }} />
      <div
        style={{
          position: 'sticky', top: STICKY_TOP, zIndex: 30,
          margin: '0 14px 8px',
          height: 36, boxSizing: 'border-box',
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '0 10px',
          // Same translucent white as the translation cover strips below, so the
          // bar belongs to the list rather than sitting on top of it. The fill
          // alone is see-through enough that a word scrolling underneath reads
          // straight through the placeholder, so the backdrop behind it is
          // blurred to a wash — same trick, same blur radius, as popKit's
          // BACK_BTN. The bar's own colour and opacity are untouched.
          backgroundColor: 'rgba(255,255,255,0.60)',
          backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
          border: `1.5px solid ${focused ? YELLOW : '#000'}`,
          borderRadius: 5,
          // Only once it's floating over the list — a shadow on a box sitting in
          // the flow just looks like a smudge.
          boxShadow: stuck ? '0 2px 6px rgba(120,90,110,0.22)' : 'none',
          transition: 'box-shadow .18s ease, border-color .15s ease',
        }}
      >
        <Icon name="search" size={16} color="#8a8585" stroke={2} />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, height: '100%', padding: 0,
            border: 'none', outline: 'none', background: 'transparent',
            fontSize: 14, color: '#000',
          }}
        />
        {!!value && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label={clearLabel}
            className="shrink-0 active:scale-90"
            style={{ padding: 0, display: 'flex', alignItems: 'center' }}
          >
            <Icon name="close" size={14} color="#8a8585" stroke={2.2} />
          </button>
        )}
      </div>
    </>
  );
}

/* ── Gallery grid: 3-column image grid with translation-cover strips ── */
function GalleryGrid({ words, revealedWords, onTap, nativeLang, targetLang }) {
  const t = UI_TEXT[nativeLang] || UI_TEXT.zh;
  const targetFont = getFontFamily(targetLang);

  if (words.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-textSub">
        <div className="text-4xl mb-2">😭</div>
        <div className="text-sm font-bold">{t.noLearned}</div>
        <div className="text-xs mt-1 text-textLight">{t.learnedTip}</div>
      </div>
    );
  }

  return (
    <div className="mx-0 pb-6" style={{
      display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', columnGap: 14, rowGap: 24,
    }}>
      {words.map(word => {
        const isRevealed = revealedWords.has(word.id);
        const display = getWordText(word, targetLang) || word.en;
        const imgSrc = word.img ? getImageUrl(word.img) : null;
        return (
          <div key={word.id} className="flex flex-col items-center" onClick={() => onTap(word)}>
            <div
              style={{
                width: '100%', aspectRatio: '1 / 1', borderRadius: 10, overflow: 'hidden',
                backgroundColor: '#fff', cursor: 'pointer',
              }}
              className="active:scale-95"
            >
              {imgSrc && (
                <img src={imgSrc} alt={display} className="w-full h-full object-cover" />
              )}
            </div>
            <div style={{ height: 26, marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
              {isRevealed ? (
                <RubyText
                  text={display}
                  className="text-[14px] text-black font-medium"
                  style={{
                    fontFamily: targetFont,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%',
                  }}
                />
              ) : (
                <div style={{ width: 70, height: 18, borderRadius: 100, backgroundColor: '#A6D9FF' }} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Popup component ── */
function PopupDetail({ word, onClose, cachedTranslation, nativeLang, targetLang }) {
  const t = UI_TEXT[nativeLang] || UI_TEXT.zh;
  const displayText = getWordText(word, targetLang) || word.en;
  const nativeText = getWordText(word, nativeLang);

  let displaySentence = getSentence(word, targetLang);
  let sentenceLang = targetLang;
  if (!displaySentence && targetLang === 'zh') {
    displaySentence = word.sentence || '';
    sentenceLang = 'en';
  }

  // Prefer the authored sentence in the native language; only fall back to the
  // MyMemory-cached machine translation if no static sentence exists.
  const staticTranslation = sentenceLang !== nativeLang
    ? getStaticSentence(word, nativeLang)
    : '';
  const translatedSentence = staticTranslation || cachedTranslation;

  const phonetic = getWordPhonetic(word, targetLang);
  const targetFont = getFontFamily(targetLang);
  const isTargetJa = targetLang === 'ja';

  const imgSrc = word.img ? getImageUrl(word.img) : null;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!imgSrc || _imgPreloaded.has(imgSrc)) {
      // No image or already cached — show immediately
      setReady(true);
      return;
    }
    const img = new Image();
    img.src = imgSrc;
    img.onload = () => { _imgPreloaded.add(imgSrc); setReady(true); };
    img.onerror = () => setReady(true);
    // If image loads within 30ms it's from cache; otherwise show after brief wait
    const timer = setTimeout(() => setReady(true), 150);
    return () => clearTimeout(timer);
  }, [imgSrc]);

  const handleSpeak = () => {
    speakWordOrDev(word, stripRuby(displayText), targetLang);
  };

  // 单词那一组：图 / 单词 / 音标 / 释义。释义是这个单词的翻译，永远紧跟着单词
  // 走；这一组和下面的例句是同一整块，一起居中，不单独钉在卡顶。
  const headContent = (
    <>
      {imgSrc && (
        <img
          src={imgSrc}
          alt={stripRuby(displayText)}
          className="w-full rounded-xl"
          style={{ maxHeight: 280, objectFit: 'contain' }}
        />
      )}
      <RubyText
        text={displayText}
        className={imgSrc ? 'block text-center mt-4' : 'block text-center'}
        style={{ fontSize: isTargetJa ? 26 : 22, fontFamily: targetFont, fontWeight: 900 }}
      />
      {/* 没标注音标的词只剩喇叭 —— 行高写死，有没有音标都不跳版 */}
      <div className="flex items-center justify-center gap-1.5 mt-2" style={{ minHeight: 22 }}>
        <button onClick={handleSpeak} className="active:scale-90 shrink-0">
          <img src={getFigmaAssetUrl('icon-speaker.png')} alt="发音" style={{ width: 19, height: 15 }} />
        </button>
        {phonetic && (
          <span
            className="text-[15px] text-[#999]"
            style={{ fontFamily: isTargetJa ? '"Hiragino Sans", sans-serif' : 'inherit' }}
          >
            {phonetic}
          </span>
        )}
      </div>
      <RubyText text={nativeText} className="block text-center text-[16px] text-[#3f3e3e] mt-2 font-medium" />
    </>
  );

  const body = displaySentence ? (
    <>
      <p
        className="text-center text-[14px] text-[#555] leading-snug px-1"
        style={{ fontFamily: getFontFamily(sentenceLang) }}
      >
        {displaySentence}
      </p>
      {sentenceLang !== nativeLang && !word.custom && (
        // 译文可能是异步查回来的：先占好一行，回来时不推着上面的内容跳。
        // 自定义词组没有译文这一行（用户不要），连占位都不留。
        <p className="text-center text-[12px] text-[#999] mt-1 leading-snug px-1" style={{ minHeight: 18 }}>
          {translatedSentence || '\u00A0'}
        </p>
      )}
    </>
  ) : null;

  // ⚠️ 用户反复强调的死规矩：**这个 pop 最短也是正方形**（高 ≥ 宽），有图没图
  // 一样，内容再短也不许把卡压扁 —— 短内容是在方框里居中，不是让方框缩水。
  // 所以宽和高的下限是同一个值 CARD_SIDE；只有屏幕实在装不下时才让步到 100%。
  // 48px = MODAL_SCRIM 左右各 24 的内边距：窄屏上卡实际就这么宽，宽高同一个
  // 算式才真的是正方形（写 24px 的话高会比宽多出 24，方不了）。
  const CARD_SIDE = 'min(353px, calc(100vw - 48px))';

  return (
    <div
      style={{
        ...MODAL_SCRIM, zIndex: 50,
        // 图片预载期间遮罩透明淡入 — 自带 transition，关掉 kit 的入场动画
        animation: 'none',
        backgroundColor: ready ? 'rgba(80,50,70,0.34)' : 'rgba(80,50,70,0)',
        transition: 'background-color 0.2s ease',
      }}
      onClick={onClose}
    >
      {/* 两段式（用户 08-18 拍板，别再改）：
          ① 从单词到例句译文（图 / 单词 / 音标 / 释义 / 例句 / 例句译文）是**一整块**，
             内部间距跟有图的长 pop 完全一样；这一整块在关闭按钮上方整体上下居中，
             撑不下时自己滚动。
          ② 关闭按钮位置固定，钉在卡底（离内容 16、离底边 26，不贴边）。 */}
      <div
        className={SCROLL_HIDE}
        style={{
          ...MODAL_CARD, animation: 'none',
          width: CARD_SIDE,
          minHeight: `min(${CARD_SIDE}, 100%)`, // 正方形下限
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          padding: imgSrc ? '16px 16px 26px' : '22px 16px 26px',
          opacity: ready ? 1 : 0,
          transform: ready ? 'scale(1)' : 'scale(0.95)',
          transition: 'opacity 0.2s ease, transform 0.2s ease',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* ① 单词 → 例句译文这一整块：占满关闭按钮以上的全部高度，整块居中。
            居中用 margin:auto 而不是 justify-content:center —— 内容撑满时 auto
            自动退化成 0，不会像后者那样把顶部截掉、滚不上去。 */}
        <div
          className={SCROLL_HIDE}
          style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
        >
          <div style={{ width: '100%', margin: 'auto 0' }}>
            {headContent}
            {body && <div className="mt-2">{body}</div>}
          </div>
        </div>

        {/* ② 关闭按钮：位置固定。用户定稿(07-25)：本 pop 的唯一退出控件 = 底部
            黄色 Close（右上角 X 已按用户要求去掉）— 移植/统一时不得改回 X */}
        <button
          onClick={onClose}
          className="mx-auto block active:scale-95"
          style={{
            flex: '0 0 auto', marginTop: 16,
            width: 148, height: 48, backgroundColor: '#FFDF4E',
            border: '1.5px solid #000', borderRadius: 100, fontSize: 18, color: '#000',
          }}
        >
          {t.close}
        </button>
      </div>
    </div>
  );
}
