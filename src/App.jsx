import { useState, useEffect, useRef } from 'react';
import LearningPage from './components/LearningPage';
import WordListPage from './components/WordListPage';
import SettingsPage from './components/SettingsPage';
import LanguageSetupPage from './components/LanguageSetupPage';
import { WelcomePage, LoginPromptModal, EmailLoginPage, HandoffVeil } from './login-auth-ui/index.js';
import { MODAL_SCRIM, MODAL_CARD, MODAL_TITLE, CTA_SOLO, PopClose } from './general-ui/popKit.jsx';
import { useAuth } from './authSetup.js';
import { migrateOldProgress, migrateProgressToTargetOnly, migrateProgressToUserScope, bumpLoginDay, shouldShowCheckin, markCheckinShown, getLoginDayCount } from './utils/storage';
import { syncOnLogin, pushLocalToCloud } from './utils/progressSync';
import { primeAudio, playSlaySound, preloadAudioManifest } from './hooks/useAudio';
import { useInstallPrompt } from './hooks/useInstallPrompt';
import { UI_TEXT } from './utils/langHelpers';
import { getFigmaAssetUrl } from './utils/assetUrl';
import { isWeChatBrowser } from './utils/wechat';
import { Analytics } from '@vercel/analytics/react';
import { usePostHog } from '@posthog/react';

// Free quota before the guest login gate trips. Counted as distinct words
// the guest has LEARNED (entries in their per-uid progress slot), not as
// distinct words touched today. So the limit is "5 free learned words per
// guest account, ever" — not "5 per calendar day". This matches the user's
// promise: a guest gets to fully learn 5 words before being asked to bind.
const GATE_FREE_LIMIT = 5;

// Count distinct learned words in this scope's per-uid progress slot, across
// all target langs. Cheap (3 localStorage reads). Source of truth for the
// gate — same data the word list shows.
function countLearnedWords(scope) {
  if (!scope) return 0;
  let count = 0;
  for (const t of ['en', 'ja', 'zh']) {
    try {
      const p = JSON.parse(localStorage.getItem(`vocab_kids_progress_${scope}_${t}`) || '{}');
      count += Object.keys(p).length;
    } catch {}
  }
  return count;
}
const IS_WECHAT = isWeChatBrowser();

// WeChat's in-app browser leaves a thin white strip below the nav bar (its
// window.innerHeight under-reports the visible viewport). Tinting the page
// background the nav color makes that gap blend in. See index.css .wechat-bg.
if (IS_WECHAT) {
  try { document.documentElement.classList.add('wechat-bg'); } catch {}
}

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

// Run migrations once on module load. (The old gate_words / auth-flag
// migrations retired with the login-auth-core rewrite — authSetup.js's
// migrateLegacyAuth purges that whole family once.)
migrateOldProgress();
migrateProgressToTargetOnly();
migrateProgressToUserScope();

// ── Learning theme (category) memory ─────────────────────────────────────────
// Whatever theme the user was on when they left the app is the theme they come
// back to — on BOTH Learn and Review, across sessions and logins. Two rules
// keep that true:
//   1. Only an explicit user pick writes to storage. LearningPage's automatic
//      fallbacks (review auto-redirect when a theme has nothing left to review,
//      进阶 lock-out) pass `{ persist: false }`, so a screen-local switch to
//      "all" can never erase the saved theme.
//   2. The memory expires after 14 days of NOT opening the app. Every launch
//      re-stamps `app_learning_category_ts`; if the stamp is older than 14 days
//      the theme falls back to "all" (a returning-after-two-weeks user starts
//      from the full pool rather than a half-finished theme).
const CATEGORY_MEMORY_MS = 14 * 24 * 60 * 60 * 1000;
const CATEGORY_KEY = 'app_learning_category';
const CATEGORY_TS_KEY = 'app_learning_category_ts';

// Runs ONCE per app launch (module scope — immune to StrictMode double-invoke).
function loadLearningCategoryOnBoot() {
  let cat = 'all';
  try {
    const saved = localStorage.getItem(CATEGORY_KEY);
    const ts = Number(localStorage.getItem(CATEGORY_TS_KEY) || 0);
    // No stamp yet = pre-14-day-rule install: honour the saved theme and start
    // its clock now instead of expiring it on sight.
    const expired = saved && ts > 0 && Date.now() - ts > CATEGORY_MEMORY_MS;
    cat = (!saved || expired) ? 'all' : saved;
    if (cat !== saved) localStorage.setItem(CATEGORY_KEY, cat);
    localStorage.setItem(CATEGORY_TS_KEY, String(Date.now()));
  } catch { /* storage blocked (private mode) → session-only default */ }
  return cat;
}
const bootLearningCategory = loadLearningCategoryOnBoot();

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

// Post-login greeting toasts (login-auth-core notices). Localized here — the
// core only emits semantic events, copy stays at the app layer (portability
// rule inherited from miracleZZ). session-expired stays silent by PW's own
// 2026-05-27 decision: the welcome page next visit does that emotional work.
const NOTICE_TEXT = {
  'account-created': {
    en: '✨ New account created!',
    zh: '✨ 已为你创建新账号！',
    ja: '✨ 新しいアカウントを作成しました！',
  },
  'welcome-back': {
    en: 'Welcome back!',
    zh: '欢迎回来！',
    ja: 'おかえりなさい！',
  },
};

export default function App() {
  const posthog = usePostHog();
  // The ONE auth surface (login-auth-core via authSetup.js). Everything the
  // old stack derived from its own supabase listeners + ~13 loose flags now
  // reads from here: status/scope/atWelcome/flow/notice/hadAccount, plus every
  // login action. The core's own 4s watchdog replaces the old scopeFinalized
  // placeholder gate — boot renders synchronously under the persisted
  // optimistic scope, so the common path never remounts and nothing flickers.
  const auth = useAuth();
  const session = auth.session;
  // Single source of truth for the LoginPromptModal: null, or { surface } —
  // 'gate' (5-word gate on Learn) or 'settings' (Settings entries). All flow
  // internals (OAuth pending spinner, errors, email pane) live inside the
  // new modal itself.
  const [loginModal, setLoginModal] = useState(null);
  // Post-login greeting / status toast: null or { msg }.
  const [noticeToast, setNoticeToast] = useState(null);
  // First-time visitors with no language picked land on LanguageSetupPage.
  // Existing users (app_native set) skip it.
  const [needsLangSetup, setNeedsLangSetup] = useState(() => !localStorage.getItem('app_native'));
  // True while syncOnLogin's cloud→local merge is running for a freshly
  // entered account. The check-in popup is gated on this so it doesn't paint
  // "第1天" using the local-only count that bumpLoginDay just wrote — it waits
  // until the historical cloud days are merged in, then renders the total.
  const [syncInFlight, setSyncInFlight] = useState(false);
  const [page, setPage] = useState(() => {
    // An OAuth round trip fully reloads the app; the core's persisted flow
    // marker carries which surface launched it (the old *_oauth_pending flags
    // did this job). A Settings-launched flow lands back on Settings so its
    // verdict pops over the page that started it; everything else opens Learn.
    try {
      const snap = JSON.parse(localStorage.getItem('auth.snapshot.v1'));
      if (snap?.flow?.surface === 'settings') return 'settings';
    } catch {}
    return 'learn';
  });
  const [reviewMode, setReviewMode] = useState(false);
  const [wordListRefreshKey, setWordListRefreshKey] = useState(0);
  // Note: the previous "session expired" modal was removed 2026-05-27 — the
  // welcome-back gate on the next visit covers the same emotional work
  // (friendlier, fewer states). For an in-session forced signout, the user
  // just lands on WelcomePage; rare enough to not warrant a dedicated UI.
  // Bumped after every syncOnLogin completion so LearningPage can re-read
  // its `progress` state from localStorage. Without this, the cloud→local
  // merge writes new entries but LearningPage's mount-time useState snapshot
  // stays stale — the top-right "已学" count keeps showing the pre-sync
  // number until the user navigates away and back. WordListPage already has
  // its own refreshKey wired through tab clicks; this is the equivalent for
  // the learn surface, fired on the data-arrival edge instead.
  const [progressRefreshKey, setProgressRefreshKey] = useState(0);
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
  // Lazy-load the per-language audio manifests for the active mode so recorded
  // playback is ready before the first word. Covers app startup (persisted
  // langs) plus any later change via LanguageSetupPage / SettingsPage, since
  // both flow through nativeLang/targetLang state.
  useEffect(() => {
    if (nativeLang) preloadAudioManifest(nativeLang);
    if (targetLang) preloadAudioManifest(targetLang);
  }, [nativeLang, targetLang]);

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

  // Global one-shot audio primer. iOS Safari keeps the audio context
  // suspended until a user gesture resumes it; after an OAuth round-trip
  // (or any other page reload that arrives mid-session) the gesture that
  // launched the sign-in is gone, and the first word's auto-speak silently
  // fails. Capture the very next pointerdown anywhere in the document,
  // unlock audio inside that gesture, and detach.
  //
  // `replay: false` is the critical bit: this primer fires on *any* gesture
  // anywhere — tab switches, taps on Settings, Install-hint click — so it
  // must NOT replay the queued first-word speak. The deferred-speak slot is
  // still drained (so a stale word can't sit and play later out of context),
  // but the gesture is treated as an unlock-only event. The replay paths
  // belong to specific intentional-entry callsites: handleCheckin, the
  // welcome-exit effect, handleLangSetupComplete, EmailLoginPage's submit.
  useEffect(() => {
    let primed = false;
    const onGesture = () => {
      if (primed) return;
      primed = true;
      primeAudio({ replay: false });
      document.removeEventListener('pointerdown', onGesture, true);
      document.removeEventListener('keydown', onGesture, true);
    };
    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('keydown', onGesture, true);
    return () => {
      document.removeEventListener('pointerdown', onGesture, true);
      document.removeEventListener('keydown', onGesture, true);
    };
  }, []);

  useEffect(() => {
    // iOS standalone PWA ONLY: after an OAuth in-app-browser round-trip the
    // webview viewport spuriously collapses (innerHeight 793 → 657) and the
    // document scrolls ~54px under the black-translucent status bar, shoving
    // the whole shell up. dvh/svh/visualViewport all collapse with it; only
    // the large-viewport unit (100lvh) stays stable. So in standalone we
    // floor the height with lvh and undo the stray scroll — but ONLY for that
    // narrow spurious-collapse band, so a real shrink (soft keyboard) is left
    // alone. Browser and WeChat paths are byte-for-byte unchanged.
    const isStandalone = (() => {
      try {
        if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
        if (window.navigator.standalone === true) return true; // iOS Safari
      } catch {}
      return false;
    })();
    const readLvh = () => {
      try {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100lvh;visibility:hidden;pointer-events:none;';
        document.body.appendChild(probe);
        const h = probe.getBoundingClientRect().height;
        document.body.removeChild(probe);
        return h;
      } catch { return 0; }
    };
    const update = () => {
      let h = window.innerHeight;
      if (isStandalone) {
        const lvh = readLvh();
        // Correct only the spurious OAuth-return collapse: innerHeight dips a
        // little below lvh (657 vs 768). A big shrink (≥30%, e.g. keyboard) is
        // a genuine layout change — leave it. lvh===0 (unsupported) → no-op.
        if (lvh > 0 && h < lvh && h >= lvh * 0.7) {
          h = lvh;
          if (window.scrollY !== 0) window.scrollTo(0, 0);
        }
      }
      setNavH(h < 833 ? 52 : 57);
      setVpH(h);
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

  // ── Account entry: the ONE reaction to login-auth-core flipping to
  // 'account'. Replaces the old runSyncOrReject/bind apparatus — there is no
  // rejection path anymore: sign-in enters the account untouched, and guest
  // data moved (if at all) inside authSetup's onUpgrade BEFORE status flipped
  // (only into a server-empty account). Here we only: identify analytics,
  // stamp the day, pull-merge-push the account's cloud progress, and restore
  // its saved language preferences.
  const lastSyncedUid = useRef(null);
  useEffect(() => {
    if (!auth.isRealAccount) { lastSyncedUid.current = null; return; }
    const uid = auth.user.id;
    if (lastSyncedUid.current === uid) return;
    lastSyncedUid.current = uid;
    posthog?.identify(uid, { email: auth.user.email });
    // Persist the email so the dev-only escape hatch on Settings can still
    // identify the dev user after they drop into guest mode.
    if (auth.user.email) {
      try { localStorage.setItem('app_last_email', auth.user.email); } catch {}
    }
    bumpLoginDay(uid);
    // Flip BEFORE awaiting so the check-in effect (about to re-run on the
    // same auth change) defers the popup until the merge completes.
    setSyncInFlight(true);
    syncOnLogin(uid)
      .then(() => {
        // Pick up language preferences restored from the cloud snapshot so
        // re-login on a fresh device lands on the account's saved langs. When
        // neither the cloud nor this device has a pick, the setup page shows.
        try {
          const n = localStorage.getItem('app_native');
          const tg = localStorage.getItem('app_target');
          if (n) setNativeLang(n);
          if (tg) setTargetLang(tg);
          if (!n) setNeedsLangSetup(true);
        } catch {}
      })
      .catch(() => {})
      .finally(() => {
        setSyncInFlight(false);
        // Cloud-side changes were just merged in; tell the pages to re-read.
        setProgressRefreshKey(k => k + 1);
        setWordListRefreshKey(k => k + 1);
      });
  }, [auth.isRealAccount, auth.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Guests stamp the device's guest day-counter (feeds the seed on a future
  // sign-up; accounts stamp their own in the entry effect above).
  useEffect(() => {
    if (auth.ready && !auth.isAccountScope) bumpLoginDay(undefined);
  }, [auth.ready, auth.isAccountScope]);

  // An OAuth round trip landed us back with a live flow marker → the modal
  // reopens ON ITS OWN in its pending state, on the surface that launched it
  // (the core persisted the surface across the redirect).
  const bindingSurface = auth.flow?.kind === 'oauth' ? auth.flow.surface : null;
  useEffect(() => {
    if (bindingSurface && (bindingSurface === 'gate' || bindingSurface === 'settings') && !loginModal) {
      setLoginModal({ surface: bindingSurface });
      if (bindingSurface === 'settings') setPage('settings');
    }
  }, [bindingSurface]); // eslint-disable-line react-hooks/exhaustive-deps

  // Login succeeded while the modal was up → close it (Learn resumes where
  // the gate stopped it; Settings shows the fresh account).
  useEffect(() => {
    if (loginModal && auth.isRealAccount) setLoginModal(null);
  }, [auth.isRealAccount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Core notices → toast. session-expired stays SILENT (PW's 2026-05-27
  // decision: the welcome page on the next visit does that emotional work).
  useEffect(() => {
    if (!auth.notice) return;
    const copy = NOTICE_TEXT[auth.notice];
    if (copy) setNoticeToast({ msg: copy[nativeLang] || copy.en });
    auth.clearNotice();
  }, [auth.notice]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!noticeToast) return;
    const id = setTimeout(() => setNoticeToast(null), 2400);
    return () => clearTimeout(id);
  }, [noticeToast]);

  // WeChat never sees the welcome gate (免登录可用): OAuth doesn't work in the
  // in-app browser, so a logged-out WeChat user re-enters the persistent
  // guest sandbox directly. Re-login stays available from Settings (email).
  useEffect(() => {
    if (IS_WECHAT && auth.status === 'guest' && auth.atWelcome) auth.chooseGuest();
  }, [auth.status, auth.atWelcome]); // eslint-disable-line react-hooks/exhaustive-deps


  // Background sync: while an account is live, pull-merge-push the local
  // snapshot against the cloud row on relevant lifecycle events. Guests are
  // pure local (Plan B) — no cloud row until they sign up.
  //
  // Cost-optimized in two ways:
  //   1) Local writes set `localDirty` via the 'app:progress-changed' event
  //      (dispatched from storage.js saveProgress). Heartbeat and pagehide
  //      skip the push when nothing has changed since the last successful
  //      flush — idle tabs cost nothing.
  //   2) Heartbeat interval is 5 minutes (was 60s). The original tight
  //      interval was meant to keep two simultaneously-open devices in sync;
  //      in practice the cross-device handoff almost always involves the
  //      user backgrounding/closing the source tab, which fires
  //      visibilitychange or pagehide and flushes immediately. The heartbeat
  //      is now just a safety net for the rare "both tabs in foreground"
  //      scenario, where a 5-minute lag is fine.
  //
  // We always bump progressRefreshKey / wordListRefreshKey after the flush
  // resolves — pushLocalToCloud is pull-merge-push, so even when local was
  // clean we may have pulled fresh data from the other device. Without the
  // bump, LearningPage's top-right count stays frozen on whatever it loaded
  // at mount until the user navigates pages.
  const localDirty = useRef(false);
  useEffect(() => {
    const onChange = () => { localDirty.current = true; };
    window.addEventListener('app:progress-changed', onChange);
    return () => window.removeEventListener('app:progress-changed', onChange);
  }, []);
  useEffect(() => {
    const uid = auth.isRealAccount ? auth.user.id : null;
    if (!uid) return;
    const flushIfDirty = async () => {
      if (!localDirty.current) return;
      localDirty.current = false;
      try {
        await pushLocalToCloud(uid);
        setProgressRefreshKey(k => k + 1);
        setWordListRefreshKey(k => k + 1);
      } catch {
        // Restore dirty so the next flush will retry — losing a flush to a
        // transient network error shouldn't strand the data locally forever.
        localDirty.current = true;
      }
    };
    const flushForVisibility = async () => {
      // Always pull-merge-push on visibility transitions even when local is
      // clean — returning to the tab is exactly when we want to pick up
      // changes another device pushed. Cheap because visibility events are
      // rare (vs heartbeat, which used to fire every 60s).
      try {
        await pushLocalToCloud(uid);
        localDirty.current = false;
        setProgressRefreshKey(k => k + 1);
        setWordListRefreshKey(k => k + 1);
      } catch {
        // Keep dirty in case there was something pending we didn't flush.
      }
    };
    document.addEventListener('visibilitychange', flushForVisibility);
    window.addEventListener('pagehide', flushIfDirty);
    const id = setInterval(flushIfDirty, 5 * 60_000);
    return () => {
      document.removeEventListener('visibilitychange', flushForVisibility);
      window.removeEventListener('pagehide', flushIfDirty);
      clearInterval(id);
    };
  }, [auth.isRealAccount, auth.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push immediately when language preferences change so the cloud reflects
  // the user's latest pick — without waiting for the visibilitychange /
  // heartbeat flush. Ensures re-login on another device (or after sign-out)
  // restores the same lang combo. Guests stay local-only (see the heartbeat
  // useEffect above).
  useEffect(() => {
    if (!auth.isRealAccount) return;
    pushLocalToCloud(auth.user.id);
  }, [auth.isRealAccount, auth.user?.id, nativeLang, targetLang]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // `app_native` is the ONLY source of truth: set once when the device first
  // picks a language, never cleared by logout/login/account-switch — so the
  // picker fires only when the device has truly never picked one. Suppressed
  // while a login flow is in flight (no picker flash over a pending pane).
  useEffect(() => {
    if (auth.status === 'authenticating') {
      setNeedsLangSetup(false);
      return;
    }
    setNeedsLangSetup(!localStorage.getItem('app_native'));
  }, [auth.status]);

  // Daily check-in popup: show once per local-calendar day after the user is
  // past login + language setup. bumpLoginDay has already added today's date.
  // Also wait until pwaInstalled is known (not null) so the install hint
  // inside the popup paints with the correct state from the first frame.
  useEffect(() => {
    if (needsLangSetup) return;
    if (pwaInstalled === null) return;
    // Guests don't see the check-in popup — the cumulative-day count is only
    // meaningful for real (cloud-synced) accounts. Wait for the initial cloud
    // sync too, otherwise getLoginDayCount reads only `[today]` (what
    // bumpLoginDay just wrote) and paints "第1天" even for accounts with a
    // long history on other devices. Also stand down while the login modal is
    // up (a verdict pane must not get a popup on top).
    if (!auth.isRealAccount || syncInFlight || loginModal) return;
    const uid = auth.user.id;
    if (shouldShowCheckin(uid)) {
      setCheckinDay(getLoginDayCount(uid));
    }
  }, [needsLangSetup, pwaInstalled, auth.isRealAccount, auth.user?.id, syncInFlight, loginModal]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCheckin = () => {
    // Unlock audio *inside* the click gesture — iOS Safari requires this for
    // any later TTS / recorded playback (auto-speak on word change) to work.
    // primeAudio also replays any deferred first-word speak (queued while
    // audio was locked on the post-login mount), so dismissing the popup
    // produces both the celebratory check-in tone AND the first word's
    // pronunciation — neither plays without a gesture, so we anchor both
    // here.
    primeAudio();
    playSlaySound();
    markCheckinShown(session?.user?.id);
    setCheckinDay(null);
  };
  // Persist category/level filters across tab switches AND page refreshes
  const [learningCategory, setLearningCategory] = useState(bootLearningCategory);
  const [learningLevel, setLearningLevel] = useState(() => localStorage.getItem('app_learning_level') || 'beginner');
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);

  // persist:false = an automatic, session-only fallback (see comment near the
  // migrations above). The in-memory state still switches so the current screen
  // works, but the saved theme survives to the next launch.
  const handleCategoryChange = (cat, { persist = true } = {}) => {
    setLearningCategory(cat);
    if (!persist) return;
    localStorage.setItem(CATEGORY_KEY, cat);
    localStorage.setItem(CATEGORY_TS_KEY, String(Date.now()));
  };
  const handleLevelChange = (lvl, { persist = true } = {}) => {
    setLearningLevel(lvl);
    if (persist) localStorage.setItem('app_learning_level', lvl);
  };

  const t = UI_TEXT[nativeLang] || UI_TEXT.zh;
  const { openInstall, modalNode: installModalNode, installAvailable } = useInstallPrompt(nativeLang, t);
  // The check-in popup only nudges install when the flow is actually
  // actionable — i.e. mobile / Safari desktop (manual steps work) or a
  // browser that has fired `beforeinstallprompt`. Otherwise the click would
  // land on the "you previously installed but didn't fully uninstall"
  // fallback, which isn't a real install path.
  const showCheckinInstallHint = !pwaInstalled && installAvailable;

  // Review can force the in-memory category to "all" for its own session (a
  // theme with nothing left to review auto-redirects). That override dies with
  // the review screen — Learn goes back to the theme the user actually saved.
  const restoreSavedCategory = () => {
    const saved = localStorage.getItem(CATEGORY_KEY) || 'all';
    setLearningCategory(prev => (prev === saved ? prev : saved));
  };

  const handleTabClick = (tab) => {
    // Tab click is a user gesture — unlock audio so subsequent auto-speaks
    // play on iOS Safari. `replay: false` because the user is switching
    // tabs, not entering learn: a queued first-word speak (set during an
    // OAuth-return mount on learn) must NOT play onto WordList / Settings.
    // The deferred slot is drained inside primeAudio so it can't fire later.
    primeAudio({ replay: false });
    posthog?.capture('tab_switched', { tab, native_lang: nativeLang, target_lang: targetLang });
    if (reviewMode) { setReviewMode(false); restoreSavedCategory(); }
    setPage(tab);
    if (tab === 'wordlist') setWordListRefreshKey(k => k + 1);
  };

  const handleStartReview = () => {
    setReviewMode(true);
  };

  const handleExitReview = () => {
    setReviewMode(false);
    restoreSavedCategory();
    setPage('wordlist');
    setWordListRefreshKey(k => k + 1);
  };

  // Leaving the welcome gate (Guest Mode click, or a login that started
  // there) drops the user onto Learn. The core owns the transition itself —
  // WelcomePage calls auth.chooseGuest()/login directly — so App only reacts
  // to the falling edge. primeAudio runs inside the click's user-activation
  // window, so iOS still unlocks the first word's auto-speak.
  const welcomeVisible =
    !IS_WECHAT && (
      (auth.status === 'guest' && auth.atWelcome) ||
      (auth.status === 'authenticating' && auth.flow?.surface === 'welcome')
    );
  const prevWelcomeRef = useRef(false);
  useEffect(() => {
    if (prevWelcomeRef.current && !welcomeVisible) {
      primeAudio();
      setPage('learn');
      setReviewMode(false);
    }
    prevWelcomeRef.current = welcomeVisible;
  }, [welcomeVisible]);

  const handleLogout = () => {
    // Explicit logout: one core call. State flips to guest-at-welcome
    // synchronously (WelcomePage renders as the login screen per "用户主动点击
    // log out，应该回到 login界面"), the account's local cache stays for the
    // next optimistic boot, and the language pick is untouched so nothing
    // re-prompts the picker.
    setReviewMode(false);
    auth.signOut();
  };

  // Called by LearningPage when a new word is presented. The per-word
  // debounced cloud push that used to live here was retired — storage.js
  // now dispatches 'app:progress-changed' on every saveProgress, which
  // sets localDirty, and the (5-min) heartbeat / visibilitychange / pagehide
  // flushers above pick it up. That eliminates the ~3 pushes/minute peak
  // and cuts cloud egress by ~95% while keeping cross-device sync working
  // (visibilitychange fires the moment the user switches devices).
  // Kept as a prop for LearningPage's stable API; intentional no-op.
  const handleWordViewed = () => {};

  // Called by LearningPage BEFORE it processes an answer click / skip /
  // Got-it tap. Returns false when the guest has reached the free quota —
  // gate modal pops, the answer is discarded. Returns true otherwise.
  // Wired so the user never sees their answer register + the next word
  // advance behind the gate. Count comes from `countLearnedWords(userScope)`
  // which reads the per-uid progress slot the user's word list already shows.
  const requestNextWord = () => {
    if (!auth.ready) return true; // boot window: never gate on an unsettled scope
    // DEV-only test hook: lets the monkey/screenshot suite roam past the
    // 5-word gate in any browser UA (only WeChat is exempt at runtime). Inert
    // in production — import.meta.env.DEV is false after `vite build`, so this
    // can never disable the real gate for end users.
    if (import.meta.env.DEV) {
      try { if (localStorage.getItem('__test_no_gate') === '1') return true; } catch {}
    }
    // isAccountScope (not isRealAccount): during the brief boot window an
    // account's optimistic scope must not count words into the guest gate.
    if (auth.isAccountScope || IS_WECHAT) return true;
    // Returning user (this device once held a real account and is back in
    // guest mode). No free quota — the very first word triggers the gate; the
    // welcome-back subtitle comes from the same snapshot hadAccount inside
    // LoginPromptModal.
    if (auth.hadAccount) {
      setLoginModal({ surface: 'gate' });
      return false;
    }
    if (countLearnedWords('guest') >= GATE_FREE_LIMIT) {
      setLoginModal({ surface: 'gate' });
      return false;
    }
    return true;
  };

  const handleLangSetupComplete = ({ native, target }) => {
    // Lang-setup completion is a user gesture (click on the Confirm button).
    // Prime audio inside the gesture so the first word's auto-speak plays on
    // iOS Safari when the user drops straight into Learn.
    primeAudio();
    setNativeLang(native);
    setTargetLang(target);
    localStorage.setItem('app_native', native);
    localStorage.setItem('app_target', target);
    setNeedsLangSetup(false);
    // First-time visitors land here as their entry screen and drop straight
    // into Learn — a fresh device is already a playing guest in the new core
    // (no promotion step, no Welcome page in between).
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

  // Per-user storage scope, straight from the core: 'guest' (the device's ONE
  // persistent local sandbox) or `u_<uid>`. Slot names are unchanged from the
  // old stack, so account data carries over untouched. The in-app shell below
  // is keyed on it — a scope flip remounts the pages so SRS state rebuilds
  // cleanly instead of flashing mid-session.
  const userScope = auth.userScope;

  // Show language setup for first-time visitors AND for logged-in accounts
  // that haven't picked a language yet. Brand-new visitors land here as
  // their entry screen; completing it promotes them to guest mode and they
  // drop straight into Learn (no Welcome page).
  if (needsLangSetup) {
    return (
      <div className="w-screen bg-white flex items-center justify-center font-cute overflow-hidden" style={{ height: vpH }}>
        <div className="w-full max-w-[402px] h-[841px] overflow-hidden sm:rounded-[2rem] relative" style={{ maxHeight: vpH }}>
          <LanguageSetupPage onComplete={handleLangSetupComplete} nativeLang={nativeLang} />
          {/* A2HS first-open: a fresh container has no app_native either, so
              the picker is what renders during the ~1s cookie handoff — keep
              the spinner over it until the account (and its saved langs) land. */}
          <HandoffVeil style={{ zIndex: 60 }} />
        </div>
      </div>
    );
  }

  // (The old scopeFinalized placeholder gate is gone: the core boots
  // synchronously under the persisted optimistic scope, so the common path
  // renders the right slot on the first frame with nothing to wait for.)

  // Welcome/logged-out gate (explicit logout, or a returning account whose
  // token died) — plus any login flow it launched (spinner / email form),
  // which WelcomePage renders internally. Never shown in WeChat: the
  // auto-chooseGuest effect above re-enters the guest sandbox instead.
  if (welcomeVisible) {
    return (
      <div className="w-screen bg-white flex items-center justify-center font-cute overflow-hidden" style={{ height: vpH }}>
        <div className="w-full max-w-[402px] h-[841px] overflow-hidden sm:rounded-[2rem] relative" style={{ maxHeight: vpH }}>
          <WelcomePage />
        </div>
      </div>
    );
  }

  // Page was killed mid-OTP (from the gate or Settings) → restore the verify
  // pane full-screen; it recovers the in-flight email from the core's flow.
  const restoredEmailPane =
    !loginModal && auth.status === 'authenticating' && auth.flow?.kind === 'otp';

  return (
    <div className="w-screen flex items-center justify-center font-cute overflow-hidden" style={{ height: vpH, backgroundColor: '#ffffff' }}>
      {/* key={userScope}: a scope flip (login/logout/sign-up) remounts the
          whole in-app shell so every page re-reads its slot — the SRS queue
          rebuilds once, cleanly, instead of flashing mid-word. */}
      <div key={userScope} className="w-full max-w-[402px] h-[841px] flex flex-col overflow-hidden sm:rounded-[2rem] relative bg-warm-bg" style={{ maxHeight: vpH }}>

        {/* Main content — all pages stay mounted to preserve state; display:none hides inactive ones */}
        <div className="flex-1 min-h-0 overflow-visible">
          <div style={{ display: (page === 'learn' || reviewMode) ? undefined : 'none', height: '100%' }}>
            <LearningPage
              isReview={reviewMode}
              onExitReview={handleExitReview}
              nativeLang={nativeLang}
              targetLang={targetLang}
              userScope={userScope}
              selectedCategory={learningCategory}
              selectedLevel={learningLevel}
              onCategoryChange={handleCategoryChange}
              contentHFromParent={Math.max(0, vpH - (categoryModalOpen ? 0 : navH) - 2)}
              onLevelChange={handleLevelChange}
              isVisible={(page === 'learn' || reviewMode) && checkinDay == null && loginModal?.surface !== 'gate'}
              onCategoryModalChange={setCategoryModalOpen}
              onWordViewed={handleWordViewed}
              requestNextWord={requestNextWord}
              refreshKey={progressRefreshKey}
              userEmail={session?.user?.email || ''}
              // 'loading' = boot hasn't resolved getSession yet; 'authenticating'
              // = a login flow is mid-air. Either way `userEmail` is not yet
              // trustworthy, so LearningPage must not act on it.
              authPending={auth.status === 'loading' || auth.status === 'authenticating'}
            />
          </div>
          <div style={{ display: (page === 'wordlist' && !reviewMode) ? undefined : 'none', height: '100%' }}>
            <WordListPage
              onStartReview={handleStartReview}
              nativeLang={nativeLang}
              targetLang={targetLang}
              userScope={userScope}
              refreshKey={wordListRefreshKey}
              userEmail={session?.user?.email || ''}
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
              // Settings's login entries route through App so the single
              // LoginPromptModal instance (below) renders them. The
              // bindOAuthPending prop still gates SettingsPage's applyUser
              // fetch — no identity flash while a login flow is resolving.
              bindOAuthPending={auth.status === 'authenticating'}
              onOpenLoginPrompt={() => setLoginModal({ surface: 'settings' })}
            />
          </div>
        </div>

        {/* Bottom tab bar */}
        <div className="shrink-0 relative overflow-visible" style={{ height: categoryModalOpen ? 0 : navH, backgroundColor: '#2b2a26', overflow: categoryModalOpen ? 'hidden' : undefined }}>
          {/* Nav separator line at top */}
          <img
            src={getFigmaAssetUrl('nav-separator.png')}
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
                data-tab={tab.key}
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
            style={{ ...MODAL_SCRIM, zIndex: 50 }}
            onClick={handleCheckin}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                ...MODAL_CARD,
                width: 'min(353px, calc(100vw - 24px))',
                minHeight: showCheckinInstallHint ? 370 : 353,
                padding: '30px 24px 28px',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between',
              }}
            >
              <PopClose onClick={handleCheckin} />
              <p style={{ ...MODAL_TITLE }}>
                {t.checkinTitle || '每日打卡'}
              </p>
              <p style={{ textAlign: 'center', fontSize: 16, color: '#3A2E2E', lineHeight: 2.0, margin: 0, whiteSpace: 'pre-line' }}>
                {(t.checkinFmt || '累计登录第 {n} 天\nヾ(◍°∇°◍)ﾉﾞ').replace('{n}', checkinDay)}
              </p>
              <button
                onClick={handleCheckin}
                className="active:scale-95"
                style={CTA_SOLO}
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
                      // Unlock audio + record dismissal first, then open install modal.
                      // installModalNode renders at z-60 so it overlays the check-in popup.
                      // `replay: false` — user is going to the install hint, not into
                      // learn, so the queued first-word speak must not play behind the
                      // install modal.
                      primeAudio({ replay: false });
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
                    <img
                      src="/icons/apple-touch-icon.png"
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

        {/* Single LoginPromptModal instance — the 5-word gate (Learn) and the
            Settings entries both open this. The new modal owns its whole flow
            internally (merged "Log in or sign up" door, OAuth pending spinner,
            inline errors, email pane); it also self-restores in pending state
            after an OAuth round trip via the bindingSurface effect above.
            Closing/landing is handled by the isRealAccount effect. */}
        {loginModal && !auth.isRealAccount && (
          <LoginPromptModal
            surface={loginModal.surface}
            onClose={() => setLoginModal(null)}
            onDone={() => { /* close + return-to-page handled by the isRealAccount effect */ }}
          />
        )}

        {/* page killed mid-OTP → restore the verify pane; it recovers the
            in-flight email from the core's flow marker */}
        {restoredEmailPane && (
          <div className="absolute inset-0 z-40">
            <EmailLoginPage
              initialStep="verify"
              surface={auth.flow?.surface || 'welcome'}
              onBack={() => {}}
              onDone={() => {}}
            />
          </div>
        )}

        {/* A2HS first-open: the ~1s guest window while the mirror cookie is
            being redeemed gets a spinner over the page instead of a guest
            shell that flips into the account (login-auth-ui/HandoffVeil.jsx). */}
        <HandoffVeil style={{ zIndex: 60 }} />

        {/* post-login greeting toast (account-created / welcome-back) */}
        {noticeToast && (
          <div
            className="absolute left-1/2 -translate-x-1/2 z-[60] pointer-events-none"
            style={{
              bottom: 90, maxWidth: 320, padding: '10px 18px', borderRadius: 14,
              background: 'rgba(0,0,0,0.8)', color: '#fff', fontSize: 14,
              textAlign: 'center', lineHeight: 1.4,
            }}
          >
            {noticeToast.msg}
          </div>
        )}

      </div>
      <Analytics />
    </div>
  );
}
