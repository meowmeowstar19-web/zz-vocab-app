import { useState, useEffect, useRef } from 'react';
import LearningPage from './components/LearningPage';
import WordListPage from './components/WordListPage';
import SettingsPage from './components/SettingsPage';
import LanguageSetupPage from './components/LanguageSetupPage';
import WelcomePage from './components/WelcomePage';
import LoginPromptModal from './components/LoginPromptModal';
import { migrateOldProgress, migrateProgressToTargetOnly, migrateProgressToUserScope, migrateClearStaleGateWords, migrateScopesToAnon, bumpLoginDay, shouldShowCheckin, markCheckinShown, getLoginDayCount } from './utils/storage';
import { syncOnLogin, pushLocalToCloud } from './utils/progressSync';
import { primeAudio } from './hooks/useAudio';
import { useInstallPrompt } from './hooks/useInstallPrompt';
import { UI_TEXT } from './utils/langHelpers';
import { supabase } from './lib/supabase';
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
migrateProgressToUserScope();
migrateClearStaleGateWords();

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
  // True once supabase.auth.getSession() has resolved. Before this resolves,
  // `session` is null even for real logged-in users — so handleWordViewed
  // would treat them as guests and pollute `gate_words_${today}`. Logged-in
  // pollution then surfaces as the gate firing on the 3rd word (or
  // immediately on guest entry) for the SAME device after a sign-out.
  const [authReady, setAuthReady] = useState(false);
  // Device-based "already onboarded" check: once the user has picked their
  // native+target language (which writes app_native) AND hasn't explicitly
  // logged out, they enter the app as a guest on every subsequent visit
  // without seeing the Welcome page. handleLogout sets `app_logged_out=1`
  // to break the auto-promotion until the user re-enters (either through
  // WelcomePage's Guest Mode link or a successful sign-in).
  //
  // Migration: existing users who have `app_native` set from before this
  // flag existed should still auto-promote — only an explicit logout sets
  // `app_logged_out`. So absence of the flag is treated as "still a guest".
  const [isGuest, setIsGuest] = useState(() => {
    const hasLang = !!localStorage.getItem('app_native');
    const explicitlyLoggedOut = localStorage.getItem('app_logged_out') === '1';
    if (hasLang && !explicitlyLoggedOut && localStorage.getItem('app_logged_in') !== 'true') {
      try { localStorage.setItem('app_logged_in', 'true'); } catch {}
    }
    if (explicitlyLoggedOut) return false;
    return hasLang || localStorage.getItem('app_logged_in') === 'true';
  });
  const isLoggedIn = !!session || isGuest;
  // First-time visitors with no language picked land on LanguageSetupPage.
  // Existing users (app_native set) skip it.
  const [needsLangSetup, setNeedsLangSetup] = useState(() => !localStorage.getItem('app_native'));
  // 5-free-word gate: when a guest has learned GATE_FREE_LIMIT distinct
  // words (lifetime, per anon uid) and tries to advance, we show a forced
  // LoginPromptModal.
  // WeChat in-app browser users are exempt (OAuth doesn't reliably work
  // there). Logged-in users are also exempt.
  //
  // Initial state: if we're coming back from an OAuth round-trip that was
  // initiated from the gate (gate_oauth_pending = 1), the gate modal should
  // re-open on Learn in pending state so the rejection — if any — can land
  // back inside it rather than getting routed to Settings.
  const [showLoginGate, setShowLoginGate] = useState(() => {
    try { return localStorage.getItem('gate_oauth_pending') === '1'; }
    catch { return false; }
  });
  // Rejection error to surface inside the gate modal when a gate-initiated
  // OAuth bind hits the "account already in use" path. Settings-initiated
  // binds use `bindModalError` and route to Settings; gate-initiated binds
  // stay on Learn and use this state instead.
  const [gateModalError, setGateModalError] = useState('');
  // When we return from a Google/Discord OAuth bind, one of two flags is set
  // depending on which surface launched it:
  //   - `bind_oauth_pending` (Settings "Sign up / Log in" pill) → land on
  //     Settings so its LoginPromptModal can show the success or rejection.
  //   - `gate_oauth_pending` (5-word/day gate on Learn) → land on Learn so
  //     the gate modal stays open and can host the rejection inline.
  // Tracked separately so each surface only sees its own pending state.
  const [settingsBindPending, setSettingsBindPending] = useState(() => {
    try { return localStorage.getItem('bind_oauth_pending') === '1'; }
    catch { return false; }
  });
  const [gateBindPending, setGateBindPending] = useState(() => {
    try { return localStorage.getItem('gate_oauth_pending') === '1'; }
    catch { return false; }
  });
  // Either-or convenience flag for guards that apply to both surfaces
  // (needsLangSetup suppression, check-in suppression).
  const bindOAuthPending = settingsBindPending || gateBindPending;
  const [page, setPage] = useState(() => {
    try {
      // gate_oauth_pending lands back on Learn (the gate was triggered while
      // studying). bind_oauth_pending lands on Settings (Sign up / Log in
      // initiated from Settings). gate takes precedence if somehow both set.
      if (localStorage.getItem('gate_oauth_pending') === '1') return 'learn';
      if (localStorage.getItem('bind_oauth_pending') === '1') return 'settings';
    } catch {}
    return 'learn';
  });
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
  // Shown when the user tried to bind from guest mode onto an account that
  // already has cloud progress. Toast message; null = hidden.
  const [bindToast, setBindToast] = useState(null);
  // Counterpart for OAuth bind rejection: pushed into SettingsPage so the
  // LoginPromptModal reopens with the error inline instead of routing through
  // a global toast on the Learn page.
  const [bindModalError, setBindModalError] = useState('');
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
  // prime audio inside that gesture, and detach. handleCheckin /
  // handleLogin / install-hint button already prime in their own gesture
  // handlers — this is purely the fallback for everything else (OAuth
  // return, email login submit, etc.).
  useEffect(() => {
    let primed = false;
    const onGesture = () => {
      if (primed) return;
      primed = true;
      primeAudio();
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

  // Sync entry point — wraps syncOnLogin so the OAuth bind path can detect
  // "this account already has progress" and refuse to merge. Soft signOut
  // (keeps guest mode + local data intact) on rejection.
  //
  // EmailLoginPage runs the same check *inline* and signals via
  // `bind_inline_active` that it owns the rejection UI for this auth event —
  // we bail out here so the user doesn't get a global toast on top of (or
  // moments after) the in-form red error. Without this guard, both handlers
  // fire concurrently: the form shows its error, then the global toast pops
  // and the modal closes, dumping the user back to Settings.
  const runSyncOrReject = async (uid) => {
    try {
      if (localStorage.getItem('bind_inline_active') === '1') return;
    } catch {}
    // Read the bind context flags up-front. syncOnLogin no longer clears
    // `bind_flow_active` on rejection — it stays set so any delayed parallel
    // call (INITIAL_SESSION waiting on supabase's internal lock can arrive
    // after the first syncOnLogin's inFlight resolves) also rejects instead
    // of treating itself as a normal login and merging the rejected
    // account's cloud data into the guest's localStorage.
    const wasBindFlow = (() => {
      try { return localStorage.getItem('bind_flow_active') === '1'; }
      catch { return false; }
    })();
    // Capture which surface launched the OAuth BEFORE we await syncOnLogin.
    // Without snapshotting here, a parallel runSyncOrReject call (the
    // getSession + onAuthStateChange listeners both fire on OAuth return,
    // both share the same `inFlight` syncOnLogin promise, and both await
    // the rejection result) would race against the first caller's `finally`
    // block — which clears these flags — and end up reading them as `false`,
    // mis-routing the rejection to Settings even when the gate launched it.
    const wasGateOAuth = (() => {
      try { return localStorage.getItem('gate_oauth_pending') === '1'; }
      catch { return false; }
    })();
    const wasSettingsOAuth = (() => {
      try { return localStorage.getItem('bind_oauth_pending') === '1'; }
      catch { return false; }
    })();
    const wasOAuthPending = wasGateOAuth || wasSettingsOAuth;
    try {
      const result = await syncOnLogin(uid);
      // Pick up any language preferences restored from the cloud snapshot so
      // re-login on a fresh device (or after switching accounts) lands on the
      // user's previously-saved langs instead of whatever the prior local
      // session had set. When the account has no saved preferences,
      // writeLocalSnapshot cleared the local keys — flip needsLangSetup so
      // the picker shows immediately for them.
      if (!result?.rejected) {
        try {
          const n = localStorage.getItem('app_native');
          const tg = localStorage.getItem('app_target');
          if (n) setNativeLang(n);
          if (tg) setTargetLang(tg);
          if (!n) setNeedsLangSetup(true);
        } catch {}
      }
      if (result?.rejected) {
        const msg = (UI_TEXT[nativeLang] || UI_TEXT.en).bindAccountTakenToast
          || 'This account already has progress. Please try a different one.';
        await supabase.auth.signOut();
        // Now that we've fully handled the rejection (signed out, no more
        // syncOnLogin calls can fire for this uid), clear the bind flag so a
        // future legitimate sign-in by this guest — e.g. they exit guest mode
        // and sign into a different account from Welcome — isn't mistakenly
        // treated as a bind attempt and rejected against THAT account's cloud
        // progress.
        try { localStorage.removeItem('bind_flow_active'); } catch {}
        // Route the rejection back to whichever surface launched the bind,
        // using the snapshot captured at function entry (see comment above).
        // Gate-initiated binds (user was studying when the 5-word gate fired)
        // stay on Learn — the gate modal reopens with the rejection inline.
        // Settings-initiated binds route to Settings as before.
        if (wasGateOAuth) {
          setGateModalError(msg);
          setShowLoginGate(true);
        } else {
          setBindModalError(msg);
          setPage('settings');
        }
        posthog?.capture('bind_account_rejected', { reason: result.reason });
      } else if (wasBindFlow && uid) {
        // Successful bind. The guest already picked native/target while in test
        // mode (those live in localStorage under app_native/app_target, which
        // are global, not per-user), so we don't need to re-prompt them with
        // the LangSetup wizard. Mark this account as onboarded.
        try { localStorage.setItem('lang_onboarded_' + uid, 'true'); } catch {}
      }
    } finally {
      // Only clear after routing — see comment above. Also flip the React
      // state copy so the check-in useEffect re-runs and can fire on
      // successful bind (after we stop suppressing it).
      try {
        localStorage.removeItem('bind_oauth_pending');
        localStorage.removeItem('gate_oauth_pending');
      } catch {}
      if (wasOAuthPending) {
        setSettingsBindPending(false);
        setGateBindPending(false);
      }
    }
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
      bumpLoginDay(data.session?.user?.id);
      if (data.session?.user) {
        posthog?.identify(data.session.user.id, {
          email: data.session.user.email,
        });
        // Step 1 of the anon-session refactor: anonymous users get the same
        // pull/merge/push treatment as real accounts, plus a one-time
        // migration of legacy `guest_*` localStorage slots into their
        // u_<anon_uid> scope. Stamp the active anon scope so a subsequent
        // bind flow can find it post-redirect (see progressSync.js).
        if (data.session.user.is_anonymous) {
          migrateScopesToAnon(data.session.user.id);
          try { localStorage.setItem('app_anon_scope', `u_${data.session.user.id}`); } catch {}
        }
        // Pull cloud progress, merge with local, push the union back up.
        // Skip for anonymous users — they stay local-only to avoid bloating
        // user_progress with rows for drive-by visitors and to keep the
        // anonymous `authenticated` role away from the cloud table entirely.
        // Their data is promoted to cloud only on a successful bind.
        if (!data.session.user.is_anonymous) {
          runSyncOrReject(data.session.user.id);
        }
      } else {
        // OAuth round-trip resulted in no session (user cancelled on the
        // provider, true OAuth failure, or the redirect raced ahead of
        // supabase parsing the hash). Clear any pending flags so the modal
        // can leave its "verifying…" state instead of hanging forever, and
        // the user sees the auth picker again on whichever surface launched
        // the attempt.
        let wasOauthRoundTrip = false;
        try {
          wasOauthRoundTrip = localStorage.getItem('bind_oauth_pending') === '1'
            || localStorage.getItem('gate_oauth_pending') === '1';
        } catch {}
        if (wasOauthRoundTrip) {
          try {
            localStorage.removeItem('bind_oauth_pending');
            localStorage.removeItem('gate_oauth_pending');
            localStorage.removeItem('bind_flow_active');
            localStorage.removeItem('bind_oauth_email_mode');
          } catch {}
          setSettingsBindPending(false);
          setGateBindPending(false);
        }
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      bumpLoginDay(s?.user?.id);
      if (s?.user) {
        // Don't blow away `app_logged_out` for anonymous sessions — that
        // flag is what stops the auto-promotion to guest after an explicit
        // logout. Only a real sign-in should clear it.
        if (!s.user.is_anonymous) {
          try { localStorage.removeItem('app_logged_out'); } catch {}
        }
        posthog?.identify(s.user.id, { email: s.user.email });
        // Persist the email so a dev-only escape hatch on Settings can still
        // identify the dev user after they drop into guest mode (where
        // supabase session is null and user.email is unavailable).
        if (s.user.email) {
          try { localStorage.setItem('app_last_email', s.user.email); } catch {}
        }
        if (s.user.is_anonymous) {
          // Migrate legacy 'guest_*' data into the anon scope and stamp the
          // scope pointer for the bind flow. We deliberately do NOT call
          // runSyncOrReject for anon users — they stay local-only.
          migrateScopesToAnon(s.user.id);
          try { localStorage.setItem('app_anon_scope', `u_${s.user.id}`); } catch {}
        } else {
          runSyncOrReject(s.user.id);
        }
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Step 1 of the anon-session refactor: every guest gets a real Supabase
  // anonymous session so the per-user storage scope (`u_<uid>`) replaces
  // the device-global 'guest' bucket. Fires when isGuest goes true and we
  // don't already have a session — covers brand-new visitors that just
  // finished LanguageSetupPage (handleLangSetupComplete sets isGuest) and
  // returning visitors whose stored anon session may have expired.
  //
  // The ref guards against double-firing if isGuest toggles off-then-on
  // while signInAnonymously is still in flight (each call would mint a
  // separate anon account on the server). onAuthStateChange resets it
  // once the session lands.
  //
  // Error handling: if anonymous sign-ins are DISABLED at the Supabase
  // project level the call rejects; we fall back silently to the legacy
  // 'guest' scope so the app keeps working (userScope derivation below
  // already handles the !session case).
  const anonInFlight = useRef(false);
  useEffect(() => {
    if (session) { anonInFlight.current = false; return; }
    if (!authReady) return;
    if (!isGuest) return;
    // Defensive: don't auto-recreate an anon session if the user explicitly
    // logged out and React hasn't yet flipped isGuest to false. handleLogout
    // sets app_logged_out BEFORE signOut, so the onAuthStateChange
    // (session=null) re-render can see it even before setIsGuest(false)
    // has been applied.
    try {
      if (localStorage.getItem('app_logged_out') === '1') return;
    } catch {}
    if (anonInFlight.current) return;
    anonInFlight.current = true;
    // Supabase returns errors as `res.error` rather than throwing — handle
    // both forms. We deliberately leave anonInFlight=true on failure so a
    // permanent config error (anonymous provider disabled) doesn't spin in
    // a retry loop on every dependency change; the app gracefully falls
    // back to the legacy 'guest' scope via the userScope derivation.
    supabase.auth.signInAnonymously()
      .then((res) => {
        if (res?.error) {
          console.warn('[anon] signInAnonymously rejected:', res.error.message);
        }
      })
      .catch((e) => {
        console.warn('[anon] signInAnonymously threw:', e?.message || e);
      });
  }, [authReady, session, isGuest]);

  // Close the 5-word forced-login gate as soon as we have a REAL (non-anon)
  // session AND the post-OAuth verification has finished. Skipping while
  // gateBindPending is still true is what keeps the modal in its
  // "verifying…" state during the brief window between session-arrival and
  // runSyncOrReject's rejection — without it the modal would flash closed
  // and then reopen in error state. gateModalError also blocks closure so
  // the rejection message stays put. Step 1 of the refactor: anonymous
  // sessions are guests, so they must NOT auto-close the gate.
  useEffect(() => {
    if (session && !session.user.is_anonymous && showLoginGate && !gateModalError && !gateBindPending) {
      setShowLoginGate(false);
    }
  }, [session, showLoginGate, gateModalError, gateBindPending]);

  // Auto-dismiss the bind-rejected toast after a few seconds.
  useEffect(() => {
    if (!bindToast) return;
    const id = setTimeout(() => setBindToast(null), 4200);
    return () => clearTimeout(id);
  }, [bindToast]);

  // Background push: while signed in (NON-anon), ship the local snapshot to
  // the cloud when the tab is hidden or closed, plus once a minute as a
  // heartbeat. syncOnLogin handles initial merge; this just keeps the cloud
  // copy fresh. Anon users stay local-only — no cloud row at all until they
  // bind into a real account.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    if (session.user.is_anonymous) return;
    const flush = () => { pushLocalToCloud(uid); };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    const id = setInterval(flush, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
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
    // Suppression during an in-flight OAuth bind round-trip still applies —
    // we don't want a brief picker flash on top of Settings while the bind
    // is verifying.
    if (bindOAuthPending || bindModalError) {
      setNeedsLangSetup(false);
      return;
    }
    const inBindFlow = (() => {
      try {
        return localStorage.getItem('bind_inline_active') === '1'
          || localStorage.getItem('bind_flow_active') === '1';
      } catch { return false; }
    })();
    if (inBindFlow) {
      setNeedsLangSetup(false);
      return;
    }
    setNeedsLangSetup(!localStorage.getItem('app_native'));
  }, [isLoggedIn, session, isGuest, bindOAuthPending, bindModalError]);

  // Daily check-in popup: show once per local-calendar day after the user is
  // past login + language setup. bumpLoginDay has already added today's date.
  // Also wait until pwaInstalled is known (not null) so the install hint
  // inside the popup paints with the correct state from the first frame.
  useEffect(() => {
    if (!isLoggedIn || needsLangSetup) return;
    if (pwaInstalled === null) return;
    // Skip the check-in while a guest→account bind is still resolving (just
    // returned from OAuth) or its rejection error is queued to surface in the
    // Settings modal. Without this guard the user gets a check-in popup on
    // the Learn page *before* we route them to Settings to see the error.
    if (bindOAuthPending) return;
    if (bindModalError) return;
    const uid = session?.user?.id;
    if (shouldShowCheckin(uid)) {
      setCheckinDay(getLoginDayCount(uid));
    }
  }, [isLoggedIn, needsLangSetup, session, pwaInstalled, bindModalError, bindOAuthPending]);

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
    // Tab click is a user gesture — prime audio so subsequent auto-speaks
    // play on iOS Safari (the global one-shot primer may have already run,
    // but the cost of calling it again is negligible and it's a no-op once
    // primed).
    primeAudio();
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
    // Called after the WelcomePage flow (guest-mode link) — drops the user
    // back into the app. Clears the `app_logged_out` marker so the device
    // resumes auto-promoting to guest on subsequent visits.
    try { localStorage.setItem('app_logged_in', 'true'); } catch {}
    try { localStorage.removeItem('app_logged_out'); } catch {}
    try { localStorage.setItem('app_last_active', String(Date.now())); } catch {}
    // Clear any leftover gate / oauth-pending state so re-entering guest
    // mode doesn't immediately pop the LoginPromptModal. `showLoginGate`
    // can survive across re-entry (no remount happens between sign-out and
    // re-entry — App stays mounted), and stale `*_oauth_pending` flags from
    // an interrupted earlier flow would make the gate's useState initializer
    // start true on the next reload.
    try { localStorage.removeItem('gate_oauth_pending'); } catch {}
    try { localStorage.removeItem('bind_oauth_pending'); } catch {}
    setShowLoginGate(false);
    setGateModalError('');
    setSettingsBindPending(false);
    setGateBindPending(false);
    // Unlock audio inside this user gesture — without it, the auto-speak on
    // the first word after login is silent on iOS Safari (the audio context
    // stays suspended until any subsequent user gesture).
    primeAudio();
    setIsGuest(true);
    setPage('learn');
    setReviewMode(false);
  };

  const handleLogout = async () => {
    // Explicit logout: clear both supabase session AND guest mode, then
    // route the user to WelcomePage as a real login screen (per requirement
    // "用户主动点击log out，应该回到 login界面"). Set `app_logged_out=1` so
    // the auto-promotion in the isGuest initializer doesn't flip the user
    // back into guest mode on reload. Their language pick and local
    // progress stay in place so a future sign-in or guest re-entry doesn't
    // re-prompt the language picker.
    //
    // Do NOT switch to the Learn tab here — that would briefly make
    // LearningPage visible while the signOut promise resolves and fire its
    // auto-speak effect. Tearing down to WelcomePage via !isLoggedIn covers
    // the visual transition. handleLogin restores page='learn' on re-entry.
    setReviewMode(false);
    // Order matters with anonymous sessions (Step 1 refactor):
    //   - Stash the anon scope BEFORE signOut so a future guest re-entry's
    //     fresh anon session can absorb the progress back (handleLogout was
    //     never expected to wipe local progress; the carry-over preserves
    //     that guarantee under the new per-anon-uid scoping).
    //   - Set `app_logged_out` BEFORE signOut so the anon-creation
    //     useEffect sees it on the session=null re-render that fires before
    //     setIsGuest(false) lands.
    //   - Set `isGuest=false` BEFORE awaiting signOut for the same reason.
    if (session?.user?.is_anonymous) {
      try { localStorage.setItem('app_anon_data_to_migrate', `u_${session.user.id}`); } catch {}
    }
    try { localStorage.removeItem('app_logged_in'); } catch {}
    try { localStorage.setItem('app_logged_out', '1'); } catch {}
    setIsGuest(false);
    if (session) await supabase.auth.signOut();
  };

  // Called by LearningPage every time it presents a new word. Pre-refactor
  // this bumped a per-day `gate_words_${date}` bucket; that turned out to be
  // the wrong semantics — users expect "5 free learned words" not "5 per
  // calendar day". The gate now derives its count from the per-uid progress
  // slot (the same data the word list reads), so there's nothing to record
  // here. Kept as a prop for LearningPage's API stability; intentional no-op.
  const handleWordViewed = () => {};

  // Called by LearningPage BEFORE it processes an answer click / skip /
  // Got-it tap. Returns false when the guest has reached the free quota —
  // gate modal pops, the answer is discarded. Returns true otherwise.
  // Wired so the user never sees their answer register + the next word
  // advance behind the gate. Count comes from `countLearnedWords(userScope)`
  // which reads the per-uid progress slot the user's word list already shows.
  const requestNextWord = () => {
    if (!authReady) return true;
    if ((session && !session.user.is_anonymous) || IS_WECHAT) return true;
    if (countLearnedWords(userScope) >= GATE_FREE_LIMIT) {
      setShowLoginGate(true);
      return false;
    }
    return true;
  };

  const handleGateDismiss = () => {
    // Just close the modal. The next requestNextWord / handleWordViewed
    // call past the daily limit will re-open it — there's no per-day
    // suppression anymore. Also clear any rejection error so a re-open
    // from a different attempt starts fresh.
    setShowLoginGate(false);
    setGateModalError('');
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
    // First-time visitors with no language picked land here as their initial
    // screen. Promote them to a guest session so they drop straight into the
    // learning UI on the next render (no Welcome page in between).
    if (!isGuest) {
      try { localStorage.setItem('app_logged_in', 'true'); } catch {}
      try { localStorage.removeItem('app_logged_out'); } catch {}
      try { localStorage.setItem('app_last_active', String(Date.now())); } catch {}
      setIsGuest(true);
    }
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
  // state, and review-word data don't bleed between accounts. Changes when
  // session arrives/clears, which triggers a re-read in the consuming pages.
  const userScope = session?.user?.id ? `u_${session.user.id}` : 'guest';

  // Show language setup for first-time visitors AND for logged-in accounts
  // that haven't picked a language yet. Brand-new visitors land here as
  // their entry screen; completing it promotes them to guest mode and they
  // drop straight into Learn (no Welcome page).
  if (needsLangSetup) {
    return (
      <div className="w-screen bg-white flex items-center justify-center font-cute overflow-hidden" style={{ height: vpH }}>
        <div className="w-[402px] h-[841px] overflow-hidden sm:rounded-[2rem] relative" style={{ maxHeight: vpH }}>
          <LanguageSetupPage onComplete={handleLangSetupComplete} />
        </div>
      </div>
    );
  }

  // After-logout login screen. Reached when the user explicitly signed out
  // (clearing both supabase session and `app_logged_in`). app_native is
  // still set, so the language picker doesn't re-fire. WelcomePage provides
  // the Google / Discord / Email / Guest-mode picker.
  if (!isLoggedIn) {
    return (
      <div className="w-screen bg-white flex items-center justify-center font-cute overflow-hidden" style={{ height: vpH }}>
        <div className="w-[402px] h-[841px] overflow-hidden sm:rounded-[2rem] relative" style={{ maxHeight: vpH }}>
          <WelcomePage onLogin={handleLogin} onTestMode={handleLogin} nativeLang={nativeLang} />
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
              userScope={userScope}
              selectedCategory={learningCategory}
              selectedLevel={learningLevel}
              onCategoryChange={handleCategoryChange}
              contentHFromParent={Math.max(0, vpH - (categoryModalOpen ? 0 : navH) - 2)}
              onLevelChange={handleLevelChange}
              isVisible={(page === 'learn' || reviewMode) && checkinDay == null && !showLoginGate}
              onCategoryModalChange={setCategoryModalOpen}
              onWordViewed={handleWordViewed}
              requestNextWord={requestNextWord}
            />
          </div>
          <div style={{ display: (page === 'wordlist' && !reviewMode) ? undefined : 'none', height: '100%' }}>
            <WordListPage
              onStartReview={handleStartReview}
              nativeLang={nativeLang}
              targetLang={targetLang}
              userScope={userScope}
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
              bindModalError={bindModalError}
              onBindModalErrorConsumed={() => setBindModalError('')}
              bindOAuthPending={settingsBindPending}
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

        {/* 5-word/day login gate — fires for guests outside WeChat who try
            to view their 6th distinct word in a calendar day. Dismissable
            via the X button so the user isn't trapped; dismissing sets a
            sessionStorage flag that suppresses the gate for the rest of
            this tab session. A page refresh re-engages the gate (the daily
            count lives in localStorage, which survives refresh).

            Gated on `page === 'learn'`: SettingsPage owns its own
            LoginPromptModal for the Settings Sign-up flow. Without this
            guard, a stale `gate_oauth_pending` flag could leave
            `showLoginGate=true` while the user is also using the Settings
            modal — both LoginPromptModals would render at once, producing
            stacked popups on Settings. */}
        {showLoginGate && (page === 'learn' || reviewMode) && (
          <LoginPromptModal
            nativeLang={nativeLang}
            initialEmailMode="signup"
            flowType="bind"
            oauthLandingPage="learn"
            // Show "checking your account…" while a gate-initiated OAuth
            // round-trip is still resolving. Flips off once App resolves
            // it as either success (modal closes via session-update effect)
            // or rejection (`gateModalError` is set and shown inline).
            pending={gateBindPending && !gateModalError}
            initialError={gateModalError}
            onClose={handleGateDismiss}
            onLoggedIn={() => { setShowLoginGate(false); setGateModalError(''); }}
          />
        )}

        {/* Bind-rejected toast (account already has cloud progress). Surfaces
            above every page so it's visible whether the user lands back on
            Settings, Welcome, or anywhere else after the soft signOut. */}
        {bindToast && (
          <div
            className="absolute left-1/2 -translate-x-1/2 z-[70] max-w-[340px] px-[18px] py-[12px] rounded-[14px] bg-black/85 text-white text-[13px] text-center leading-snug shadow-lg pointer-events-none"
            style={{ top: 80 }}
          >
            {bindToast}
          </div>
        )}
      </div>
      <Analytics />
    </div>
  );
}
