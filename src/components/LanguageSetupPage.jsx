import { useState } from 'react';
import { getLangName } from '../utils/langHelpers';
import { usePostHog } from '@posthog/react';

const LANG_CODES = ['en', 'ja', 'zh'];

const LANG_ICONS = {
  en: '/assets/figma/setting-lang-en.png',
  ja: '/assets/figma/setting-lang-ja.png',
  zh: '/assets/figma/setting-lang-chinese.png',
};

// Multilingual prompts for step 1 — only the 3 languages we support.
const NATIVE_PROMPTS = [
  { code: 'en', text: 'Please select your native language' },
  { code: 'ja', text: '母語を選んでください' },
  { code: 'zh', text: '请选择你的母语' },
];

const TARGET_PROMPT = {
  en: 'Please select the language you want to learn',
  ja: '学習したい言語を選んでください',
  zh: '请选择你要学习的语言',
};

const NEXT_LABEL = { en: 'Next', ja: '次へ', zh: '下一步' };
const BACK_LABEL = { en: 'Back', ja: '戻る', zh: '上一步' };
const CONFIRM_LABEL = { en: 'Confirm', ja: '確認', zh: '确认' };

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
            backgroundColor: '#ffd016',
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

function YellowButton({ label, onClick, width = 130 }) {
  return (
    <button
      onClick={onClick}
      className="active:scale-95 transition-transform"
      style={{
        width, height: 39,
        backgroundColor: '#ffd016',
        border: '2px solid #000',
        borderRadius: 100,
        fontSize: 18, color: '#000',
      }}
    >
      {label}
    </button>
  );
}

export default function LanguageSetupPage({ onComplete }) {
  const posthog = usePostHog();
  const [step, setStep] = useState(1); // 1 = native, 2 = target
  const [native, setNative] = useState('zh');
  const [target, setTarget] = useState(null);

  const handleNext = () => {
    // Default target picks the first available non-native option
    const fallback = LANG_CODES.find(c => c !== native) || 'en';
    setTarget(t => (t && t !== native ? t : fallback));
    setStep(2);
  };

  const handleConfirm = () => {
    if (!target || target === native) return;
    posthog?.capture('language_setup_completed', { native_lang: native, target_lang: target });
    onComplete({ native, target });
  };

  const targetOptions = LANG_CODES.filter(c => c !== native);

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* Background — reuse login-bg */}
      <img
        src="/assets/figma/login-bg.jpg"
        alt=""
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      />

      {step === 1 ? (
        // ── STEP 1: Native language ──
        // Card sized & spaced to match SettingsPage picker (width 353, ICON_TOP after title, button bottom 34)
        <div
          className="absolute"
          style={{
            left: '50%', transform: 'translateX(-50%)',
            top: 200,
            width: 353, height: 350,
            backgroundColor: '#fff',
            border: '2px solid #000',
            borderRadius: 20,
          }}
        >
          {/* Multilingual prompts — tight line gap (8px), starts at top 30 like SettingsPage title (38) */}
          <div style={{ paddingTop: 30, paddingLeft: 16, paddingRight: 16, textAlign: 'center' }}>
            {NATIVE_PROMPTS.map((p, i) => (
              <p
                key={p.code}
                style={{
                  fontSize: 15,
                  color: '#000',
                  opacity: i === 0 ? 1 : 0.4,
                  marginTop: i === 0 ? 0 : 8,
                  whiteSpace: 'nowrap',
                  lineHeight: 1.2,
                }}
              >
                {p.text}
              </p>
            ))}
          </div>

          {/* Flag row — 30px gap below prompts, same as SettingsPage title→icons gap */}
          <div style={{
            position: 'absolute',
            top: 130,
            left: 0, right: 0,
            display: 'flex',
            justifyContent: 'space-evenly',
            alignItems: 'flex-start',
          }}>
            {LANG_CODES.map(code => (
              <FlagCircle
                key={code}
                code={code}
                label={getLangName(code, native)}
                selected={native === code}
                onClick={() => setNative(code)}
              />
            ))}
          </div>

          {/* Next button — same sizing as SettingsPage Confirm */}
          <button
            onClick={handleNext}
            className="absolute active:scale-95"
            style={{
              left: '50%', transform: 'translateX(-50%)',
              bottom: 34,
              width: 130, height: 39,
              backgroundColor: '#ffd016',
              border: '2px solid #000',
              borderRadius: 100,
              fontSize: 18, color: '#000',
            }}
          >
            {NEXT_LABEL[native] || NEXT_LABEL.en}
          </button>
        </div>
      ) : (
        // ── STEP 2: Target language ──
        // Same dimensions as SettingsPage picker (width 353, height 310)
        <div
          className="absolute"
          style={{
            left: '50%', transform: 'translateX(-50%)',
            top: 220,
            width: 353, height: 310,
            backgroundColor: '#fff',
            border: '2px solid #000',
            borderRadius: 20,
          }}
        >
          {/* Prompt — in chosen native language */}
          <p style={{
            position: 'absolute', top: 38, left: 16, right: 16,
            textAlign: 'center', fontSize: 15, color: '#000', opacity: 0.55,
            whiteSpace: 'nowrap',
          }}>
            {TARGET_PROMPT[native] || TARGET_PROMPT.en}
          </p>

          {/* Flag row — only non-native options, centered with tighter gap when only 2 options */}
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

          {/* Back + Confirm buttons — match SettingsPage button sizing, sit at bottom 34 */}
          <div style={{
            position: 'absolute',
            bottom: 34, left: 0, right: 0,
            display: 'flex',
            justifyContent: 'center',
            gap: 18,
          }}>
            <YellowButton
              label={BACK_LABEL[native] || BACK_LABEL.en}
              onClick={() => setStep(1)}
              width={110}
            />
            <YellowButton
              label={CONFIRM_LABEL[native] || CONFIRM_LABEL.en}
              onClick={handleConfirm}
              width={130}
            />
          </div>
        </div>
      )}
    </div>
  );
}
