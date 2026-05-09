import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { UI_TEXT } from '../utils/langHelpers';
import { usePostHog } from '@posthog/react';

export default function EmailLoginPage({ onBack, onLogin, nativeLang = 'en' }) {
  const posthog = usePostHog();
  const t = UI_TEXT[nativeLang] || UI_TEXT.en;
  const [mode, setMode] = useState('login'); // 'login' | 'signup' | 'verify'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState(''); // 'not_registered' | 'wrong_password' | 'oauth_only' | 'auth_or_oauth' | 'unconfirmed' | 'email_taken' | ''
  const [oauthProvider, setOauthProvider] = useState(''); // 'google' | 'discord' | ''
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  const resetMessages = () => {
    setError(''); setErrorKind(''); setOauthProvider(''); setInfo('');
  };

  // Calls the check-email-status Edge Function to refine the generic
  // "Invalid login credentials" error into a precise one. Falls back to the
  // generic message if the function isn't deployed or fails.
  const refineLoginError = async (emailVal) => {
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('check-email-status', {
        body: { email: emailVal },
      });
      if (fnErr || !data || !data.status) return false;
      if (data.status === 'not_registered') {
        setMode('signup');
        setInfo(t.switchedToSignup);
        setConfirmPassword('');
        return true;
      }
      if (data.status === 'oauth_only') {
        const provider = data.provider || 'google';
        const label = provider === 'google' ? 'Google' : provider === 'discord' ? 'Discord' : provider;
        setError((t.emailOauthOnly || '').replaceAll('{provider}', label));
        setOauthProvider(provider);
        setErrorKind('oauth_only');
        return true;
      }
      if (data.status === 'has_password') {
        setError(t.wrongPassword);
        setErrorKind('wrong_password');
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const handleOAuth = async (provider) => {
    resetMessages();
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) setError(error.message);
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
      const { error } = await supabase.auth.verifyOtp({
        email,
        token: trimmed,
        type: 'email',
      });
      if (error) {
        if (/expired|invalid|incorrect/i.test(error.message)) {
          setError(t.codeInvalid);
          return;
        }
        throw error;
      }
      posthog?.capture('user_signed_up', { method: 'email', native_lang: nativeLang });
      posthog?.identify(email, { email, native_lang: nativeLang });
      onLogin();
    } catch (err) {
      setError(err.message || t.operationFailed);
    } finally {
      setLoading(false);
    }
  };

  const handleResendCode = async () => {
    resetMessages();
    setLoading(true);
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email });
      if (error) throw error;
      setInfo(t.codeResent);
    } catch (err) {
      setError(err.message || t.operationFailed);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (mode === 'verify') {
      return handleVerifyCode();
    }

    resetMessages();

    if (!email || !password) {
      setError(t.fillEmailAndPassword);
      return;
    }

    if (mode === 'signup' && password !== confirmPassword) {
      setError(t.passwordMismatch);
      return;
    }

    setLoading(true);
    try {
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        // Supabase returns a user with empty identities[] when the email
        // is already registered (silent dedup to prevent account enumeration).
        if (data.user && data.user.identities && data.user.identities.length === 0) {
          setError(t.emailAlreadyTaken);
          setErrorKind('email_taken');
          setMode('login');
          return;
        }
        if (data.session) {
          posthog?.capture('user_signed_up', { method: 'email', native_lang: nativeLang });
          posthog?.identify(data.session.user.id, { email, native_lang: nativeLang });
          onLogin();
        } else {
          setMode('verify');
          setCode('');
        }
      } else {
        const { data: loginData, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          if (/invalid login credentials/i.test(error.message)) {
            const refined = await refineLoginError(email);
            if (!refined) {
              setError(t.authOrOauthError);
              setErrorKind('auth_or_oauth');
            }
            return;
          }
          if (/email not confirmed/i.test(error.message)) {
            setMode('verify');
            setCode('');
            return;
          }
          throw error;
        }
        posthog?.capture('user_logged_in', { method: 'email', native_lang: nativeLang });
        if (loginData?.user) {
          posthog?.identify(loginData.user.id, { email, native_lang: nativeLang });
        }
        onLogin();
      }
    } catch (err) {
      setError(err.message || t.operationFailed);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* Background */}
      <img
        src="/assets/figma/login-bg.jpg"
        alt=""
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      />

      {/* Back button */}
      <button
        onClick={onBack}
        className="absolute top-[40px] left-[20px] z-10 w-[36px] h-[36px] rounded-full bg-white/70 flex items-center justify-center active:scale-95 transition-transform"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>

      {/* Form */}
      <form onSubmit={handleSubmit} className="absolute left-0 right-0 top-[111px] px-[29px]">
        {mode === 'verify' ? (
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
              className="w-[329px] h-[50px] rounded-[25px] border-2 border-black bg-white px-5 text-[22px] tracking-[0.3em] text-center outline-none focus:border-[#ffd016] transition-colors"
              placeholder={t.verifyCodePlaceholder}
              autoFocus
            />
          </>
        ) : (
          <>
            {/* Email */}
            <label className="block text-[16px] text-black mb-1">{t.emailLabel}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-[329px] h-[50px] rounded-[25px] border-2 border-black bg-white px-5 text-[15px] outline-none focus:border-[#ffd016] transition-colors"
              placeholder={t.emailPlaceholder}
            />

            {/* Password */}
            <label className="block text-[16px] text-black mb-1 mt-[20px]">{t.loginPasswordLabel}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-[329px] h-[50px] rounded-[25px] border-2 border-black bg-white px-5 text-[15px] outline-none focus:border-[#ffd016] transition-colors"
              placeholder={t.passwordDots}
            />

            {/* Confirm Password (signup only) */}
            {mode === 'signup' && (
              <>
                <label className="block text-[16px] text-black mb-1 mt-[20px]">{t.confirmPasswordSignupLabel}</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-[329px] h-[50px] rounded-[25px] border-2 border-black bg-white px-5 text-[15px] outline-none focus:border-[#ffd016] transition-colors"
                  placeholder={t.passwordDots}
                />
              </>
            )}
          </>
        )}

        {/* Error message */}
        {error && (
          <p className="text-red-500 text-[13px] mt-3 text-center leading-tight">{error}</p>
        )}
        {info && (
          <p className="text-green-700 text-[13px] mt-3 text-center">{info}</p>
        )}

        {/* OAuth icon CTAs — show only when error suggests OAuth is the right path.
            For "not_registered", we rely on the existing "还没有账号？注册" toggle below. */}
        {(() => {
          if (mode === 'verify') return null;
          const showAllOAuth = errorKind === 'auth_or_oauth' || errorKind === 'email_taken';
          const showOnlyOneOAuth = errorKind === 'oauth_only';
          if (!showAllOAuth && !showOnlyOneOAuth) return null;

          const GoogleIcon = (
            <button
              key="g"
              type="button"
              onClick={() => handleOAuth('google')}
              className="w-[48px] h-[48px] rounded-full bg-white border border-black shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform"
            >
              <img src="/assets/figma/icon-google-g.png" alt="Google" className="w-[30px] h-[30px]" />
            </button>
          );
          const DiscordIcon = (
            <button
              key="d"
              type="button"
              onClick={() => handleOAuth('discord')}
              className="w-[48px] h-[48px] rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
            >
              <img src="/assets/figma/icon-discord.png" alt="Discord" className="w-full h-full object-cover" />
            </button>
          );

          return (
            <div className="mt-3 flex justify-center gap-[26px]">
              {showOnlyOneOAuth
                ? (oauthProvider === 'discord' ? DiscordIcon : GoogleIcon)
                : (<>{GoogleIcon}{DiscordIcon}</>)}
            </div>
          );
        })()}

        {/* Submit button */}
        <div className="flex justify-center mt-[30px]">
          <button
            type="submit"
            disabled={loading}
            className="w-[128px] h-[48px] rounded-[100px] bg-[#ffd016] border-2 border-black text-[20px] text-black font-normal active:scale-95 transition-transform disabled:opacity-50"
          >
            {loading ? '...' : (mode === 'verify' ? t.verifyBtn : mode === 'signup' ? t.signupBtn : t.loginBtn)}
          </button>
        </div>

        {/* Bottom toggle / actions */}
        {mode === 'verify' ? (
          <div className="text-center mt-[20px] text-[14px] text-black/60 space-y-2">
            <p>
              <button type="button" onClick={handleResendCode} disabled={loading} className="text-black underline disabled:opacity-50">
                {t.resendCode}
              </button>
            </p>
            <p>
              <button type="button" onClick={() => { setMode('signup'); setCode(''); resetMessages(); }} className="text-black underline">
                {t.changeEmail}
              </button>
            </p>
          </div>
        ) : (
          <p className="text-center mt-[20px] text-[14px] text-black/60">
            {mode === 'login' ? (
              <>{t.noAccountYet}<button type="button" onClick={() => { setMode('signup'); setError(''); }} className="text-black underline">{t.signupBtn}</button></>
            ) : (
              <>{t.hasAccountAlready}<button type="button" onClick={() => { setMode('login'); setError(''); }} className="text-black underline">{t.loginBtn}</button></>
            )}
          </p>
        )}
      </form>
    </div>
  );
}
