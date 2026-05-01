import { useState, useEffect } from 'react';
import EmailLoginPage from './EmailLoginPage';
import { supabase } from '../lib/supabase';

export default function WelcomePage({ onLogin, nativeLang = 'en' }) {
  const [showEmail, setShowEmail] = useState(false);
  const [oauthError, setOauthError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const err = params.get('error_description') || params.get('error') || hashParams.get('error_description') || hashParams.get('error');
    if (err) {
      setOauthError(decodeURIComponent(err.replace(/\+/g, ' ')));
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const signInWithProvider = async (provider) => {
    setOauthError('');
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) setOauthError(error.message);
  };

  if (showEmail) {
    return <EmailLoginPage onBack={() => setShowEmail(false)} onLogin={onLogin} nativeLang={nativeLang} />;
  }

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
          onClick={() => setShowEmail(true)}
          className="w-[48px] h-[48px] rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
        >
          <img src="/assets/figma/icon-email.png" alt="Email" className="w-full h-full object-cover" />
        </button>
      </div>

      {/* Guest Mode */}
      <div className="absolute left-0 right-0 top-[312px] flex justify-center">
        <button
          onClick={onLogin}
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
    </div>
  );
}
