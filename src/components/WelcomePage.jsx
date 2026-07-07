import { useState, useEffect } from 'react';
import EmailLoginPage from './EmailLoginPage';
import { useAuth, STATUS } from '../auth/useAuth.js';
import { UI_TEXT } from '../utils/langHelpers';
import { usePostHog } from '@posthog/react';
import { getFigmaAssetUrl } from '../utils/assetUrl';

const TOS_URL = '/legal/PlushieWord_Terms_of_Service.html';
const PRIVACY_URL = '/legal/PlushieWord_Privacy_Policy.html';

export default function WelcomePage({ onLogin, onTestMode, nativeLang = 'en' }) {
  const posthog = usePostHog();
  const auth = useAuth();
  const t = UI_TEXT[nativeLang] || UI_TEXT.en;
  // A login-OTP flow that survived a reload (OTP_PENDING whose exit falls
  // back to LOGGED_OUT) reopens straight on the verify pane.
  const resumedEmail = auth.status === STATUS.OTP_PENDING ? auth.otp?.email : null;
  const [showEmail, setShowEmail] = useState(() => !!resumedEmail);
  const [tosAccepted, setTosAccepted] = useState(true);
  const [privacyAccepted, setPrivacyAccepted] = useState(true);
  const [toast, setToast] = useState('');
  const [doc, setDoc] = useState(null); // { title, html } | null
  const [docLoading, setDocLoading] = useState(false);

  // OAuth failures: the machine parses ?error_description off the boot URL
  // (urlAuthError) and concludes round-trip rejections into bindError.
  const oauthError = auth.bindError || auth.urlAuthError || '';

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  const guard = () => {
    if (!tosAccepted || !privacyAccepted) {
      setToast(t.agreementsRequired);
      return false;
    }
    return true;
  };

  const signInWithProvider = (provider) => {
    if (!guard()) return;
    posthog?.capture('login_oauth_initiated', { provider, native_lang: nativeLang });
    // Post-logout login: the machine's welcome-surface flow never merges a
    // previous account's scope into the new session (explicitLogout rule).
    auth.signInOAuth(provider, 'welcome');
  };

  const handleEmailClick = () => {
    if (!guard()) return;
    posthog?.capture('login_email_clicked', { native_lang: nativeLang });
    setShowEmail(true);
  };

  const handleTestMode = () => {
    if (!guard()) return;
    posthog?.capture('guest_mode_started', { native_lang: nativeLang });
    (onTestMode || onLogin)();
  };

  const openDoc = async (title, url) => {
    setDoc({ title, html: '' });
    setDocLoading(true);
    try {
      const res = await fetch(url);
      const html = await res.text();
      // If the user closed the popup mid-fetch, don't reopen it.
      setDoc((prev) => (prev && prev.title === title ? { title, html } : prev));
    } catch {
      setDoc((prev) => (prev && prev.title === title
        ? { title, html: '<p style="color:#b91c1c;">Failed to load.</p>' }
        : prev));
    } finally {
      setDocLoading(false);
    }
  };

  if (showEmail) {
    return (
      <EmailLoginPage
        onBack={() => setShowEmail(false)}
        onLogin={onLogin}
        nativeLang={nativeLang}
        surface="welcome"
        initialEmail={resumedEmail || ''}
        initialStep={resumedEmail ? 'verify' : 'email'}
      />
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

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* Background */}
      <img
        src={getFigmaAssetUrl('login-bg.jpg')}
        alt=""
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      />

      {/* Welcome multilingual text overlay */}
      <img
        src={getFigmaAssetUrl('welcome-text.png')}
        alt=""
        className="absolute left-[6px] top-[77px] w-[393px] h-[364px] object-cover opacity-70 pointer-events-none"
      />

      {/* Welcome :D */}
      <p className="absolute left-1/2 -translate-x-1/2 top-[182px] text-[24px] text-black text-center whitespace-nowrap font-bold">
        Welcome :D
      </p>

      {/* Social login buttons */}
      <div className="absolute left-1/2 -translate-x-1/2 top-[236px] flex gap-[26px]">
        {/* Google */}
        <button
          onClick={() => signInWithProvider('google')}
          className="w-[48px] h-[48px] rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
        >
          <img src={getFigmaAssetUrl('icon-google.png')} alt="Google" className="w-full h-full object-cover" />
        </button>

        {/* Discord */}
        <button
          onClick={() => signInWithProvider('discord')}
          className="w-[48px] h-[48px] rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
        >
          <img src={getFigmaAssetUrl('icon-discord.png')} alt="Discord" className="w-full h-full object-cover" />
        </button>

        {/* Email */}
        <button
          onClick={handleEmailClick}
          className="w-[48px] h-[48px] rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
        >
          <img src={getFigmaAssetUrl('icon-email.png')} alt="Email" className="w-full h-full object-cover" />
        </button>
      </div>

      {/* Guest Mode */}
      <div className="absolute left-0 right-0 top-[312px] flex justify-center">
        <button
          onClick={handleTestMode}
          className="text-[16px] text-black text-center underline whitespace-nowrap hover:opacity-70 active:opacity-50"
        >
          {t.guestModeLink || 'Guest Mode'}
        </button>
      </div>

      {oauthError && (
        <p className="absolute left-0 right-0 top-[345px] text-center text-red-500 text-[12px] px-4">
          {oauthError}
        </p>
      )}

      {/* Legal agreements — bottom of login page, centered */}
      <div className="absolute left-0 right-0 bottom-[24px] flex flex-col items-center gap-[8px]">
        {renderAcknowledge(tosAccepted, setTosAccepted, t.tosName, TOS_URL)}
        {renderAcknowledge(privacyAccepted, setPrivacyAccepted, t.privacyName, PRIVACY_URL)}
      </div>

      {/* Toast */}
      {toast && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-[110px] z-20 max-w-[340px] px-[16px] py-[10px] rounded-[14px] bg-black/80 text-white text-[13px] text-center leading-snug shadow-lg">
          {toast}
        </div>
      )}

      {/* Document popup */}
      {doc && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/40"
          onClick={() => setDoc(null)}
        >
          <div
            className="relative w-[340px] bg-white rounded-[16px] shadow-2xl flex flex-col overflow-hidden"
            style={{ maxHeight: 'calc(100% - 40px)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative flex items-center justify-center px-[44px] py-[10px] border-b border-black/10">
              <span className="text-[14px] font-semibold text-black text-center">{doc.title}</span>
              {/* Big invisible hit-area button — wraps the X icon. The visible
                  glyph is just a child; the whole 44x44 target closes the
                  popup on the first pointer-down so stray finger movement
                  on mobile doesn't cancel the click. */}
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
            <div className="flex-1 overflow-y-auto px-[16px] py-[14px] legal-doc text-[13px] text-black leading-relaxed">
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
  );
}
