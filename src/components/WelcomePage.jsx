import { useState } from 'react';
import EmailLoginPage from './EmailLoginPage';

export default function WelcomePage({ onLogin }) {
  const [showEmail, setShowEmail] = useState(false);

  if (showEmail) {
    return <EmailLoginPage onBack={() => setShowEmail(false)} onLogin={onLogin} />;
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
      <p className="absolute left-1/2 -translate-x-1/2 top-[197px] text-[24px] text-black text-center whitespace-nowrap font-bold">
        Welcome :D
      </p>

      {/* Social login buttons */}
      <div className="absolute left-1/2 -translate-x-1/2 top-[251px] flex gap-[26px]">
        {/* Google */}
        <button
          onClick={() => {/* TODO: Supabase Google OAuth */}}
          className="w-[48px] h-[48px] rounded-full bg-white border border-black shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform relative"
        >
          <img src="/assets/figma/icon-google-g.png" alt="Google" className="w-[30px] h-[30px]" />
        </button>

        {/* WeChat */}
        <button
          onClick={() => {/* TODO: WeChat OAuth */}}
          className="w-[48px] h-[48px] rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
        >
          <img src="/assets/figma/icon-wechat.png" alt="WeChat" className="w-full h-full object-cover" />
        </button>

        {/* Email */}
        <button
          onClick={() => setShowEmail(true)}
          className="w-[48px] h-[48px] rounded-full shadow-md flex items-center justify-center hover:scale-105 active:scale-95 transition-transform overflow-hidden"
        >
          <img src="/assets/figma/icon-email.png" alt="Email" className="w-full h-full object-cover" />
        </button>
      </div>
    </div>
  );
}
