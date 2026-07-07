import { useState, useEffect, useRef, useReducer } from 'react';
import LearningPage from './components/LearningPage';
import WordListPage from './components/WordListPage';
import SettingsPage from './components/SettingsPage';
import LanguageSetupPage from './components/LanguageSetupPage';
import WelcomePage from './components/WelcomePage';
import LoginPromptModal from './components/LoginPromptModal';
import { migrateOldProgress, migrateProgressToTargetOnly, migrateProgressToUserScope, migrateClearStaleGateWords, migrateScopesToAnon, bumpLoginDay, shouldShowCheckin, markCheckinShown, getLoginDayCount } from './utils/storage';
import { syncOnLogin, pushLocalToCloud } from './utils/progressSync';
import { primeAudio, playSlaySound, preloadAudioManifest } from './hooks/useAudio';
import { useInstallPrompt } from './hooks/useInstallPrompt';
import { UI_TEXT } from './utils/langHelpers';
import { getFigmaAssetUrl } from './utils/assetUrl';
import { useAuth, STATUS } from './auth/useAuth.js';
import { migrateLegacyAuthFlags } from './auth/legacyFlags.js';
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

// Run migrations once on module load. migrateLegacyAuthFlags MUST run before
// the first useAuth() mount — it folds the pre-machine auth flags into
// auth.snapshot.v1, which the machine's BOOT reads.
migrateOldProgress();
migrateProgressToTargetOnly();
migrateProgressToUserScope();
migrateClearStaleGateWords();
migrateLegacyAuthFlags();

// The selected learning category persists indefinitely across sessions/logins —
// returning users always resume on their last-chosen category (never auto-reset
// to "all"). See `learningCategory` init below (reads `app_learning_category`).

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

// Single source of truth for WHICH surface has the LoginPromptModal open and
// in what mode. Pure UI concern now: pending/error/round-trip restoration all
// live in the auth machine (useAuth reads them from the persisted snapshot),
// so the reducer shrank to open/surface/flowType/emailMode. One modal
// instance rendered in App below keeps "stacked popups" structurally
// impossible.
//
//   surface   — 'gate' (5-word gate on Learn) or 'settings' (Sign up / Log
//               in from the Settings tab).
//   flowType  — 'bind' (attach to current guest, keeps uid) or 'login'
//               (switch account; the machine folds the guest's local data
//               into the account scope).
//   emailMode — pre-selected mode for the Email sub-form: 'signup' | 'login'.
function loginModalReducer(state, action) {
  switch (action.type) {
    case 'open':
      return {
        open: true,
        surface: action.surface,
        flowType: action.flowType || 'bind',
        emailMode: action.emailMode || 'signup',
      };
    case 'close':
      return { ...state, open: false };
    default:
      return state;
  }
}

function initialLoginModal() {
  return { open: false, surface: 'settings', flowType: 'bind', emailMode: 'signup' };
}

export default function App() {
  const posthog = usePostHog();
  // The auth state machine owns everything the old session/authReady/
  // anonAttemptFailed/gateTimedOut/isGuest block tracked. Key mappings:
  //   session        → auth.session
  //   authReady      → auth.ready (machine watchdog caps INITIALIZING ≤4s)
  //   scope flash    → auth.userScope boots from the persisted lastUserScope,
  //                    so a returning guest renders with their real scope
  //                    immediately (no 'guest' → u_<uid> remount flash)
  //   isGuest/logout → status !== LOGGED_OUT (explicit logout is machine state)
  const auth = useAuth();
  const { session } = auth;
  // First-time visitors with no language picked land on LanguageSetupPage.
  // Existing users (app_native set) skip it.
  const [needsLangSetup, setNeedsLangSetup] = useState(() => !localStorage.getItem('app_native'));
  // 5-free-word gate: when a guest has learned GATE_FREE_LIMIT distinct
  // words (lifetime, per anon uid) and tries to advance, we show the
  // LoginPromptModal. WeChat in-app browser users are exempt (OAuth doesn't
  // reliably work there). Logged-in users are also exempt.
  const [loginModal, dispatchLoginModal] = useReducer(loginModalReducer, undefined, initialLoginModal);
  // A bind/login round-trip is resolving (OAuth redirect out+home, or the
  // email-bind verify pane). Guards that used to read *_oauth_pending flags
  // key off the machine state instead.
  const bindOAuthPending = auth.status === STATUS.BINDING;
  // True while the initial cloud→local merge (`syncOnLogin`) is running for
  // a real, non-anon session. The check-in popup is gated on this so it
  // doesn't paint "第1天" using the local-only count that bumpLoginDay just
  // wrote — the popup waits until syncOnLogin has merged in the historical
  // cloud days, then renders the correct total.
  const [syncInFlight, setSyncInFlight] = useState(false);
  const [page, setPage] = useState('learn');
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
  // belong to specific intentional-entry callsites: handleCheckin,
  // handleLogin, handleLangSetupComplete, EmailLoginPage's submit.
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

  // Per-session identity plumbing: login-day bump, posthog identify, and the
  // one-time legacy guest-slot migration for anonymous uids. The machine owns
  // session lifecycle (mint / re-mint / expiry / scope merges), so this is
  // pure observation — no signInAnonymously, no SIGNED_OUT forensics.
  useEffect(() => {
    const u = session?.user;
    bumpLoginDay(u?.id);
    if (!u) return;
    posthog?.identify(u.id, { email: u.email });
    if (u.is_anonymous) {
      // Move legacy device-global 'guest_*' slots into this anon uid's scope
      // (idempotent, per-uid flag) and absorb any app_anon_data_to_migrate
      // carry-over stashed by the pre-machine code.
      migrateScopesToAnon(u.id);
    }
  }, [session?.user?.id]);

  // Cloud sync on real login. The machine already folded the guest's local
  // data into this account's scope (mergeScopes effect, synchronous) before
  // React re-rendered, so syncOnLogin just pull-merge-pushes the uid's own
  // slot. Anonymous users stay local-only — no cloud row until they bind.
  useEffect(() => {
    if (auth.status !== STATUS.AUTHED) return;
    const uid = session?.user?.id;
    if (!uid) return;
    // Flip BEFORE awaiting so the check-in effect defers its popup until the
    // historical login_days have been merged in.
    setSyncInFlight(true);
    syncOnLogin(uid)
      .then(() => {
        // Cloud preferences may have restored the account's saved langs; a
        // cloud row with none leaves the device's pick alone. No app_native
        // at all → this account never onboarded → show the picker.
        try {
          const n = localStorage.getItem('app_native');
          const tg = localStorage.getItem('app_target');
          if (n) setNativeLang(n);
          if (tg) setTargetLang(tg);
          if (!n) setNeedsLangSetup(true);
        } catch {}
      })
      .catch((e) => console.warn('[auth] syncOnLogin failed:', e?.message || e))
      .finally(() => {
        setSyncInFlight(false);
        // Tell LearningPage + WordListPage to re-read progress from
        // localStorage — the merge may have pulled another device's rows.
        setProgressRefreshKey(k => k + 1);
        setWordListRefreshKey(k => k + 1);
      });
  }, [auth.status, session?.user?.id]);

  // An OAuth round-trip (or a page kill mid-flow) restores BINDING from the
  // snapshot at boot — reopen the modal on whichever surface launched it so
  // the pending pane / error pane has a host. 'welcome' surface renders on
  // WelcomePage itself, not in the modal.
  useEffect(() => {
    if (auth.status !== STATUS.BINDING || !auth.bind) return;
    if (auth.bind.surface === 'welcome') return;
    if (!loginModal.open) {
      dispatchLoginModal({
        type: 'open',
        surface: auth.bind.surface === 'gate' ? 'gate' : 'settings',
        flowType: auth.bind.mode === 'login' ? 'login' : 'bind',
        emailMode: auth.bind.mode === 'login' ? 'login' : 'signup',
      });
      if (auth.bind.surface === 'settings') setPage('settings');
    }
  }, [auth.status, auth.bind, loginModal.open]);

  // Same restoration for a login-OTP verify pane that survived a page kill
  // (OTP_PENDING at boot). Welcome-side OTP renders on WelcomePage.
  useEffect(() => {
    if (auth.status !== STATUS.OTP_PENDING) return;
    if (auth.otpReturn === STATUS.LOGGED_OUT) return;
    if (!loginModal.open) {
      dispatchLoginModal({ type: 'open', surface: 'settings', flowType: 'login', emailMode: 'login' });
    }
  }, [auth.status, auth.otpReturn, loginModal.open]);

  // A bind rejection routed to the Settings surface should land the user on
  // Settings (the gate surface stays on Learn) — the modal shows the error
  // pane from auth.bindError either way.
  useEffect(() => {
    if (auth.bindError && loginModal.open && loginModal.surface === 'settings') {
      setPage('settings');
    }
  }, [auth.bindError, loginModal.open, loginModal.surface]);

  // Close the 5-word gate as soon as the account is real. auth.isRealAccount
  // only goes true AFTER the machine concluded the round trip (BIND_OK), so
  // there's no flash-closed-then-error window; a queued bindError keeps the
  // modal open on its error pane.
  useEffect(() => {
    if (auth.isRealAccount && loginModal.open && !auth.bindError) {
      dispatchLoginModal({ type: 'close' });
    }
  }, [auth.isRealAccount, loginModal.open, auth.bindError]);

  // Background sync: while signed in (NON-anon), pull-merge-push the local
  // snapshot against the cloud row on relevant lifecycle events. Anon users
  // stay local-only — no cloud row until they bind into an account.
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
    const uid = session?.user?.id;
    if (!uid) return;
    if (session.user.is_anonymous) return;
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
  }, [session?.user?.id]);

  // Push immediately when language preferences change so the cloud reflects
  // the user's latest pick — without waiting for the visibilitychange /
  // heartbeat flush. Ensures re-login on another device (or after sign-out)
  // restores the same lang combo. Skipped during sync to avoid clobbering a
  // freshly-pulled cloud value with the in-flight local state. Anon users
  // stay local-only (see the heartbeat useEffect above).
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    if (session.user.is_anonymous) return;
    pushLocalToCloud(uid);
  }, [session?.user?.id, nativeLang, targetLang]);

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
  //
  // During a bind attempt (guest → account), skip this entirely. Two reasons:
  // (1) If the bind is rejected, we'd flash the LangSetup screen for a beat
  //     between SIGNED_IN and the subsequent signOut — unmounting Settings
  //     and the in-form rejection error along with it, leaving the user
  //     dumped on the Learn page with no idea what happened.
  // (2) If the bind succeeds, the guest already chose their langs in test
  //     mode (they're in localStorage), so re-prompting is annoying. We
  //     auto-mark `lang_onboarded_<uid>` after a successful bind in
  //     runSyncOrReject / finishAuth so this useEffect lands on `false` on
  //     the next render.
  useEffect(() => {
    // `app_native` is the ONLY source of truth for whether the language
    // picker should show. It's set once when the user first uses the device
    // (either through LanguageSetupPage or a previous session) and never
    // cleared by logout/login/account-switch. So the picker fires only when
    // the device has truly never picked a language.
    //
    // Suppressed while a bind/OTP flow is resolving so the picker doesn't
    // flash on top of the modal mid-round-trip.
    if (bindOAuthPending || auth.status === STATUS.OTP_PENDING || auth.bindError) {
      setNeedsLangSetup(false);
      return;
    }
    setNeedsLangSetup(!localStorage.getItem('app_native'));
  }, [auth.status, auth.bindError, session?.user?.id, bindOAuthPending]);

  // Daily check-in popup: show once per local-calendar day after the user is
  // past login + language setup. bumpLoginDay has already added today's date.
  // Also wait until pwaInstalled is known (not null) so the install hint
  // inside the popup paints with the correct state from the first frame.
  useEffect(() => {
    if (!auth.ready || needsLangSetup) return;
    if (pwaInstalled === null) return;
    // Skip the check-in while a guest→account bind is still resolving (just
    // returned from OAuth) or its rejection error is queued to surface in the
    // Settings modal. Without this guard the user gets a check-in popup on
    // the Learn page *before* we route them to Settings to see the error.
    if (bindOAuthPending) return;
    if (auth.bindError) return;
    // Guests + anonymous Supabase sessions don't see the check-in popup —
    // the cumulative-day count is only meaningful for real (cloud-synced)
    // accounts. Guests learn straight away; the popup appears only after
    // they bind into a real account.
    if (!auth.isRealAccount) return;
    // Wait for the initial cloud sync to finish — otherwise getLoginDayCount
    // reads only `[today]` (what bumpLoginDay just wrote) and paints "第1天"
    // even for accounts with a long history on other devices.
    if (syncInFlight) return;
    const uid = session.user.id;
    if (shouldShowCheckin(uid)) {
      setCheckinDay(getLoginDayCount(uid));
    }
  }, [auth.ready, auth.isRealAccount, needsLangSetup, session, pwaInstalled, auth.bindError, bindOAuthPending, syncInFlight]);

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
    // Tab click is a user gesture — unlock audio so subsequent auto-speaks
    // play on iOS Safari. `replay: false` because the user is switching
    // tabs, not entering learn: a queued first-word speak (set during an
    // OAuth-return mount on learn) must NOT play onto WordList / Settings.
    // The deferred slot is drained inside primeAudio so it can't fire later.
    primeAudio({ replay: false });
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
    // Called from WelcomePage's Guest Mode link. The machine mints a FRESH
    // anon uid (fresh game) and clears explicitLogout — a logged-out
    // account's scope must never leak into the next guest.
    dispatchLoginModal({ type: 'close' });
    // Unlock audio inside this user gesture — without it, the auto-speak on
    // the first word after login is silent on iOS Safari (the audio context
    // stays suspended until any subsequent user gesture).
    primeAudio();
    auth.chooseGuest();
    setPage('learn');
    setReviewMode(false);
  };

  const handleLogout = () => {
    // Explicit logout → machine persists explicitLogout, signs supabase out,
    // lands on LOGGED_OUT → WelcomePage renders (per requirement "用户主动
    // 点击log out，应该回到 login界面"). Language pick and local progress
    // stay in place. Do NOT switch to the Learn tab here — the WelcomePage
    // teardown covers the visual transition; handleLogin restores
    // page='learn' on re-entry.
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
    if (!auth.ready) return true;
    // DEV-only test hook: lets the monkey/screenshot suite roam past the
    // 5-word gate in any browser UA (only WeChat is exempt at runtime). Inert
    // in production — import.meta.env.DEV is false after `vite build`, so this
    // can never disable the real gate for end users.
    if (import.meta.env.DEV) {
      try { if (localStorage.getItem('__test_no_gate') === '1') return true; } catch {}
    }
    if (auth.isRealAccount || IS_WECHAT) return true;
    // Returning user (this device has previously held a real account and is
    // now back in guest mode). No free quota — the very first word triggers
    // the gate, opened in "Sign in" mode. The welcome-back subtitle is
    // derived inside LoginPromptModal from the same hadAccount snapshot bit.
    if (auth.hadAccount) {
      dispatchLoginModal({ type: 'open', surface: 'gate', flowType: 'login', emailMode: 'login' });
      return false;
    }
    if (countLearnedWords(userScope) >= GATE_FREE_LIMIT) {
      dispatchLoginModal({ type: 'open', surface: 'gate', flowType: 'bind', emailMode: 'signup' });
      return false;
    }
    return true;
  };

  const handleGateDismiss = () => {
    // Just close the modal. The next requestNextWord call past the limit
    // will re-open it — there's no per-day suppression anymore. Reducer's
    // 'close' also clears any rejection error so a re-open starts fresh.
    dispatchLoginModal({ type: 'close' });
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
    if (session?.user?.id) {
      localStorage.setItem('lang_onboarded_' + session.user.id, 'true');
    }
    setNeedsLangSetup(false);
    // First-time visitors land here as their initial screen; the machine has
    // already minted (or is minting) their anon session in the background, so
    // completing the picker drops straight into the learning UI.
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

  // Per-user storage scope. Each account on the device — including the
  // anonymous guest — gets its own slot in localStorage so progress, review
  // state, and review-word data don't bleed between accounts. The machine
  // derives it (u_<uid> / legacy 'guest') and boots it optimistically from
  // the persisted lastUserScope, so returning users render with the right
  // scope before the network resolves.
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
        </div>
      </div>
    );
  }

  // Hold the shell on the study-background placeholder only while the
  // machine is INITIALIZING (getSession in flight). Its built-in watchdog
  // caps this at 4s, and the optimistic lastUserScope means a returning
  // user's scope is already correct — GUEST_LEGACY / minting states render
  // the app normally instead of blocking (铁律2: render first).
  if (!auth.ready && !loginModal.open) {
    // Background matches LearningPage's study_background.jpg exactly so the
    // gate → LearningPage swap is visually invisible. An earlier version
    // used bg-warm-bg (#FFF9F0 cream) which registered as a yellow flash
    // against the beige polka-dot LearningPage background.
    return (
      <div className="w-screen flex items-center justify-center font-cute overflow-hidden" style={{ height: vpH, backgroundColor: '#ffffff' }}>
        <div className="w-full max-w-[402px] h-[841px] overflow-hidden sm:rounded-[2rem] relative" style={{ maxHeight: vpH }}>
          <img
            src={getFigmaAssetUrl('study_background.jpg')}
            alt=""
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          />
        </div>
      </div>
    );
  }

  // After-logout login screen (machine state LOGGED_OUT). Also hosts the
  // tail of a welcome-launched flow that survived a reload: an OAuth
  // round-trip coming home (BINDING, surface 'welcome') or a login-OTP
  // verify pane (OTP_PENDING whose exit falls back to LOGGED_OUT).
  // app_native is still set, so the language picker doesn't re-fire.
  if (
    auth.status === STATUS.LOGGED_OUT
    || (auth.status === STATUS.BINDING && auth.bind?.surface === 'welcome')
    || (auth.status === STATUS.OTP_PENDING && auth.otpReturn === STATUS.LOGGED_OUT)
  ) {
    return (
      <div className="w-screen bg-white flex items-center justify-center font-cute overflow-hidden" style={{ height: vpH }}>
        <div className="w-full max-w-[402px] h-[841px] overflow-hidden sm:rounded-[2rem] relative" style={{ maxHeight: vpH }}>
          <WelcomePage onLogin={handleLogin} onTestMode={handleLogin} nativeLang={nativeLang} />
        </div>
      </div>
    );
  }

  return (
    <div className="w-screen flex items-center justify-center font-cute overflow-hidden" style={{ height: vpH, backgroundColor: '#ffffff' }}>
      <div className="w-full max-w-[402px] h-[841px] flex flex-col overflow-hidden sm:rounded-[2rem] relative bg-warm-bg" style={{ maxHeight: vpH }}>

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
              isVisible={(page === 'learn' || reviewMode) && checkinDay == null && !(loginModal.open && loginModal.surface === 'gate')}
              onCategoryModalChange={setCategoryModalOpen}
              onWordViewed={handleWordViewed}
              requestNextWord={requestNextWord}
              refreshKey={progressRefreshKey}
              userEmail={session?.user?.email || ''}
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
              // Settings's Sign-up / Log-in entries route through App so the
              // single LoginPromptModal instance (below) can render them. The
              // bindOAuthPending prop still gates SettingsPage's identity
              // display — avoids flashing the wrong identity while a bind
              // round-trip is resolving.
              bindOAuthPending={bindOAuthPending && loginModal.surface === 'settings'}
              onOpenLoginPrompt={({ flowType, emailMode }) => {
                dispatchLoginModal({ type: 'open', surface: 'settings', flowType, emailMode });
              }}
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
                  backgroundColor: '#FFDF4E',
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

        {/* Single LoginPromptModal instance. The reducer owns whether/which-
            surface to render; the machine owns pending/error/round-trip
            state, which the modal reads via useAuth() itself. One instance =
            no stacked-popup class of bug. */}
        {loginModal.open && (
          <LoginPromptModal
            nativeLang={nativeLang}
            surface={loginModal.surface}
            initialEmailMode={loginModal.emailMode}
            flowType={loginModal.flowType}
            onClose={() => dispatchLoginModal({ type: 'close' })}
            onLoggedIn={() => dispatchLoginModal({ type: 'close' })}
          />
        )}

      </div>
      <Analytics />
    </div>
  );
}
