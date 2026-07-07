import { useState } from 'react';
import { useAuth } from '../auth/useAuth.js';
import { UI_TEXT } from '../utils/langHelpers';
import { validateEmailShape } from '../utils/emailValidate';
import { usePostHog } from '@posthog/react';
import { primeAudio } from '../hooks/useAudio';
import { getFigmaAssetUrl } from '../utils/assetUrl';

// Email OTP form. UI ONLY since the state-machine migration — the two paths
// live in the machine, selected by `bindFlow`:
//
//  - LOGIN (bindFlow=false): auth.requestOtp → signInWithOtp
//    ({ shouldCreateUser:true }), verified with type='email'. The guest's
//    anon session stays LIVE through the whole flow (current SDKs' /otp
//    ignores the stored session — the old signOut dance orphaned wardrobes);
//    on verify the machine merges the guest scope into the account.
//
//  - BIND (bindFlow=true): auth.bindEmail → updateUser({ email }) on the
//    live anon session, PRESERVING the uid; verified with
//    type='email_change'. Zero migration by construction.
//
//    Dashboard prerequisite: updateUser({ email }) triggers Supabase's
//    "Change Email Address" template, NOT "Confirm signup". Copy the
//    Confirm-signup body into the Change-Email slot (keep {{ .Token }}).
//
// `initialEmail` / `initialStep` let a machine-restored flow (page killed
// mid-OTP; BOOT revives OTP_PENDING/BINDING from the snapshot) mount
// straight on the verify pane with the address prefilled.
export default function EmailLoginPage({
  onBack, onLogin, nativeLang = 'en', bindFlow = false,
  surface = 'settings', initialEmail = '', initialStep = 'email',
}) {
  const posthog = usePostHog();
  const auth = useAuth();
  const t = UI_TEXT[nativeLang] || UI_TEXT.en;
  const [step, setStep] = useState(initialStep); // 'email' | 'verify'
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  const resetMessages = () => {
    setError(''); setInfo('');
  };

  const handleSendCode = async () => {
    resetMessages();
    const emailVal = email.trim();
    const check = validateEmailShape(emailVal, t);
    if (!check.ok) {
      setError(check.msg);
      return;
    }
    setLoading(true);
    try {
      if (bindFlow) await auth.bindEmail(emailVal, surface);
      else await auth.requestOtp(emailVal);
      setStep('verify');
      setCode('');
    } catch (err) {
      setError(err.message || t.sendCodeFailed || t.operationFailed);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async () => {
    resetMessages();
    const trimmed = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(trimmed)) {
      setError(t.codeIncomplete);
      return;
    }
    setLoading(true);
    try {
      if (bindFlow) await auth.verifyBind(email, trimmed);
      else await auth.verifyOtp(email, trimmed);
      posthog?.capture(bindFlow ? 'user_signed_up' : 'user_logged_in', { method: 'email', native_lang: nativeLang });
      posthog?.identify(email, { email, native_lang: nativeLang });
      onLogin();
    } catch (err) {
      if (/expired|invalid|incorrect/i.test(err?.message || '')) {
        setError(t.codeInvalid);
      } else {
        setError(err.message || t.operationFailed);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResendCode = async () => {
    resetMessages();
    setLoading(true);
    try {
      // Bind resend re-calls updateUser({email}) — GoTrue's /resend can't
      // find an anonymous user by its (empty) current email and silently
      // no-ops. The machine also restarts its local TTL to match the fresh
      // server code. See auth/useAuth.js resendOtp for the full story.
      await auth.resendOtp(email, bindFlow);
      setInfo(t.codeResent);
    } catch (err) {
      setError(err.message || t.operationFailed);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    // Form submit is a user gesture — prime audio so the first word's
    // auto-speak plays on iOS Safari after the user drops into Learn.
    primeAudio();
    if (step === 'verify') return handleVerifyCode();
    return handleSendCode();
  };

  // Back button: tell the machine the pending flow is over (OTP_EXIT — a
  // no-op when nothing was sent yet). It clears the persisted marker and
  // re-verifies/restores the guest session as needed.
  const handleBack = () => {
    auth.exitOtp();
    onBack();
  };

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* Background */}
      <img
        src={getFigmaAssetUrl('login-bg.jpg')}
        alt=""
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      />

      {/* Back button */}
      <button
        onClick={handleBack}
        className="absolute top-[40px] left-[20px] z-10 w-[36px] h-[36px] rounded-full bg-white/70 flex items-center justify-center active:scale-95 transition-transform"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>

      {/* Form */}
      <form onSubmit={handleSubmit} className="absolute left-0 right-0 top-[111px] px-[29px]">
        {step === 'verify' ? (
          <>
            <p className="text-[20px] text-black font-medium mb-2">{t.verifyCodeTitle}</p>
            <p className="text-[14px] text-black/70 mb-2 leading-snug">
              {(t.verifyCodeSubtitle || '').replace('{email}', email)}
            </p>
            <p className="text-[12px] text-black/50 mb-5 leading-snug">
              {t.verifyCodeHint}
            </p>
            <label className="block text-[16px] text-black mb-1">{t.verifyCodeLabel}</label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="w-[329px] h-[50px] rounded-[25px] border-2 border-black bg-white px-5 text-[22px] tracking-[0.3em] text-center outline-none focus:border-[#FFDF4E] transition-colors"
              placeholder={t.verifyCodePlaceholder}
              autoFocus
            />
          </>
        ) : (
          <>
            <label className="block text-[16px] text-black mb-1">{t.emailLabel}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-[329px] h-[50px] rounded-[25px] border-2 border-black bg-white px-5 text-[15px] outline-none focus:border-[#FFDF4E] transition-colors"
              placeholder={t.emailPlaceholder}
              autoFocus
            />
            <p className="text-[12px] text-black/55 mt-2 leading-snug">
              {t.emailOtpHint || ''}
            </p>
          </>
        )}

        {error && (
          <p className="text-red-500 text-[13px] mt-3 text-center leading-tight whitespace-pre-line">{error}</p>
        )}
        {info && (
          <p className="text-green-700 text-[13px] mt-3 text-center">{info}</p>
        )}

        {/* Submit button */}
        <div className="flex justify-center mt-[30px]">
          <button
            type="submit"
            disabled={loading}
            className="w-[148px] h-[48px] rounded-[100px] bg-[#FFDF4E] border-2 border-black text-[18px] text-black font-normal active:scale-95 transition-transform disabled:opacity-50"
          >
            {loading ? '...' : (step === 'verify' ? t.verifyBtn : (t.sendCodeBtn || 'Send code'))}
          </button>
        </div>

        {/* Bottom actions */}
        {step === 'verify' && (
          <div className="text-center mt-[20px] text-[14px] text-black/60 space-y-2">
            <p>
              <button type="button" onClick={handleResendCode} disabled={loading} className="text-black underline disabled:opacity-50">
                {t.resendCode}
              </button>
            </p>
            <p>
              <button type="button" onClick={() => { setStep('email'); setCode(''); resetMessages(); }} className="text-black underline">
                {t.changeEmail}
              </button>
            </p>
          </div>
        )}
      </form>
    </div>
  );
}
