import { useState, useEffect } from 'react';
import LearningPage from './components/LearningPage';
import WordListPage from './components/WordListPage';
import SettingsPage from './components/SettingsPage';
import WelcomePage from './components/WelcomePage';
import LanguageSetupPage from './components/LanguageSetupPage';
import { migrateOldProgress, migrateProgressToTargetOnly, bumpLoginDay, shouldShowCheckin, markCheckinShown, getLoginDayCount } from './utils/storage';
import { primeAudio } from './hooks/useAudio';
import { useInstallPrompt } from './hooks/useInstallPrompt';
import { UI_TEXT } from './utils/langHelpers';
import { supabase } from './lib/supabase';
import { Analytics } from '@vercel/analytics/react';
import { usePostHog } from '@posthog/react';

const TAB_ACTIVE_COLORS = { learn: '#ffd3be', wordlist: '#a7e4fe', settings: '#e0feb1' };

function TabIcon({ type, active }) {
  const color = active ? (TAB_ACTIVE_COLORS[type] || '#f7d376') : '#ffffff';
  if (type === 'learn') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </svg>
    );
  }
  if (type === 'wordlist') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="2" width="16" height="20" rx="2" />
        <line x1="8" y1="7" x2="16" y2="7" />
        <line x1="8" y1="11" x2="16" y2="11" />
        <line x1="8" y1="15" x2="12" y2="15" />
      </svg>
    );
  }
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// Run migrations once on module load
migrateOldProgress();
migrateProgressToTargetOnly();

// Reset learning category to "all" if the user has been away for more than this.
// Picked 6h: long enough that the same study session keeps its category, short
// enough that returning the next morning starts fresh on "all".
const STALE_CATEGORY_MS = 6 * 60 * 60 * 1000;

// Read & evaluate "last active" once at module load — before App reads localStorage
// for the initial learningCategory state. If stale, wipe the saved category so
// useState falls back to 'all'.
(function resetCategoryIfStale() {
  const last = parseInt(localStorage.getItem('app_last_active') || '0', 10);
  if (!last || Date.now() - last > STALE_CATEGORY_MS) {
    localStorage.removeItem('app_learning_category');
  }
  localStorage.setItem('app_last_active', String(Date.now()));
})();

// Detect browser language → default native lang for first-time visitors.
// Used pre-login (Welcome / Email pages) so unsaved users see localized UI.
function detectBrowserNativeLang() {
  const list = navigator.languages && navigator.languages.length
    ? navigator.languages
    : [navigator.language || 'en'];
  for (const raw of list) {
    const code = (raw || '').toLowerCase();
    if (code.startsWith('zh')) return 'zh';
    if (code.startsWith('ja')) return 'ja';
    if (code.startsWith('en')) return 'en';
  }
  return 'en';
}

function defaultTargetFor(native) {
  // Sensible default: zh→en, en→ja, ja→en
  if (native === 'zh') return 'en';
  if (native === 'en') return 'ja';
  return 'en';
}

export default function App() {
  const posthog = usePostHog();
  const [session, setSession] = useState(null);
  const [isGuest, setIsGuest] = useState(() => localStorage.getItem('app_logged_in') === 'true');
  const isLoggedIn = !!session || isGuest;
  // Language setup shows once per user — both authed users and guests skip it
  // on subsequent logins if they've already picked native/target.
  const [needsLangSetup, setNeedsLangSetup] = useState(false);
  const [page, setPage] = useState('learn');
  const [reviewMode, setReviewMode] = useState(false);
  const [wordListRefreshKey, setWordListRefreshKey] = useState(0);
  const [nativeLang, setNativeLang] = useState(() => {
    const saved = localStorage.getItem('app_native');
    return saved || detectBrowserNativeLang();
  });
  const [targetLang, setTargetLang] = useState(() => {
    const saved = localStorage.getItem('app_target');
    if (saved) return saved;
    const guessNative = localStorage.getItem('app_native') || detectBrowserNativeLang();
    return defaultTargetFor(guessNative);
  });
  const [navH, setNavH] = useState(() => window.innerHeight < 833 ? 52 : 57);
  const [vpH, setVpH] = useState(() => window.innerHeight);
  // Daily check-in popup: null when hidden, number = login-day count when shown
  const [checkinDay, setCheckinDay] = useState(null);
  // Whether the PWA is already installed — hides the "add to home screen" hint
  // inside the check-in popup. Initial sync check covers all browsers when
  // running in standalone mode; the async getInstalledRelatedApps probe below
  // covers Chrome desktop / Android even when the user is in a browser tab.
  //
  // Tri-state: `null` while the async probe is in flight, `true`/`false` after.
  // The check-in popup waits for a definitive value before mounting so the
  // install hint paints in sync with whatever Settings would show. (Without
  // this, the popup mounts with the sync default `false` and shows the hint
  // for the ~100ms it takes getInstalledRelatedApps to resolve — even on
  // installed Chrome.)
  const [pwaInstalled, setPwaInstalled] = useState(() => {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.navigator.standalone === true) return true; // iOS Safari
    } catch {}
    return null;
  });
  useEffect(() => {
    let cancelled = false;
    // Only flip to installed on a *positive* signal — Chrome's
    // `beforeinstallprompt` is throttled by engagement heuristics, so absence
    // of the prompt can't be trusted as a signal.

    // 1) Chrome desktop + Android: explicit query via getInstalledRelatedApps
    //    (matches against `related_applications` in our manifest).
    if (navigator.getInstalledRelatedApps) {
      navigator.getInstalledRelatedApps()
        .then((apps) => {
          if (cancelled) return;
          setPwaInstalled((prev) => prev === true ? true : !!(apps && apps.length > 0));
        })
        .catch(() => { if (!cancelled) setPwaInstalled((prev) => prev === true ? true : false); });
    } else {
      // No probe available — settle to "not installed" so the popup can mount.
      setPwaInstalled((prev) => prev === true ? true : false);
    }

    // 2) Catches users who install during this session.
    const onInstalled = () => { if (!cancelled) setPwaInstalled(true); };
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      cancelled = true;
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    const update = () => {
      setNavH(window.innerHeight < 833 ? 52 : 57);
      setVpH(window.innerHeight);
    };
    window.addEventListener('resize', update);
    // BFCache restore on mobile browsers doesn't fire `resize`, but the
    // viewport may have changed while the tab was backgrounded — re-read
    // window.innerHeight on every pageshow (incl. `persisted=true` restores)
    // so the saved state doesn't drive the layout off the new viewport.
    window.addEventListener('pageshow', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('pageshow', update);
    };
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      bumpLoginDay(data.session?.user?.id);
      if (data.session?.user) {
        posthog?.identify(data.session.user.id, {
          email: data.session.user.email,
        });
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      bumpLoginDay(s?.user?.id);
      if (s?.user) {
        posthog?.identify(s.user.id, { email: s.user.email });
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Sync <html lang> with the user's native language so the browser uses the
  // correct font shaping, line-breaking, and screen-reader voice — and (because
  // it now matches the visible UI) won't flag the page as foreign for translation.
  useEffect(() => {
    const tag = nativeLang === 'zh' ? 'zh-CN' : nativeLang === 'ja' ? 'ja' : 'en';
    document.documentElement.lang = tag;
  }, [nativeLang]);

  useEffect(() => {
    const props = {
      native_lang: nativeLang,
      target_lang: targetLang,
      language_mode: `${nativeLang}_${targetLang}`,
    };
    posthog?.register(props);
    if (session?.user?.id) posthog?.setPersonProperties(props);
  }, [nativeLang, targetLang, posthog, session]);

  // Decide whether to show language setup whenever auth state changes.
  useEffect(() => {
    if (!isLoggedIn) {
      setNeedsLangSetup(false);
      return;
    }
    if (session?.user?.id) {
      const onboarded = localStorage.getItem('lang_onboarded_' + session.user.id) === 'true';
      setNeedsLangSetup(!onboarded);
    } else {
      setNeedsLangSetup(false);
    }
  }, [isLoggedIn, session, isGuest]);

  // Daily check-in popup: show once per local-calendar day after the user is
  // past login + language setup. bumpLoginDay has already added today's date.
  // Also wait until pwaInstalled is known (not null) so the install hint
  // inside the popup paints with the correct state from the first frame.
  useEffect(() => {
    if (!isLoggedIn || needsLangSetup) return;
    if (pwaInstalled === null) return;
    const uid = session?.user?.id;
    if (shouldShowCheckin(uid)) {
      setCheckinDay(getLoginDayCount(uid));
    }
  }, [isLoggedIn, needsLangSetup, session, pwaInstalled]);

  const handleCheckin = () => {
    // Unlock audio *inside* the click gesture — iOS Safari requires this for
    // any later TTS / recorded playback (auto-speak on word change) to work.
    primeAudio();
    markCheckinShown(session?.user?.id);
    setCheckinDay(null);
  };
  // Persist category/level filters across tab switches AND page refreshes
  const [learningCategory, setLearningCategory] = useState(() => localStorage.getItem('app_learning_category') || 'all');
  const [learningLevel, setLearningLevel] = useState(() => localStorage.getItem('app_learning_level') || 'beginner');
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);

  const handleCategoryChange = (cat) => {
    setLearningCategory(cat);
    localStorage.setItem('app_learning_category', cat);
  };
  const handleLevelChange = (lvl) => {
    setLearningLevel(lvl);
    localStorage.setItem('app_learning_level', lvl);
  };

  const t = UI_TEXT[nativeLang] || UI_TEXT.zh;
  const { openInstall, modalNode: installModalNode, installAvailable } = useInstallPrompt(nativeLang, t);
  // The check-in popup only nudges install when the flow is actually
  // actionable — i.e. mobile / Safari desktop (manual steps work) or a
  // browser that has fired `beforeinstallprompt`. Otherwise the click would
  // land on the "you previously installed but didn't fully uninstall"
  // fallback, which isn't a real install path.
  const showCheckinInstallHint = !pwaInstalled && installAvailable;

  const handleTabClick = (tab) => {
    posthog?.capture('tab_switched', { tab, native_lang: nativeLang, target_lang: targetLang });
    if (reviewMode) setReviewMode(false);
    setPage(tab);
    if (tab === 'wordlist') setWordListRefreshKey(k => k + 1);
  };

  const handleStartReview = () => {
    setReviewMode(true);
  };

  const handleExitReview = () => {
    setReviewMode(false);
    setPage('wordlist');
    setWordListRefreshKey(k => k + 1);
  };

  const handleLogin = () => {
    localStorage.setItem('app_logged_in', 'true');
    localStorage.setItem('app_last_active', String(Date.now()));
    // Login always lands on "all" category — especially important for new accounts.
    localStorage.setItem('app_learning_category', 'all');
    setLearningCategory('all');
    setIsGuest(true);
    setPage('learn');
    setReviewMode(false);
  };

  const handleTestMode = () => {
    // Test mode = a fresh account every time. Wipe all local state (progress,
    // review states, avatar, login-day count, language preferences, etc.) so
    // the user lands on a clean slate, then reload so React state mirrors the
    // cleared storage.
    try { localStorage.clear(); } catch {}
    localStorage.setItem('app_logged_in', 'true');
    localStorage.setItem('app_last_active', String(Date.now()));
    window.location.reload();
  };

  const handleLogout = async () => {
    localStorage.removeItem('app_logged_in');
    setIsGuest(false);
    setPage('learn');
    setReviewMode(false);
    if (session) await supabase.auth.signOut();
  };

  const handleLangSetupComplete = ({ native, target }) => {
    setNativeLang(native);
    setTargetLang(target);
    localStorage.setItem('app_native', native);
    localStorage.setItem('app_target', target);
    if (session?.user?.id) {
      localStorage.setItem('lang_onboarded_' + session.user.id, 'true');
    }
    setNeedsLangSetup(false);
  };

  const handleLanguageChange = ({ native, target }) => {
    if (native !== undefined) {
      setNativeLang(native);
      localStorage.setItem('app_native', native);
    }
    if (target !== undefined) {
      setTargetLang(target);
      localStorage.setItem('app_target', target);
    }
  };

  // Which tab to highlight
  const activeTab = reviewMode ? 'wordlist' : page;

  // Show login page if not logged in
  if (!isLoggedIn) {
    return (
      <div className="w-screen bg-white flex items-center justify-center font-cute overflow-hidden" style={{ height: vpH }}>
        <div className="w-[402px] h-[841px] overflow-hidden sm:rounded-[2rem] relative" style={{ maxHeight: vpH }}>
          <WelcomePage onLogin={handleLogin} onTestMode={handleTestMode} nativeLang={nativeLang} />
        </div>
      </div>
    );
  }

  // Show language setup for first-time accounts (or every time in test mode)
  if (needsLangSetup) {
    return (
      <div className="w-screen bg-white flex items-center justify-center font-cute overflow-hidden" style={{ height: vpH }}>
        <div className="w-[402px] h-[841px] overflow-hidden sm:rounded-[2rem] relative" style={{ maxHeight: vpH }}>
          <LanguageSetupPage onComplete={handleLangSetupComplete} />
        </div>
      </div>
    );
  }

  return (
    <div className="w-screen flex items-center justify-center font-cute overflow-hidden" style={{ height: vpH, backgroundColor: '#ffffff' }}>
      <div className="w-[402px] h-[841px] flex flex-col overflow-hidden sm:rounded-[2rem] relative bg-warm-bg" style={{ maxHeight: vpH }}>

        {/* Main content — all pages stay mounted to preserve state; display:none hides inactive ones */}
        <div className="flex-1 min-h-0 overflow-visible">
          <div style={{ display: (page === 'learn' || reviewMode) ? undefined : 'none', height: '100%' }}>
            <LearningPage
              isReview={reviewMode}
              onExitReview={handleExitReview}
              nativeLang={nativeLang}
              targetLang={targetLang}
              selectedCategory={learningCategory}
              selectedLevel={learningLevel}
              onCategoryChange={handleCategoryChange}
              contentHFromParent={Math.max(0, vpH - (categoryModalOpen ? 0 : navH) - 2)}
              onLevelChange={handleLevelChange}
              isVisible={(page === 'learn' || reviewMode) && checkinDay == null}
              onCategoryModalChange={setCategoryModalOpen}
            />
          </div>
          <div style={{ display: (page === 'wordlist' && !reviewMode) ? undefined : 'none', height: '100%' }}>
            <WordListPage
              onStartReview={handleStartReview}
              nativeLang={nativeLang}
              targetLang={targetLang}
              refreshKey={wordListRefreshKey}
            />
          </div>
          <div style={{ display: (page === 'settings' && !reviewMode) ? undefined : 'none', height: '100%' }}>
            <SettingsPage
              nativeLang={nativeLang}
              targetLang={targetLang}
              onLanguageChange={handleLanguageChange}
              onLogout={handleLogout}
              onInstallClick={openInstall}
              pwaInstalled={pwaInstalled}
            />
          </div>
        </div>

        {/* Bottom tab bar */}
        <div className="shrink-0 relative overflow-visible" style={{ height: categoryModalOpen ? 0 : navH, backgroundColor: '#2b2a26', overflow: categoryModalOpen ? 'hidden' : undefined }}>
          {/* Nav separator line at top */}
          <img
            src="/assets/figma/nav-separator.png"
            alt=""
            className="absolute top-0 left-0 w-full pointer-events-none select-none"
            style={{ height: 3 }}
          />
          <div className="flex items-center justify-around h-full px-4 pt-1">
            {[
              { key: 'learn', label: t.learn },
              { key: 'wordlist', label: t.wordlist },
              { key: 'settings', label: t.settings },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => handleTabClick(tab.key)}
                className="flex flex-col items-center gap-0.5 min-w-[60px]"
              >
                <TabIcon type={tab.key} active={activeTab === tab.key} />
                <span
                  className="text-[10px] font-bold"
                  style={{ color: activeTab === tab.key ? TAB_ACTIVE_COLORS[tab.key] : '#ffffff' }}
                >
                  {tab.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Daily check-in popup — shown once per local-calendar day */}
        {checkinDay != null && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
            onClick={handleCheckin}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: 300,
                height: showCheckinInstallHint ? 370 : 300,
                backgroundColor: '#fff',
                border: '2px solid #000',
                borderRadius: 20,
                padding: '34px 24px 28px',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between',
              }}
            >
              <p style={{ textAlign: 'center', fontSize: 24, fontWeight: 700, color: '#000', margin: 0 }}>
                {t.checkinTitle || '每日打卡'}
              </p>
              <p style={{ textAlign: 'center', fontSize: 18, color: '#000', lineHeight: 2.0, margin: 0, whiteSpace: 'pre-line' }}>
                {(t.checkinFmt || '累计登录第 {n} 天\nヾ(◍°∇°◍)ﾉﾞ').replace('{n}', checkinDay)}
              </p>
              <button
                onClick={handleCheckin}
                className="active:scale-95"
                style={{
                  width: 140, height: 44,
                  backgroundColor: '#ffd016',
                  border: '2px solid #000',
                  borderRadius: 100,
                  fontSize: 18, color: '#000',
                }}
              >
                {t.checkinBtn || '打卡'}
              </button>
              {showCheckinInstallHint && (() => {
                const hint = t.checkinInstallHint || '添加到桌面\n下次打开更方便';
                const [hintTitle, hintSub] = hint.split('\n');
                return (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      // Prime audio + record dismissal first, then open install modal.
                      // installModalNode renders at z-60 so it overlays the check-in popup.
                      primeAudio();
                      markCheckinShown(session?.user?.id);
                      setCheckinDay(null);
                      openInstall();
                    }}
                    className="active:scale-95"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 14,
                      padding: '10px 20px 10px 12px',
                      background: 'rgb(224, 255, 251)',
                      border: '1.5px solid #2b2a26',
                      borderRadius: 16,
                      boxShadow: '0 2px 0 #2b2a26',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'transform 0.08s ease',
                    }}
                  >
                    {/* install-hint-icon.png is a pre-cropped 134x165 version of the
                        watermelon (the original apple-touch-icon.png has built-in safe-area
                        padding so the character only fills ~60% of its canvas — bad here). */}
                    <img
                      src="/icons/install-hint-icon.png"
                      alt=""
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 11,
                        objectFit: 'contain',
                        backgroundColor: '#fff',
                        display: 'block',
                        flexShrink: 0,
                        border: '1px solid rgba(0,0,0,0.12)',
                      }}
                    />
                    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: '#2b2a26' }}>{hintTitle}</span>
                      {hintSub && (
                        <span style={{ fontSize: 12, color: '#6b6356', marginTop: 2 }}>{hintSub}</span>
                      )}
                    </span>
                  </button>
                );
              })()}
            </div>
          </div>
        )}

        {/* Install-to-home-screen modal — rendered at app level so the check-in
            popup link and the Settings button share one modal. */}
        {installModalNode}
      </div>
      <Analytics />
    </div>
  );
}
