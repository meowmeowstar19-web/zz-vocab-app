import { useState, useEffect, useMemo, useCallback } from 'react';
import { words } from '../data/words';
import { getProgress, toggleMastered } from '../utils/storage';
import { speakWordByLang } from '../hooks/useAudio';
import { phoneticMap } from '../data/phonetics';
import {
  getWordText, getSentence, getPhonetic, isWordAvailable,
  getTranslationPair, getFontFamily, UI_TEXT, LANGUAGES, getLangName,
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
    { key: 'time', label: t.timeOrder },
    { key: 'random', label: t.randomOrder },
    { key: 'mastered', label: t.mastered },
  ], [t]);

  const [filter, setFilter] = useState(initialFilter || 'time');
  const [timeAsc, setTimeAsc] = useState(false); // false = newest first, true = oldest first
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

  const eligibleWords = useMemo(() => {
    return words.filter(w => isWordAvailable(w, nativeLang, targetLang));
  }, [nativeLang, targetLang]);

  const totalLearning = useMemo(() => {
    const prog = progress;
    return eligibleWords.filter(w => prog[w.id]?.timestamp && !prog[w.id].mastered).length;
  }, [progress, eligibleWords]);

  const wordList = useMemo(() => {
    const prog = progress;
    const showMastered = filter === 'mastered';
    let list = eligibleWords.filter(w => {
      const p = prog[w.id];
      if (!p) return false;
      if (showMastered) return p.mastered;
      return !!p.timestamp && !p.mastered;
    });
    if (showMastered) {
      list.sort((a, b) => (prog[b.id]?.masteredAt || 0) - (prog[a.id]?.masteredAt || 0));
    } else if (filter === 'time') {
      if (timeAsc) {
        list.sort((a, b) => (prog[a.id]?.timestamp || 0) - (prog[b.id]?.timestamp || 0));
      } else {
        list.sort((a, b) => (prog[b.id]?.timestamp || 0) - (prog[a.id]?.timestamp || 0));
      }
    } else if (filter === 'random') {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    }
    return list;
  }, [progress, filter, randomKey, eligibleWords, timeAsc]);

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
    if (revealedWords.has(word.id)) {
      setPopupWord(word);
      speakWordByLang(getWordText(word, targetLang) || word.en, targetLang);
    } else {
      setRevealedWords(prev => new Set(prev).add(word.id));
      prefetchTranslation(word, targetLang, nativeLang, (cacheKey, tt) => {
        setTranslationCache(prev => new Map(prev).set(cacheKey, tt));
      });
    }
  }, [revealedWords, targetLang, nativeLang]);

  const handleSpeak = useCallback((e, word) => {
    e.stopPropagation();
    const text = getWordText(word, targetLang) || word.en;
    speakWordByLang(text, targetLang);
  }, [targetLang]);

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
        <div className="flex gap-2 px-3 py-2.5 overflow-x-auto scrollbar-hide justify-center">
          {FILTERS.map(f => {
            const isActive = filter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => {
                  if (f.key === 'time' && filter === 'time') {
                    // Toggle between newest-first and oldest-first
                    setTimeAsc(prev => !prev);
                  } else {
                    setFilter(f.key);
                    if (f.key === 'time') setTimeAsc(false); // reset to newest-first when switching to time
                  }
                  if (f.key === 'random') {
                    setRandomKey(k => k + 1);
                    setRevealedWords(new Set());
                  }
                }}
                className="shrink-0 rounded-[5px] text-[14px] font-medium"
                style={{
                  height: 32,
                  paddingLeft: 12,
                  paddingRight: 12,
                  backgroundColor: isActive ? '#000000' : '#ffffff',
                  border: '1.5px solid #000000',
                  color: isActive ? '#ffffff' : '#000000',
                }}
              >
                {f.key === 'time' ? `${f.label} ${timeAsc ? '↑' : '↓'}` : f.label}
              </button>
            );
          })}
        </div>

        {/* ===== WORD LIST ===== */}
        {wordList.length === 0 ? (
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
              const displayText = getWordText(word, targetLang) || word.en;
              const nativeText = getWordText(word, nativeLang);

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
                        style={{ fontSize: isTargetJa ? 20 : 18, fontFamily: targetFont }}
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
                  <div className="mx-3.5 mt-2 mb-2" style={{ height: 24 }}>
                    {!isRevealed ? (
                      <div style={{ height: 24, width: '100%', backgroundColor: 'rgba(255,255,255,0.55)', borderRadius: 4 }} />
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
        )}
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

  const handleSpeak = () => {
    speakWordByLang(displayText, targetLang);
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl p-4 shadow-xl"
        style={{ width: '85%' }}
        onClick={e => e.stopPropagation()}
      >
        <img
          src={`/images/${encodeURIComponent(word.img)}`}
          alt={displayText}
          className="w-full rounded-xl"
          style={{ maxHeight: 280, objectFit: 'contain' }}
        />
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
        {cachedTranslation && sentenceLang !== nativeLang && (
          <p className="text-center text-[12px] text-[#999] mt-1 leading-snug px-1">
            {cachedTranslation}
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
