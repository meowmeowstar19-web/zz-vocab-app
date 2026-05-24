import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { UI_TEXT } from '../utils/langHelpers';
import { usePostHog } from '@posthog/react';
import EmailLoginPage from './EmailLoginPage';

const TOS_URL = '/legal/PlushieWord_Terms_of_Service.html';
const PRIVACY_URL = '/legal/PlushieWord_Privacy_Policy.html';

// Login prompt surfaced from Settings when the user is in guest mode.
// Same auth choices as WelcomePage, minus the Test Mode entry and the
// language-detection background — user already has their UI set up.
//
// `initialError`: optional error message to display in place of the normal
// auth picker. Used when returning from an OAuth bind that was rejected
// because the target account already has cloud progress — instead of dumping
// the user on the Learn page with a toast, App.jsx routes them back to
// Settings and reopens this modal in its error state. A "确认" button below
// the message swaps back to the normal link-account view.
// `flowType` controls whether a successful auth should bind onto the current
// guest (and merge their local progress) or just sign in normally. "bind" is
// the original Sign up path — it sets `bind_flow_active` so syncOnLogin will
// reject the merge if the target account already has cloud progress. "login"
// is a plain sign-in (welcome-page semantics): no bind markers, no inline
// rejection, and guest local data is discarded by the cloud snapshot.
export default function LoginPromptModal({
  nativeLang = 'en',
  onClose,
  onLoggedIn,
  initialError = '',
  initialEmailMode = 'login',
  flowType = 'bind',
  // forced=true is used by the 5-word/day gate: the user must sign in before
  // they can keep learning. Hides the close button and ignores backdrop clicks.
  forced = false,
  // Where to land after a full-page OAuth round-trip. Default 'settings' keeps
  // the existing Settings-initiated bind behavior. Pass 'learn' for the gate
  // modal so the user comes back to the learning page they were on.
  oauthLandingPage = 'settings',
  // When true, render a "checking your account…" placeholder instead of the
  // auth picker. Used immediately after an OAuth round-trip while syncOnLogin
  // is still running — without this, the user sees nothing for ~1s and then
  // a rejection popup appears out of nowhere. Backdrop click is also ignored
  // in this state so the user can't dismiss mid-check.
  pending = false,
}) {
  const posthog = usePostHog();
  const t = UI_TEXT[nativeLang] || UI_TEXT.en;
  const [showEmail, setShowEmail] = useState(false);
  const [tosAccepted, setTosAccepted] = useState(true);
  const [privacyAccepted, setPrivacyAccepted] = useState(true);
  const [oauthError, setOauthError] = useState('');
  const [toast, setToast] = useState('');
  const [doc, setDoc] = useState(null); // { title, html } | null
  const [docLoading, setDocLoading] = useState(false);
  // Local error state seeded from the parent's `initialError`. When the prop
  // changes (e.g. a pending OAuth roundtrip resolves into a rejection), the
  // useEffect below pushes the new value into state. The 确认 button can
  // clear bindError locally without parental coordination — the modal swaps
  // back to the auth picker until a new error arrives.
  const [bindError, setBindError] = useState(initialError || '');
  useEffect(() => {
    setBindError(initialError || '');
  }, [initialError]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(id);
  }, [toast]);

  const guard = () => {
    if (!tosAccepted || !privacyAccepted) {
      setToast(t.agreementsRequired);
      return false;
    }
    return true;
  };

  // Mark the next successful login as a "bind from guest" attempt. Read by
  // progressSync.syncOnLogin to reject binding onto an account that already
  // has cloud progress (prevents the new guest data from overwriting it).
  const markBindFlow = () => {
    try { localStorage.setItem('bind_flow_active', '1'); } catch {}
  };

  // OAuth bounces through the provider and reloads the app, so we need a
  // separate flag that survives the round-trip to know which page to land on
  // after we come back. `bind_oauth_pending` lands on Settings (the original
  // bind flow). `gate_oauth_pending` lands on Learn (the 5-word gate path,
  // because the user was studying when the gate fired).
  //
  // Always clear the opposite flag first. Otherwise a stale flag from an
  // earlier flow (e.g. a cancelled gate OAuth that didn't finish cleaning
  // up) can co-exist with the new flag, and `runSyncOrReject` ends up
  // routing the rejection into the WRONG modal AND the right modal opens
  // too — two stacked popups on one rejection.
  const markOAuthPending = () => {
    try {
      if (oauthLandingPage === 'learn') {
        localStorage.removeItem('bind_oauth_pending');
        localStorage.setItem('gate_oauth_pending', '1');
      } else {
        localStorage.removeItem('gate_oauth_pending');
        localStorage.setItem('bind_oauth_pending', '1');
      }
    } catch {}
  };

  const signInWithProvider = async (provider) => {
    if (!guard()) return;
    setOauthError('');
    posthog?.capture('login_oauth_initiated', {
      provider, native_lang: nativeLang, source: 'settings_save_progress', flow: flowType,
    });
    // Only the bind flow needs the OAuth-pending + bind-flow markers; a plain
    // login flow should fall through to the welcome-page auth semantics.
    if (flowType === 'bind') {
      markBindFlow();
      markOAuthPending();
      // Remember which sub-flow (Sign up vs Log in) opened the modal so that
      // after the OAuth round-trip — which fully reloads the app and remounts
      // SettingsPage with default state — we can restore the same title on
      // the rejection popup. Without this, a rejected Sign up bind comes back
      // labelled "Sign in" because that's the SettingsPage default.
      try { localStorage.setItem('bind_oauth_email_mode', initialEmailMode || 'login'); } catch {}
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      if (flowType === 'bind') {
        try {
          localStorage.removeItem('bind_flow_active');
          localStorage.removeItem('bind_oauth_pending');
          localStorage.removeItem('gate_oauth_pending');
          localStorage.removeItem('bind_oauth_email_mode');
        } catch {}
      }
      setOauthError(error.message);
    }
  };

  const handleEmailClick = () => {
    if (!guard()) return;
    posthog?.capture('login_email_clicked', {
      native_lang: nativeLang, source: 'settings_save_progress', flow: flowType,
    });
    if (flowType === 'bind') markBindFlow();
    setShowEmail(true);
  };

  const handleEmailLogin = () => {
    // Email signup/login succeeded. Let the parent close + run sync.
    onLoggedIn?.();
  };

  const openDoc = async (title, url) => {
    setDoc({ title, html: '' });
    setDocLoading(true);
    try {
      const res = await fetch(url);
      const html = await res.text();
      setDoc((prev) => (prev && prev.title === title ? { title, html } : prev));
    } catch {
      setDoc((prev) => (prev && prev.title === title
        ? { title, html: '<p style="color:#b91c1c;">Failed to load.</p>' }
        : prev));
    } finally {
      setDocLoading(false);
    }
  };

  // If the user opens the email flow, swap the whole overlay for the email page.
  // It owns its own back button (calls onBack to return to the picker).
  //
  // `bindFlow` tells EmailLoginPage that any successful auth here is a guest
  // → account bind attempt, so it should run syncOnLogin inline and surface
  // a rejection as an in-form error (instead of letting App.jsx's global
  // listener handle it as a top-of-screen toast after the modal has closed).
  if (showEmail) {
    return (
      <div className="absolute inset-0 z-50" style={{ backgroundColor: '#fff' }}>
        <EmailLoginPage
          onBack={() => setShowEmail(false)}
          onLogin={handleEmailLogin}
          nativeLang={nativeLang}
          bindFlow={flowType === 'bind'}
          initialMode={initialEmailMode}
        />
      </div>
    );
  }

  const renderAcknowledge = (checked, setChecked, name, url) => {
    const fmt = t.acknowledgeFmt || 'I have read and agree to the {name}';
    const [before, after] = fmt.split('{name}');
    return (
      <div className="flex items-center text-[11.5px] text-black leading-tight whitespace-nowrap">
        <button
          type="button"
          onClick={() => setChecked(!checked)}
          aria-checked={checked}
          role="checkbox"
          className="w-[16px] h-[16px] rounded-full flex items-center justify-center shrink-0 mr-[8px] transition-colors"
          style={{
            backgroundColor: checked ? '#22c55e' : '#d1d5db',
            border: checked ? '1.5px solid #15803d' : '1.5px solid #9ca3af',
          }}
        >
          {checked && (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <polyline points="2.5,6.5 5,9 9.5,3.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        <span>
          {before}
          <button
            type="button"
            onClick={() => openDoc(name, url)}
            className="underline text-black bg-transparent p-0 m-0 border-0 cursor-pointer font-inherit text-inherit"
          >
            {name}
          </button>
          {after}
        </span>
      </div>
    );
  };

  // Both X-button and backdrop-click close paths should release the bind-flow
  // flags. Without this, a guest who started a bind, hit the "account in use"
  // error, then closed the modal would have a stale `bind_flow_active`
  // sitting in localStorage — and the next time they signed in anywhere
  // (e.g. exit guest mode → sign in from Welcome), syncOnLogin would
  // mistakenly reject that legitimate login.
  const handleClose = () => {
    // The forced gate modal is non-dismissable — the user has to sign in.
    // The pending state is also non-dismissable so the user can't bail out
    // mid-verification (the rejection result would then have nowhere to go).
    if (forced || pending) return;
    try {
      localStorage.removeItem('bind_flow_active');
      localStorage.removeItem('bind_oauth_pending');
      localStorage.removeItem('gate_oauth_pending');
      localStorage.removeItem('bind_oauth_email_mode');
    } catch {}
    onClose?.();
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      onClick={handleClose}
    >
      <div
        className="relative"
        style={{
          // Popups in this app should be at least square — width 353,
          // minHeight 353 (height ≥ width). Doc viewer gets the extra room
          // when reading TOS / Privacy.
          width: 353,
          minHeight: 353,
          backgroundColor: '#fff',
          border: '2px solid #000',
          borderRadius: 20,
          padding: '34px 24px 28px',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button (top-right) — omitted while the modal is forced or
            still verifying the OAuth round-trip. */}
        {!forced && !pending && (
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close"
          className="absolute right-[6px] top-[6px] w-[36px] h-[36px] flex items-center justify-center active:scale-95"
          style={{ background: 'transparent', border: 0, cursor: 'pointer' }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2 2 L12 12 M12 2 L2 12" stroke="#333" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        )}

        {/* Title — reflects which entry point opened the modal: "Sign up" for
            the signup flow, "Sign in" for the login flow. Falls back to the
            old "Link Account" string only if initialEmailMode is unset. */}
        <p style={{
          fontSize: 18, color: '#000', textAlign: 'center',
          fontWeight: 600, margin: 0,
        }}>
          {initialEmailMode === 'signup'
            ? (t.signupTitle || t.signupBtn || 'Sign up')
            : initialEmailMode === 'login'
              ? (t.loginTitle || t.loginBtn || 'Sign in')
              : t.saveProgressTitle}
        </p>

        {/* Subtitle — always visible. Pending and error states keep this
            line so the popup's identity (title + subtitle) doesn't flicker
            as the modal transitions between states. */}
        <p style={{
          fontSize: 13, color: '#000', textAlign: 'center',
          marginTop: 8, lineHeight: 1.4, opacity: 0.7,
        }}>
          {t.saveProgressSubtitle}
        </p>

        {pending ? (
          <>
            {/* "Checking your account…" placeholder shown immediately on
                OAuth return so the rejection (if any) never feels delayed. */}
            <div style={{ flex: 1, minHeight: 24 }} />
            <div
              style={{
                width: 32, height: 32,
                border: '3px solid rgba(0,0,0,0.15)',
                borderTopColor: '#000',
                borderRadius: '50%',
                animation: 'spin 0.9s linear infinite',
              }}
            />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <p style={{
              fontSize: 13, color: '#000', textAlign: 'center',
              marginTop: 14, opacity: 0.7,
            }}>
              {t.bindVerifying || t.translating || '…'}
            </p>
            <div style={{ flex: 1, minHeight: 24 }} />
          </>
        ) : bindError ? (
          <>
            {/* Error view — shown after OAuth bind was rejected because the
                target account already has cloud progress. Replaces the auth
                picker; "确认" swaps back to the normal view. */}
            <div style={{ flex: 1, minHeight: 24 }} />
            <p style={{
              fontSize: 15, color: '#000', textAlign: 'center',
              lineHeight: 1.6,
              whiteSpace: 'pre-line',
              padding: '0 4px',
              margin: 0,
            }}>
              {bindError}
            </p>
            <div style={{ flex: 1, minHeight: 24 }} />
            <button
              onClick={() => setBindError('')}
              className="active:scale-95"
              style={{
                width: 130, height: 39,
                backgroundColor: '#FFDF4E',
                border: '2px solid #000',
                borderRadius: 100,
                fontSize: 18, color: '#000',
              }}
            >
              {t.ok || '确认'}
            </button>
          </>
        ) : (
          <>
            {/* Top spacer — pairs with the spacer below the social row so the
                3 login buttons sit at the vertical middle of the popup. */}
            <div style={{ flex: 1, minHeight: 20 }} />

            {/* Social login row */}
            <div className="flex" style={{ gap: 26 }}>
              <button
                onClick={() => signInWithProvider('google')}
                className="rounded-full bg-white border-2 border-black shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform"
                style={{ width: 48, height: 48 }}
                aria-label="Google"
              >
                <img src="/assets/figma/icon-google-g.png" alt="Google" style={{ width: 30, height: 30 }} />
              </button>
              <button
                onClick={() => signInWithProvider('discord')}
                className="rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
                style={{ width: 48, height: 48 }}
                aria-label="Discord"
              >
                <img src="/assets/figma/icon-discord.png" alt="Discord" className="w-full h-full object-cover" />
              </button>
              <button
                onClick={handleEmailClick}
                className="rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
                style={{ width: 48, height: 48 }}
                aria-label="Email"
              >
                <img src="/assets/figma/icon-email.png" alt="Email" className="w-full h-full object-cover" />
              </button>
            </div>

            {oauthError && (
              <p className="text-red-500 text-[12px] text-center px-2" style={{ marginTop: 12 }}>
                {oauthError}
              </p>
            )}

            {/* Bottom spacer — symmetric with the top spacer above the social
                row. Together they vertically center the login buttons. */}
            <div style={{ flex: 1, minHeight: 20 }} />

            {/* Legal agreements */}
            <div className="flex flex-col items-center" style={{ gap: 8 }}>
              {renderAcknowledge(tosAccepted, setTosAccepted, t.tosName, TOS_URL)}
              {renderAcknowledge(privacyAccepted, setPrivacyAccepted, t.privacyName, PRIVACY_URL)}
            </div>
          </>
        )}

        {/* Toast (inside the modal so it sits above all content) */}
        {toast && (
          <div
            className="absolute left-1/2 -translate-x-1/2 z-[60] max-w-[320px] px-[16px] py-[10px] rounded-[14px] bg-black/80 text-white text-[12px] text-center leading-snug shadow-lg pointer-events-none"
            style={{ bottom: 12 }}
          >
            {toast}
          </div>
        )}

        {/* Document popup */}
        {doc && (
          <div
            className="absolute inset-0 z-[70] flex items-center justify-center"
            style={{ backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 20 }}
            onClick={() => setDoc(null)}
          >
            <div
              className="relative w-[300px] bg-white rounded-[16px] shadow-2xl flex flex-col overflow-hidden"
              style={{ maxHeight: 'calc(100% - 24px)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="relative flex items-center justify-center px-[44px] py-[10px] border-b border-black/10">
                <span className="text-[14px] font-semibold text-black text-center">{doc.title}</span>
                <button
                  type="button"
                  onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); setDoc(null); }}
                  onClick={(e) => { e.stopPropagation(); setDoc(null); }}
                  className="absolute right-0 top-0 bottom-0 w-[44px] flex items-center justify-center active:bg-black/10"
                  aria-label={t.close || 'Close'}
                  style={{ touchAction: 'manipulation' }}
                >
                  <span className="w-[28px] h-[28px] rounded-full flex items-center justify-center pointer-events-none">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M2 2 L12 12 M12 2 L2 12" stroke="#333" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </span>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-[14px] py-[12px] legal-doc text-[12.5px] text-black leading-relaxed">
                {docLoading && !doc.html ? (
                  <p className="text-black/50">…</p>
                ) : (
                  <div dangerouslySetInnerHTML={{ __html: doc.html }} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
