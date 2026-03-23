import { useState } from 'react';
import { getLangName, UI_TEXT } from '../utils/langHelpers';
import { clearAllProgress } from '../utils/storage';

const LANG_CODES = ['en', 'ja', 'zh'];

const LANG_ICONS = {
  en: '/assets/figma/setting-lang-en.png',
  ja: '/assets/figma/setting-lang-ja.png',
  zh: '/assets/figma/setting-lang-zh.png',
};

const ROW_PREFIX = {
  zh: { native: '母语', target: '学习语言' },
  en: { native: 'Native', target: 'Learning' },
  ja: { native: '母語', target: '学習言語' },
};

const PICKER_TITLES = {
  zh: { native: '请选择你的母语', target: '请选择学习语言' },
  en: { native: 'Choose your native language', target: 'Choose language to learn' },
  ja: { native: '母語を選んでください', target: '学習言語を選んでください' },
};

function ChevronDown() {
  return (
    <svg width="18" height="12" viewBox="0 0 18 12" fill="none">
      <path d="M1.5 1.5L9 9.5L16.5 1.5" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function SettingsPage({ nativeLang, targetLang, onLanguageChange }) {
  const [pickerType, setPickerType] = useState(null); // 'native' | 'target' | null
  const [pendingCode, setPendingCode] = useState(null);
  const t = UI_TEXT[nativeLang] || UI_TEXT.zh;
  const prefix = ROW_PREFIX[nativeLang] || ROW_PREFIX.zh;
  const pickerTitles = PICKER_TITLES[nativeLang] || PICKER_TITLES.zh;

  const openPicker = (type) => {
    setPendingCode(type === 'native' ? nativeLang : targetLang);
    setPickerType(type);
  };

  const closePicker = () => {
    setPickerType(null);
    setPendingCode(null);
  };

  const handleConfirm = () => {
    if (pickerType && pendingCode) {
      if (pickerType === 'native') {
        if (pendingCode !== nativeLang) {
          if (pendingCode === targetLang) {
            onLanguageChange({ native: pendingCode, target: nativeLang });
          } else {
            onLanguageChange({ native: pendingCode });
          }
        }
      } else {
        if (pendingCode !== targetLang) {
          if (pendingCode === nativeLang) {
            onLanguageChange({ native: targetLang, target: pendingCode });
          } else {
            onLanguageChange({ target: pendingCode });
          }
        }
      }
    }
    closePicker();
  };

  // Icon positions relative to the modal card (card left=20 on screen)
  // From Figma: en at screen-left=44 → card-rel=24, ja=146, zh=268
  const ICON_LEFT = { en: 24, ja: 146, zh: 268 };
  const ICON_TOP = 90;   // 252 - 162 (card top)
  const LABEL_MT = 12;   // gap between circle bottom and label (97px from container - 85px icon = 12px)

  return (
    <div className="relative h-full overflow-hidden">
      {/* Background */}
      <img
        src="/assets/figma/setting-background.jpg"
        alt=""
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
        style={{ zIndex: 0 }}
      />

      {/* Main content */}
      <div className="relative z-10 h-full">

        {/* Profile section (decorative) */}
        <div style={{ position: 'absolute', left: 26, top: 58, display: 'flex', alignItems: 'center', gap: 11 }}>
          <img
            src="/assets/figma/setting-profile.png"
            alt=""
            style={{ width: 63, height: 63 }}
          />
          <div>
            <p style={{ fontSize: 24, color: '#000', lineHeight: 1.2 }}>Larissa</p>
            <p style={{ fontSize: 16, color: '#000', lineHeight: 1.2 }}>{(t.loginDays || '累计登录 {n}天').replace('{n}', 99)}</p>
          </div>
        </div>

        {/* Cat decoration (above native row) */}
        <img
          src="/assets/figma/setting-cat.png"
          alt=""
          className="absolute pointer-events-none select-none"
          style={{ left: 319, top: 119, width: 55, height: 65 }}
        />

        {/* Native language pill */}
        <button
          onClick={() => openPicker('native')}
          className="absolute flex items-center active:scale-[0.98]"
          style={{
            left: 20, top: 162,
            width: 353, height: 50,
            backgroundColor: '#fff',
            border: '2px solid #000',
            borderRadius: 100,
          }}
        >
          <span style={{ marginLeft: 19, fontSize: 18, color: '#000' }}>
            {prefix.native}：{getLangName(nativeLang, nativeLang)}
          </span>
          <span style={{ marginLeft: 'auto', marginRight: 15 }}>
            <ChevronDown />
          </span>
        </button>

        {/* Frog decoration (above target row) */}
        <img
          src="/assets/figma/setting-frog.png"
          alt=""
          className="absolute pointer-events-none select-none"
          style={{ left: 37, top: 240, width: 47, height: 37 }}
        />

        {/* Target language pill */}
        <button
          onClick={() => openPicker('target')}
          className="absolute flex items-center active:scale-[0.98]"
          style={{
            left: 20, top: 265,
            width: 353, height: 50,
            backgroundColor: '#fff',
            border: '2px solid #000',
            borderRadius: 100,
          }}
        >
          <span style={{ marginLeft: 19, fontSize: 18, color: '#000' }}>
            {prefix.target}：{getLangName(targetLang, nativeLang)}
          </span>
          <span style={{ marginLeft: 'auto', marginRight: 15 }}>
            <ChevronDown />
          </span>
        </button>

        {/* Dev mode: clear all progress */}
        <button
          onClick={() => {
            if (window.confirm(t.devModeConfirm || '确定要清除所有学习记录吗？')) {
              clearAllProgress();
              window.location.reload();
            }
          }}
          className="absolute active:opacity-60"
          style={{ bottom: 12, left: 0, right: 0, textAlign: 'center' }}
        >
          <span style={{ fontSize: 13, color: '#3F3E3E' }}>{t.devMode || '开发者模式：清除学习记录'}</span>
        </button>

      </div>

      {/* Language picker modal */}
      {pickerType && (
        <div
          className="absolute inset-0 z-50"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={closePicker}
        >
          {/* Card — centered, width 353 = same as pills (left:20, right:20) */}
          <div
            className="absolute"
            style={{
              left: 20, top: 162,
              width: 353, height: 310,
              backgroundColor: '#fff',
              border: '2px solid #000',
              borderRadius: 20,
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Title */}
            <p style={{
              position: 'absolute', top: 38, left: 16, right: 16,
              textAlign: 'center', fontSize: 18, color: '#000',
            }}>
              {pickerType === 'native' ? pickerTitles.native : pickerTitles.target}
            </p>

            {/* Language icons — flex row, evenly spaced */}
            <div style={{
              position: 'absolute',
              top: ICON_TOP,
              left: 0, right: 0,
              display: 'flex',
              justifyContent: 'space-evenly',
              alignItems: 'flex-start',
            }}>
              {LANG_CODES.map(code => {
                const isSelected = pendingCode === code;
                return (
                  <div
                    key={code}
                    onClick={() => setPendingCode(code)}
                    style={{
                      width: 85,
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                    }}
                  >
                    {/* Circle with check badge */}
                    <div style={{ position: 'relative', width: 85, height: 85 }}>
                      <div style={{
                        width: 85, height: 85,
                        borderRadius: '50%',
                        overflow: 'hidden',
                      }}>
                        <img
                          src={LANG_ICONS[code]}
                          alt={getLangName(code, nativeLang)}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      </div>
                      {/* Check badge in top-right */}
                      {isSelected && (
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
                      marginTop: LABEL_MT,
                      fontSize: 18, color: '#000', textAlign: 'center',
                      whiteSpace: 'nowrap',
                    }}>
                      {getLangName(code, nativeLang)}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* Confirm button — centered */}
            <button
              onClick={handleConfirm}
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
              {t.ok}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
