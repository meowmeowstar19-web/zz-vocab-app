import { useState } from 'react';
import { supabase, intentionalSignOut } from '../lib/supabase';
import { UI_TEXT } from '../utils/langHelpers';
import { validateEmailShape } from '../utils/emailValidate';
import { usePostHog } from '@posthog/react';
import { syncOnLogin } from '../utils/progressSync';
import { primeAudio } from '../hooks/useAudio';
import { getFigmaAssetUrl } from '../utils/assetUrl';

// Email OTP login with two distinct paths, selected by `bindFlow`:
//
//  - LOGIN (bindFlow=false): a fresh sign-in / first-time signup. We sign out
//    any anon session and call signInWithOtp({ shouldCreateUser:true }), which
//    mints a brand-new user (new UID) and emails an OTP under the
//    "Confirm signup" template. Verified with type='email'.
//
//  - BIND (bindFlow=true): a guest is converting their anonymous account into
//    a real email-backed one. We call updateUser({ email }) on the LIVE anon
//    session, which PRESERVES the anon UID, then verify with
//    type='email_change'. Because the UID is unchanged, syncOnLogin's bind
//    branch merges progress in place (fromScope === toScope) — there is no
//    scope migration and no signout machinery to coordinate.
//
//    Dashboard prerequisite: updateUser({ email }) triggers Supabase's
//    "Change Email Address" template, NOT "Confirm signup". Copy the
//    Confirm-signup body into the Change-Email slot (keep {{ .Token }}) so the
//    OTP still arrives.
//
// After bind auth succeeds we run syncOnLogin *inline* — if the target account
// already has cloud progress, we sign out, keep the user on this form, and
// surface an in-form error so they can change the email and retry. Without
// this, App.jsx's global onAuthStateChange listener would catch the rejection
// after the modal has already closed.
export default function EmailLoginPage({ onBack, onLogin, nativeLang = 'en', bindFlow = false }) {
  const posthog = usePostHog();
  const t = UI_TEXT[nativeLang] || UI_TEXT.en;
  const [step, setStep] = useState('email'); // 'email' | 'verify'
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState(''); // 'bind_taken' | ''
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  const resetMessages = () => {
    setError(''); setErrorKind(''); setInfo('');
  };

  // Runs the progress merge after a successful auth. In bind mode, if the
  // target account already has cloud data, syncOnLogin returns rejected — we
  // sign out, reset to guest, show the inline error, and tell the caller NOT
  // to advance past the form.
  const finishAuth = async (uid) => {
    if (!bindFlow || !uid) return true;
    try {
      const result = await syncOnLogin(uid);
      if (result?.rejected) {
        await intentionalSignOut();
        setError(t.bindAccountTakenToast || 'This account is already in use. Please link a new one.');
        setErrorKind('bind_taken');
        setStep('email');
        setCode('');
        return false;
      }
      try { localStorage.setItem('lang_onboarded_' + uid, 'true'); } catch {}
      return true;
    } finally {
      try { localStorage.removeItem('bind_inline_active'); } catch {}
    }
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
      // BIND: convert the live anonymous session in place. updateUser({ email })
      // keeps the same UID, so no signout, no scope migration, no migration
      // flags. updateUser needs an active session (Rule A) — if somehow signed
      // out, mint a fresh anon first.
      if (bindFlow) {
        const { data: { session: cur } } = await supabase.auth.getSession();
        if (!cur) await supabase.auth.signInAnonymously();
        const { error } = await supabase.auth.updateUser({ email: emailVal });
        if (error) throw error;
        setStep('verify');
        setCode('');
        return;
      }

      // LOGIN: signInWithOtp uses the standard "Confirm signup" verification
      // code template (shouldCreateUser:true always mints a new email).
      //
      // BUT: signInWithOtp silently no-ops (returns success with no email
      // actually sent) when an authenticated session is already active. App.jsx
      // mints an anonymous session for every guest, so we hit that case on the
      // login entry point too. Sign out the anon session first, then call the
      // OTP API on a clean (unauthenticated) state.
      //
      // While signed out we set `app_logged_out=1` so App.jsx's anon-creation
      // useEffect doesn't immediately re-mint a new anon between signOut and
      // verifyOtp. We also stash the prior anon scope in
      // `app_anon_data_to_migrate` — if the user backs out without verifying,
      // the next anon session (created when we clear the flag) inherits the
      // local progress via migrateScopesToAnon.
      const { data: { session: cur } } = await supabase.auth.getSession();
      if (cur && cur.user.is_anonymous) {
        try { localStorage.setItem('app_anon_data_to_migrate', `u_${cur.user.id}`); } catch {}
        try { localStorage.setItem('app_logged_out', '1'); } catch {}
        // app_logged_out alone does NOT stop App's anon re-mint for returning
        // users: that guard also checks `app_had_account !== '1'`, which is
        // sticky-true once the device has ever held a real account. Without a
        // dedicated flag, App mints a fresh anon between this signOut and
        // verifyOtp — and that late anon sign-in can clobber the just-verified
        // email session (dropping the user into an empty guest scope) or
        // shuffle the guest-scope pointer so syncOnLogin reads the wrong slot.
        try { localStorage.setItem('app_email_auth_pending', '1'); } catch {}
        await intentionalSignOut();
      }
      const { error } = await supabase.auth.signInWithOtp({
        email: emailVal,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: window.location.origin,
        },
      });
      if (error) {
        // Restore guest-able state so back-button drops the user into anon
        // mode with their progress intact.
        try { localStorage.removeItem('app_logged_out'); } catch {}
        try { localStorage.removeItem('app_email_auth_pending'); } catch {}
        throw error;
      }
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
    if (bindFlow) {
      try { localStorage.setItem('bind_inline_active', '1'); } catch {}
    }
    try {
      // BIND went through updateUser({ email }), which is an email-change on the
      // anon session → type='email_change'. LOGIN went through signInWithOtp →
      // type='email'.
      const { data, error } = await supabase.auth.verifyOtp({
        email,
        token: trimmed,
        type: bindFlow ? 'email_change' : 'email',
      });
      if (error) {
        if (/expired|invalid|incorrect/i.test(error.message)) {
          setError(t.codeInvalid);
          return;
        }
        throw error;
      }
      posthog?.capture(bindFlow ? 'user_signed_up' : 'user_logged_in', { method: 'email', native_lang: nativeLang });
      posthog?.identify(data?.user?.id || data?.session?.user?.id || email, { email, native_lang: nativeLang });
      if (await finishAuth(data?.user?.id || data?.session?.user?.id)) onLogin();
    } catch (err) {
      setError(err.message || t.operationFailed);
    } finally {
      setLoading(false);
      if (bindFlow) {
        try { localStorage.removeItem('bind_inline_active'); } catch {}
      }
    }
  };

  const handleResendCode = async () => {
    resetMessages();
    setLoading(true);
    try {
      // Mirror the send path: bind re-issues the email-change OTP, login
      // re-issues the signup OTP.
      // Bind must NOT use auth.resend({type:'email_change'}): GoTrue's /resend
      // looks the user up by their CURRENT email, and the bind user is
      // anonymous (email empty; the address is only pending in new_email) — so
      // it never finds them and silently 200s WITHOUT sending
      // (anti-enumeration). Verified live on miracleZZ 2026-07-07:
      // email_change_sent_at untouched after resend. Re-calling
      // updateUser({email}) on the live anon session regenerates the code and
      // actually resends.
      const { error } = bindFlow
        ? await supabase.auth.updateUser({ email })
        : await supabase.auth.signInWithOtp({
            email,
            options: { shouldCreateUser: true },
          });
      if (error) throw error;
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

  // Back button: clear the `app_logged_out` flag we may have set in
  // handleSendCode so App.jsx's useEffect re-mints an anonymous session
  // (with `app_anon_data_to_migrate` carrying the prior anon's progress
  // into the new scope). Without this, the user would land back in
  // settings with a stale "logged out" flag suppressing guest mode.
  //
  // Also re-mint the anon session inline. App.jsx's anon-creation effect
  // is gated on [authReady, session, isGuest, needsLangSetup] — none of
  // which change when we clear app_logged_out, so the effect never re-runs.
  // Without this explicit call, closing the modal after backing out of a
  // sent-OTP flow leaves the app stuck on the scope-finalization placeholder
  // (white background + tiny phone shell — looks like a white screen).
  const handleBack = () => {
    try { localStorage.removeItem('app_logged_out'); } catch {}
    try { localStorage.removeItem('app_email_auth_pending'); } catch {}
    (async () => {
      try {
        const { data: { session: cur } } = await supabase.auth.getSession();
        if (!cur) await supabase.auth.signInAnonymously();
      } catch {}
    })();
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
