import { useEffect, useState } from 'react';
import { useAuth, STATUS } from '../auth/useAuth.js';
import { UI_TEXT } from '../utils/langHelpers';
import { usePostHog } from '@posthog/react';
import EmailLoginPage from './EmailLoginPage';
import { getFigmaAssetUrl } from '../utils/assetUrl';

const TOS_URL = '/legal/PlushieWord_Terms_of_Service.html';
const PRIVACY_URL = '/legal/PlushieWord_Privacy_Policy.html';

// Login prompt surfaced from Settings when the user is in guest mode.
// Same auth choices as WelcomePage, minus the Test Mode entry and the
// language-detection background — user already has their UI set up.
//
// UI ONLY since the state-machine migration: every supabase call and
// localStorage flag that used to live here moved into the machine. The modal
// reads pending / error / round-trip state straight from useAuth():
//   pending pane  ← status BINDING with an OAuth provider (redirect out, or
//                   the round-trip coming home at boot)
//   error pane    ← auth.bindError (identity_already_exists, provider errors,
//                   round-trip timeout); 确认 clears it via clearBindError()
// `flowType` picks bind (keep uid via linkIdentity/updateUser) vs login
// (switch account; the machine folds the guest's local data into the account
// scope). The in-modal Sign up ↔ Log in toggle remaps it via emailMode.
export default function LoginPromptModal({
  nativeLang = 'en',
  onClose,
  onLoggedIn,
  initialEmailMode = 'login',
  flowType = 'bind',
  // forced=true hides the close button and ignores backdrop clicks.
  forced = false,
  // Which UI launched this modal: 'gate' (5-word gate on Learn) or 'settings'
  // (Sign up / Log in from the Settings page). Persisted inside the machine's
  // bind marker so an OAuth round-trip reopens on the same surface.
  surface = 'settings',
}) {
  const posthog = usePostHog();
  const auth = useAuth();
  const t = UI_TEXT[nativeLang] || UI_TEXT.en;
  // Sticky "this device has previously held a real account" bit from the
  // auth snapshot — drives the welcome-back subtitle under the title.
  const hadAccount = auth.hadAccount;
  // OAuth round-trip resolving (redirect out or coming home): spinner pane.
  const pending = auth.status === STATUS.BINDING
    && auth.bind?.provider !== 'email'
    && !auth.bindError;
  const bindError = auth.bindError || '';
  // A machine-restored email flow (page killed mid-OTP / mid-bind-verify)
  // reopens straight on the verify pane with the email prefilled.
  const resumedEmail = auth.status === STATUS.OTP_PENDING
    ? auth.otp?.email
    : (auth.status === STATUS.BINDING && auth.bind?.provider === 'email' ? auth.bind?.email : null);
  const [showEmail, setShowEmail] = useState(() => !!resumedEmail);
  // Local copy of the mode so the in-modal toggle ("Already have an account? /
  // Don't have an account?") can flip between signup and login without
  // closing this popup and opening a second one on top.
  const [emailMode, setEmailMode] = useState(initialEmailMode);
  useEffect(() => { setEmailMode(initialEmailMode); }, [initialEmailMode]);
  const [tosAccepted, setTosAccepted] = useState(true);
  const [privacyAccepted, setPrivacyAccepted] = useState(true);
  const [toast, setToast] = useState('');
  const [doc, setDoc] = useState(null); // { title, html } | null
  const [docLoading, setDocLoading] = useState(false);

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

  // Derive the effective flow from the user's CURRENT intent (emailMode),
  // not from the flowType prop set when the modal opened. The in-modal
  // Sign up ↔ Log in toggle changes emailMode but cannot reach back up to
  // change the parent's flowType — mapping by emailMode makes the toggle
  // actually mean what it says.
  const effectiveFlow = emailMode === 'signup' ? 'bind' : 'login';

  const signInWithProvider = (provider) => {
    if (!guard()) return;
    posthog?.capture('login_oauth_initiated', {
      provider, native_lang: nativeLang, source: 'settings_save_progress', flow: effectiveFlow,
    });
    // Bind keeps the anon uid (linkIdentity — the server atomically rejects
    // if the identity is already attached to another user); login switches
    // accounts. The machine persists the round-trip marker, mints a safety-
    // net anon session for the bind path if needed, and surfaces every
    // failure (sync errors, URL errors, timeouts) via auth.bindError.
    if (effectiveFlow === 'bind') auth.bindOAuth(provider, surface);
    else auth.signInOAuth(provider, surface);
  };

  const handleEmailClick = () => {
    if (!guard()) return;
    posthog?.capture('login_email_clicked', {
      native_lang: nativeLang, source: 'settings_save_progress', flow: effectiveFlow,
    });
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

  // If the user opens the email flow, swap the whole overlay for the email
  // page. It owns its own back button (calls onBack to return to the picker).
  // A machine-restored flow (resumedEmail) mounts straight on the verify
  // pane with the address prefilled.
  if (showEmail) {
    return (
      <div className="absolute inset-0 z-50" style={{ backgroundColor: '#fff' }}>
        <EmailLoginPage
          onBack={() => setShowEmail(false)}
          onLogin={handleEmailLogin}
          nativeLang={nativeLang}
          bindFlow={resumedEmail ? auth.status === STATUS.BINDING : effectiveFlow === 'bind'}
          surface={surface}
          initialEmail={resumedEmail || ''}
          initialStep={resumedEmail ? 'verify' : 'email'}
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

  // Both X-button and backdrop-click funnel here. If an email flow is still
  // pending in the machine (OTP sent, verify pane abandoned via X instead of
  // the in-form back button), exit it — the machine clears the marker and
  // restores/verifies the guest session (铁律5's single exit).
  const handleClose = () => {
    // The forced gate modal is non-dismissable — the user has to sign in.
    // The OAuth pending pane is also non-dismissable so the user can't bail
    // out mid-verification (the conclusion would have nowhere to go).
    if (forced || pending) return;
    if (auth.status === STATUS.OTP_PENDING
        || (auth.status === STATUS.BINDING && auth.bind?.provider === 'email')) {
      auth.exitOtp();
    }
    onClose?.();
  };

  return (
    <div
      data-testid={surface === 'gate' ? 'login-gate-modal' : 'login-prompt-modal'}
      className="absolute inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      onClick={handleClose}
    >
      <div
        className="relative"
        style={{
          // Popups in this app should be at least square — width 353,
          // minHeight 353 (height ≥ width). Doc viewer gets the extra room
          // when reading TOS / Privacy. Width clamps to the viewport on
          // narrow phones so the card never touches the screen edges.
          width: 'min(353px, calc(100vw - 24px))',
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

        {/* Title — reflects which entry point opened the modal: "Sign up for
            a new account" for the signup flow, "Sign in to your existing
            account" for the login flow. Falls back to the old "Link Account"
            string only if emailMode is unset. The in-modal toggle below the
            social buttons can flip this between signup and login without
            closing/reopening the popup. */}
        <p style={{
          fontSize: 18, color: '#000', textAlign: 'center',
          fontWeight: 600, margin: 0,
        }}>
          {emailMode === 'signup'
            ? (t.signupTitle || t.signupBtn || 'Sign up')
            : emailMode === 'login'
              ? (t.loginTitle || t.loginBtn || 'Sign in')
              : t.saveProgressTitle}
        </p>

        {/* Welcome-back subtitle. Rendered only when (a) the device has
            previously held a real (non-anon) session AND (b) the user is
            currently in "Sign in" mode. Toggling the in-modal "Don't have
            an account? / Sign up" link flips emailMode → subtitle hides on
            its own. Hidden during the pending spinner and the bind-error
            view since both replace the auth picker below. */}
        {!pending && !bindError && emailMode === 'login' && hadAccount && t.loginWelcomeBackSubtitle && (
          <p style={{
            fontSize: 13, color: '#000', textAlign: 'center',
            opacity: 0.75, margin: '8px 0 0', lineHeight: 1.4,
            padding: '0 8px',
          }}>
            {t.loginWelcomeBackSubtitle}
          </p>
        )}

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
              onClick={() => auth.clearBindError()}
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
                className="rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
                style={{ width: 48, height: 48 }}
                aria-label="Google"
              >
                <img src={getFigmaAssetUrl('icon-google.png')} alt="Google" className="w-full h-full object-cover" />
              </button>
              <button
                onClick={() => signInWithProvider('discord')}
                className="rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
                style={{ width: 48, height: 48 }}
                aria-label="Discord"
              >
                <img src={getFigmaAssetUrl('icon-discord.png')} alt="Discord" className="w-full h-full object-cover" />
              </button>
              <button
                onClick={handleEmailClick}
                className="rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
                style={{ width: 48, height: 48 }}
                aria-label="Email"
              >
                <img src={getFigmaAssetUrl('icon-email.png')} alt="Email" className="w-full h-full object-cover" />
              </button>
            </div>

            {/* In-modal mode toggle — swaps the modal between signup and
                login by changing the title and the mode the email button
                hands off to EmailLoginPage. No stacked popups. */}
            <p
              className="text-center"
              style={{ marginTop: 16, fontSize: 13, color: '#000', lineHeight: 1.4 }}
            >
              {emailMode === 'signup'
                ? (t.hasAccountAlready || 'Already have an account? ')
                : (t.noAccountYet || "Don't have an account? ")}
              <button
                type="button"
                onClick={() => setEmailMode(emailMode === 'signup' ? 'login' : 'signup')}
                className="underline active:opacity-70"
                style={{
                  background: 'transparent', border: 0, padding: 0, margin: 0,
                  color: '#000', fontSize: 13, cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {emailMode === 'signup'
                  ? (t.loginBtn || 'Log in')
                  : (t.signupBtn || 'Sign up')}
              </button>
            </p>

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
