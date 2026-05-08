import { useState, useEffect } from 'react';
import EmailLoginPage from './EmailLoginPage';
import { supabase } from '../lib/supabase';
import { UI_TEXT } from '../utils/langHelpers';

const TOS_URL = '/legal/PlushieWord_Terms_of_Service.html';
const PRIVACY_URL = '/legal/PlushieWord_Privacy_Policy.html';

export default function WelcomePage({ onLogin, onTestMode, nativeLang = 'en' }) {
  const t = UI_TEXT[nativeLang] || UI_TEXT.en;
  const [showEmail, setShowEmail] = useState(false);
  const [oauthError, setOauthError] = useState('');
  const [tosAccepted, setTosAccepted] = useState(true);
  const [privacyAccepted, setPrivacyAccepted] = useState(true);
  const [toast, setToast] = useState('');
  const [doc, setDoc] = useState(null); // { title, html } | null
  const [docLoading, setDocLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const err = params.get('error_description') || params.get('error') || hashParams.get('error_description') || hashParams.get('error');
    if (err) {
      setOauthError(decodeURIComponent(err.replace(/\+/g, ' ')));
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

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

  const signInWithProvider = async (provider) => {
    if (!guard()) return;
    setOauthError('');
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) setOauthError(error.message);
  };

  const handleEmailClick = () => {
    if (!guard()) return;
    setShowEmail(true);
  };

  const handleTestMode = () => {
    if (!guard()) return;
    (onTestMode || onLogin)();
  };

  const openDoc = async (title, url) => {
    setDoc({ title, html: '' });
    setDocLoading(true);
    try {
      const res = await fetch(url);
      const html = await res.text();
      setDoc({ title, html });
    } catch {
      setDoc({ title, html: '<p style="color:#b91c1c;">Failed to load.</p>' });
    } finally {
      setDocLoading(false);
    }
  };

  if (showEmail) {
    return <EmailLoginPage onBack={() => setShowEmail(false)} onLogin={onLogin} nativeLang={nativeLang} />;
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
        src="/assets/figma/login-bg.jpg"
        alt=""
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      />

      {/* Welcome multilingual text overlay */}
      <img
        src="/assets/figma/welcome-text.png"
        alt=""
        className="absolute left-[6px] top-[77px] w-[393px] h-[364px] object-cover opacity-50 pointer-events-none"
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
          className="w-[48px] h-[48px] rounded-full bg-white border-2 border-black shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform relative"
        >
          <img src="/assets/figma/icon-google-g.png" alt="Google" className="w-[30px] h-[30px]" />
        </button>

        {/* Discord */}
        <button
          onClick={() => signInWithProvider('discord')}
          className="w-[48px] h-[48px] rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
        >
          <img src="/assets/figma/icon-discord.png" alt="Discord" className="w-full h-full object-cover" />
        </button>

        {/* Email */}
        <button
          onClick={handleEmailClick}
          className="w-[48px] h-[48px] rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
        >
          <img src="/assets/figma/icon-email.png" alt="Email" className="w-full h-full object-cover" />
        </button>
      </div>

      {/* Guest Mode */}
      <div className="absolute left-0 right-0 top-[312px] flex justify-center">
        <button
          onClick={handleTestMode}
          className="text-[16px] text-black text-center underline whitespace-nowrap hover:opacity-70 active:opacity-50"
        >
          Test Mode
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
              <button
                type="button"
                onClick={() => setDoc(null)}
                className="absolute right-[8px] top-1/2 -translate-y-1/2 w-[28px] h-[28px] rounded-full flex items-center justify-center hover:bg-black/5 active:bg-black/10"
                aria-label={t.close}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2 2 L12 12 M12 2 L2 12" stroke="#333" strokeWidth="2" strokeLinecap="round" />
                </svg>
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
