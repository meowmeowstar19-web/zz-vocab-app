import { useState, useEffect, useMemo, useCallback } from 'react';
import { words, categories as wordCategories } from '../data/words';
import { oralPhrases, oralCategories, ORAL_CATEGORY_LABELS } from '../data/oralPhrases';
import { getProgress, toggleMastered } from '../utils/storage';
import { speakWordByLang } from '../hooks/useAudio';
import { phoneticMap } from '../data/phonetics';
import {
  getWordText, getSentence, getPhonetic, isWordAvailable,
  getTranslationPair, getFontFamily, UI_TEXT, LANGUAGES, getLangName,
  CATEGORY_LABELS,
} from '../utils/langHelpers';

// Translation cache persists for speed — keyed by wordId_langKey
const _translationCache = new Map();

function prefetchTranslation(word, targetLang, nativeLang, onDone) {
  let sentence = getSentence(word, targetLang);
  let sentenceLang = targetLang;
  if (!sentence && targetLang === 'zh') {
    sentence = word.sentence || '';
    sentenceLang = 'en';
  }
  if (!sentence || sentenceLang === nativeLang) return;
  const cacheKey = `${word.id}_${nativeLang}_${targetLang}`;
  if (_translationCache.has(cacheKey)) return;
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

function usePhonetic(wordEn, targetLang) {
  const [phonetic, setPhonetic] = useState('');
  useEffect(() => {
    if (!wordEn) { setPhonetic(''); return; }
    const word = { en: wordEn };
    const staticP = getPhonetic(word, targetLang);
    if (staticP !== null) { setPhonetic(staticP); return; }
    const local = phoneticMap[wordEn];
    if (local) { setPhonetic(local); return; }
    setPhonetic('');
    let cancelled = false;
    const parts = wordEn.split(/\s+/).map(w => w.toLowerCase().replace(/[^a-z]/g, '')).filter(Boolean);
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
  }, [wordEn, targetLang]);
  return phonetic;
}

export default function WordListPage({ onStartReview, initialFilter, nativeLang = 'zh', targetLang = 'en', refreshKey = 0 }) {
  const langKey = targetLang; // progress keyed by target language only
  const t = UI_TEXT[nativeLang] || UI_TEXT.zh;

  const FILTERS = useMemo(() => [
    { key: 'vocabIllustrated', label: t.vocabIllustrated, accent: '#98C967' },
    { key: 'time', label: t.timeOrder, accent: '#ff8bba' },
    { key: 'random', label: t.randomOrder, accent: '#9cd6ff' },
    { key: 'reverseRandom', label: t.reverseRandom, accent: '#bfafff' },
    { key: 'mastered', label: t.mastered, accent: '#ffd3d3' },
  ], [t]);

  const jaInvolved = nativeLang === 'ja' || targetLang === 'ja';
  const [filter, setFilter] = useState(initialFilter || 'vocabIllustrated');
  const [subTab, setSubTab] = useState('words'); // 'words' | 'phrases'
  const [galleryCat, setGalleryCat] = useState('food'); // first non-all word category in gallery
  const [progress, setProgress] = useState(() => getProgress(langKey));
  const [revealedWords, setRevealedWords] = useState(new Set());
  const [translationCache, setTranslationCache] = useState(() => new Map(_translationCache));
  const [popupWord, setPopupWord] = useState(null);
  const [leavingWords, setLeavingWords] = useState(new Set());
  const [pendingMasteredWords, setPendingMasteredWords] = useState(new Map()); // wordId → newMasteredState
  const [randomKey, setRandomKey] = useState(0);

  useEffect(() => {
    setProgress(getProgress(langKey));
    setRevealedWords(new Set());
    setPopupWord(null);
  }, [langKey]);

  useEffect(() => {
    setProgress(getProgress(langKey));
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setRevealedWords(new Set());
  }, [filter]);

  useEffect(() => {
    if (initialFilter) {
      setFilter(initialFilter);
      setProgress(getProgress(langKey));
    }
  }, [initialFilter, langKey]);

  // Full pool — words + oral phrases (oral phrases unavailable if ja involved).
  const allWords = useMemo(() => {
    return jaInvolved ? words : [...words, ...oralPhrases];
  }, [jaInvolved]);

  const eligibleWords = useMemo(() => {
    return allWords.filter(w => isWordAvailable(w, nativeLang, targetLang));
  }, [nativeLang, targetLang, allWords]);

  // Pool filtered by 单词/短语 sub-tab (used by non-gallery filters)
  const subTabPool = useMemo(() => {
    if (jaInvolved) return eligibleWords.filter(w => w.level !== 'oral');
    if (subTab === 'phrases') return eligibleWords.filter(w => w.level === 'oral');
    return eligibleWords.filter(w => w.level !== 'oral');
  }, [eligibleWords, subTab, jaInvolved]);

  const totalLearning = useMemo(() => {
    const prog = progress;
    return eligibleWords.filter(w => prog[w.id]?.timestamp && !prog[w.id].mastered).length;
  }, [progress, eligibleWords]);

  // Word categories available for gallery (only regular words, not oral phrases).
  const galleryCategoryList = useMemo(() => {
    return wordCategories.filter(c => c !== 'all');
  }, []);

  // Gallery view: learned OR mastered words in the selected category.
  const galleryWords = useMemo(() => {
    const prog = progress;
    return words
      .filter(w => isWordAvailable(w, nativeLang, targetLang))
      .filter(w => w.category === galleryCat)
      .filter(w => !!prog[w.id]?.timestamp || !!prog[w.id]?.mastered);
  }, [progress, nativeLang, targetLang, galleryCat]);

  const galleryCategoryTotal = useMemo(() => {
    return words.filter(w => isWordAvailable(w, nativeLang, targetLang) && w.category === galleryCat).length;
  }, [nativeLang, targetLang, galleryCat]);

  const wordList = useMemo(() => {
    const prog = progress;
    const showMastered = filter === 'mastered';
    let list = subTabPool.filter(w => {
      const p = prog[w.id];
      if (!p) return false;
      if (showMastered) return p.mastered;
      return !!p.timestamp && !p.mastered;
    });
    if (showMastered) {
      list.sort((a, b) => (prog[b.id]?.masteredAt || 0) - (prog[a.id]?.masteredAt || 0));
    } else if (filter === 'time') {
      list.sort((a, b) => (prog[b.id]?.timestamp || 0) - (prog[a.id]?.timestamp || 0));
    } else if (filter === 'random' || filter === 'reverseRandom') {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    }
    return list;
  }, [progress, filter, randomKey, subTabPool]);

  const handleToggleMastered = useCallback((wordId) => {
    const currentMastered = progress[wordId]?.mastered || false;
    const newMastered = !currentMastered;

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
  }, [progress, langKey]);

  const handleTapWord = useCallback((word) => {
    if (!revealedWords.has(word.id)) {
      setRevealedWords(prev => new Set(prev).add(word.id));
      prefetchTranslation(word, targetLang, nativeLang, (cacheKey, tt) => {
        setTranslationCache(prev => new Map(prev).set(cacheKey, tt));
      });
    }
    setPopupWord(word);
    speakWordByLang(getWordText(word, targetLang) || word.en, targetLang);
  }, [revealedWords, targetLang, nativeLang]);

  const handleSpeak = useCallback((e, word) => {
    e.stopPropagation();
    const text = getWordText(word, targetLang) || word.en;
    speakWordByLang(text, targetLang);
  }, [targetLang]);

  // Preload images (first 20) + translations (all) so popup opens instantly
  useEffect(() => {
    wordList.forEach((w, i) => {
      if (i < 20 && w.img) preloadImage(`/images/${encodeURIComponent(w.img)}`);
      prefetchTranslation(w, targetLang, nativeLang, (cacheKey, tt) => {
        setTranslationCache(prev => new Map(prev).set(cacheKey, tt));
      });
    });
  }, [wordList, targetLang, nativeLang]);

  const targetFont = getFontFamily(targetLang);
  const isTargetJa = targetLang === 'ja';

  return (
    <div className="relative h-full">
      {/* Background — stays fixed behind scrolling content */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <img src="/assets/figma/vocablist-background.jpg" alt="" className="w-full h-full object-cover" />
      </div>

      {/* All content scrolls together */}
      <div className="relative z-10 h-full overflow-y-auto">

        {/* ===== HEADER ===== */}
        <div className="flex flex-col items-center pt-6 pb-4">
          <span className="text-[14px] text-[#3f3e3e]">{t.learning}</span>
          <span className="text-[36px] font-extrabold text-black leading-none mt-1">{totalLearning}</span>
          <button
            onClick={onStartReview}
            className="mt-3 flex items-center justify-center bg-[#ffd016] text-black rounded-full border-2 border-black active:scale-95"
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
              backgroundColor: 'rgba(255,255,255,0.6)', height: 36,
              display: 'flex', alignItems: 'center', overflowX: 'auto', WebkitOverflowScrolling: 'touch',
              padding: '0 12px', gap: 14,
            }}>
              {galleryCategoryList.map(cat => {
                const label = (CATEGORY_LABELS[nativeLang] || CATEGORY_LABELS.zh)[cat] || cat;
                const active = galleryCat === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => { setGalleryCat(cat); setRevealedWords(new Set()); }}
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
            <div className="flex-1" style={{ backgroundColor: 'rgba(255,255,255,0.45)', padding: '12px 12px 16px' }}>
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
        ) : jaInvolved ? null : (
          <div className="flex mx-[14px] mt-1 mb-2">
            {[
              { key: 'words', label: t.wordsTab },
              { key: 'phrases', label: t.phrasesTab },
            ].map((tab, idx) => {
              const active = subTab === tab.key;
              const isLeft = idx === 0;
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
                    borderTopRightRadius: isLeft ? 0 : 5,
                    borderBottomRightRadius: isLeft ? 0 : 5,
                    backgroundColor: active ? '#FFF9DF' : 'transparent',
                    color: '#000',
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        )}

        {/* ===== WORD LIST ===== */}
        {filter !== 'vocabIllustrated' && (
        wordList.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-textSub">
            <div className="text-4xl mb-2">
              {filter === 'mastered' ? '⚔️' : '📚'}
            </div>
            <div className="text-sm font-bold">
              {filter === 'mastered' ? t.noMastered : t.noLearned}
            </div>
            <div className="text-xs mt-1 text-textLight">
              {filter === 'mastered' ? t.masteredTip : t.learnedTip}
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
                      className="shrink-0 mt-[9px] active:scale-90"
                    >
                      <img src="/assets/figma/icon-speaker.svg" alt="发音" style={{ width: 19, height: 15, filter: 'brightness(0.45)' }} />
                    </button>

                    {/* Word info */}
                    <div className="flex-1 ml-2.5 min-w-0">
                      <span
                        className="text-black font-normal"
                        style={{
                          fontSize: (isReverse ? (nativeLang === 'ja') : isTargetJa) ? 20 : 18,
                          // English uses "Arial Black" elsewhere (intentional bold look),
                          // but the WordList row should be regular weight.
                          fontFamily: (isReverse ? nativeLang : targetLang) === 'en'
                            ? 'Arial, sans-serif'
                            : (isReverse ? getFontFamily(nativeLang) : targetFont),
                        }}
                      >
                        {displayText}
                      </span>
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
                        <span className="text-[14px] text-[#3f3e3e]" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nativeText}</span>
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

/* ── Gallery grid: 3-column image grid with translation-cover strips ── */
function GalleryGrid({ words, revealedWords, onTap, nativeLang, targetLang }) {
  const t = UI_TEXT[nativeLang] || UI_TEXT.zh;
  const targetFont = getFontFamily(targetLang);

  if (words.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-textSub">
        <div className="text-4xl mb-2">📚</div>
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
        const imgSrc = word.img ? `/images/${encodeURIComponent(word.img)}` : null;
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
                <span
                  className="text-[14px] text-black font-medium"
                  style={{
                    fontFamily: targetFont,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%',
                  }}
                >
                  {display}
                </span>
              ) : (
                <div style={{ width: 70, height: 18, borderRadius: 100, backgroundColor: '#CCEAFF' }} />
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

  const phonetic = usePhonetic(word.en, targetLang);
  const targetFont = getFontFamily(targetLang);
  const isTargetJa = targetLang === 'ja';

  const imgSrc = word.img ? `/images/${encodeURIComponent(word.img)}` : null;
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
    speakWordByLang(displayText, targetLang);
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center"
      style={{
        backgroundColor: ready ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0)',
        transition: 'background-color 0.2s ease',
      }}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl p-4 shadow-xl"
        style={{
          width: '85%',
          opacity: ready ? 1 : 0,
          transform: ready ? 'scale(1)' : 'scale(0.95)',
          transition: 'opacity 0.2s ease, transform 0.2s ease',
        }}
        onClick={e => e.stopPropagation()}
      >
        {imgSrc && (
          <img
            src={imgSrc}
            alt={displayText}
            className="w-full rounded-xl"
            style={{ maxHeight: 280, objectFit: 'contain' }}
          />
        )}
        <p
          className="text-center mt-4"
          style={{ fontSize: isTargetJa ? 26 : 22, fontFamily: targetFont, fontWeight: 900 }}
        >
          {displayText}
        </p>
        <div className="flex items-center justify-center gap-1.5 mt-2">
          <button onClick={handleSpeak} className="active:scale-90 shrink-0">
            <img src="/assets/figma/icon-speaker.svg" alt="发音" style={{ width: 19, height: 15 }} />
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
        <p className="text-center text-[16px] text-[#3f3e3e] mt-3 font-medium">{nativeText}</p>
        {displaySentence && (
          <p
            className="text-center text-[14px] text-[#555] mt-3 leading-snug px-1"
            style={{ fontFamily: getFontFamily(sentenceLang) }}
          >
            {displaySentence}
          </p>
        )}
        {displaySentence && sentenceLang !== nativeLang && (
          <p className="text-center text-[12px] text-[#999] mt-1 leading-snug px-1" style={{ minHeight: 18 }}>
            {cachedTranslation || '\u00A0'}
          </p>
        )}
        <button
          onClick={onClose}
          className="mt-4 w-full py-2.5 bg-[#2b2a26] text-white rounded-full text-[14px] active:scale-95"
        >
          {t.close}
        </button>
      </div>
    </div>
  );
}
