import { useState } from 'react';
import { getLangName } from '../utils/langHelpers';
import { usePostHog } from '@posthog/react';

const LANG_CODES = ['en', 'ja', 'zh'];

const LANG_ICONS = {
  en: '/assets/figma/setting-lang-en.png',
  ja: '/assets/figma/setting-lang-ja.png',
  zh: '/assets/figma/setting-lang-chinese.png',
};

// Prompt + confirm label rendered in the detected native language. Native
// selection itself is skipped (we trust navigator.language); user can change
// native later in Settings.
const TARGET_PROMPT = {
  en: 'Please select the language you want to learn',
  ja: '学習したい言語を選んでください',
  zh: '请选择你要学习的语言',
};

const CONFIRM_LABEL = { en: 'Confirm', ja: '確認', zh: '确认' };

const WELCOME_TITLE = {
  en: 'Welcome to PlushieWord :D',
  ja: 'PlushieWord へようこそ :D',
  zh: '欢迎来到 PlushieWord :D',
};

function FlagCircle({ code, label, selected, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        width: 85,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      <div style={{ position: 'relative', width: 85, height: 85 }}>
        <div style={{ width: 85, height: 85, borderRadius: '50%', overflow: 'hidden' }}>
          <img
            src={LANG_ICONS[code]}
            alt={label}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </div>
        {selected && (
          <div style={{
            position: 'absolute',
            top: -2, right: -2,
            width: 22, height: 22,
            borderRadius: '50%',
            backgroundColor: '#FFDF4E',
            border: '2px solid #000',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <svg width="11" height="8" viewBox="0 0 11 8" fill="none">
              <polyline points="1.5 4 4 6.5 9.5 1.5" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}
      </div>
      <p style={{
        marginTop: 12,
        fontSize: 18, color: '#000', textAlign: 'center',
        whiteSpace: 'nowrap',
      }}>
        {label}
      </p>
    </div>
  );
}

// Native lang is auto-detected by App from navigator.language and passed in.
// The page only collects the target language now — the "Welcome :D" header
// matches WelcomePage and the Figma node 575:301.
export default function LanguageSetupPage({ onComplete, nativeLang = 'en' }) {
  const posthog = usePostHog();
  const native = LANG_CODES.includes(nativeLang) ? nativeLang : 'en';
  const targetOptions = LANG_CODES.filter(c => c !== native);
  const [target, setTarget] = useState(targetOptions[0] || 'en');

  const handleConfirm = () => {
    if (!target || target === native) return;
    posthog?.capture('language_setup_completed', { native_lang: native, target_lang: target });
    onComplete({ native, target });
  };

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* Background — reuse login-bg */}
      <img
        src="/assets/figma/login-bg.jpg"
        alt=""
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      />

      {/* App icon + welcome heading + picker card, vertically centered as a group. */}
      <div className="relative z-10 w-full h-full flex flex-col items-center justify-start gap-4 px-4 pt-[22%]">
        {/* App icon */}
        <img
          src="/assets/figma/app-icon.png"
          alt="PlushieWord"
          style={{ width: 100, height: 100 }}
        />

        {/* Welcome to PlushieWord :D — localized to detected native lang. */}
        <p className="text-[22px] text-black text-center whitespace-nowrap">
          {WELCOME_TITLE[native] || WELCOME_TITLE.en}
        </p>

        {/* Target language picker card */}
        <div
        style={{
          position: 'relative',
          width: 353, height: 310,
          backgroundColor: '#fff',
          border: '2px solid #000',
          borderRadius: 20,
        }}
      >
        {/* Prompt — in detected native language */}
        <p style={{
          position: 'absolute', top: 38, left: 16, right: 16,
          textAlign: 'center', fontSize: 15, color: '#000', opacity: 0.55,
          whiteSpace: 'nowrap',
        }}>
          {TARGET_PROMPT[native] || TARGET_PROMPT.en}
        </p>

        {/* Flag row — only non-native options. */}
        <div style={{
          position: 'absolute',
          top: 90,
          left: 0, right: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          gap: 45,
        }}>
          {targetOptions.map(code => (
            <FlagCircle
              key={code}
              code={code}
              label={getLangName(code, native)}
              selected={target === code}
              onClick={() => setTarget(code)}
            />
          ))}
        </div>

        {/* Confirm button — bottom, matching SettingsPage sizing. */}
        <button
          onClick={handleConfirm}
          className="absolute active:scale-95"
          style={{
            left: '50%', transform: 'translateX(-50%)',
            bottom: 34,
            width: 130, height: 39,
            backgroundColor: '#FFDF4E',
            border: '2px solid #000',
            borderRadius: 100,
            fontSize: 18, color: '#000',
          }}
        >
          {CONFIRM_LABEL[native] || CONFIRM_LABEL.en}
        </button>
        </div>
      </div>
    </div>
  );
}
