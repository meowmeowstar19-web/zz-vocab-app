import { useState, useEffect, useRef } from 'react';
import { getLangName, UI_TEXT } from '../utils/langHelpers';
import { supabase } from '../lib/supabase';
import { getLoginDayCount, bumpLoginDay } from '../utils/storage';

// icon-192.png is the trimmed watermelon on a transparent canvas, so a white
// container backdrop shows through naturally → clean white circle + big icon.
const DEFAULT_AVATAR_ICON = '/icons/icon-192.png';
const AVATAR_BG = '#fff';
const AVATAR_KEY = (uid) => `app_avatar_${uid || 'guest'}`;

function readStoredAvatar(uid) {
  try { return localStorage.getItem(AVATAR_KEY(uid)) || ''; } catch { return ''; }
}

const LANG_CODES = ['en', 'ja', 'zh'];

const LANG_ICONS = {
  en: '/assets/figma/setting-lang-en.png',
  ja: '/assets/figma/setting-lang-ja.png',
  zh: '/assets/figma/setting-lang-chinese.png',
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

// Renders a tip string, turning every "chrome://apps" occurrence into a
// highlighted pill that copies the URL to the clipboard on click.
function renderTipWithCode(text, { copied, copiedLabel, onCopy }) {
  const TOKEN = 'chrome://apps';
  const segments = String(text).split(TOKEN);
  return segments.map((seg, i) => (
    <span key={i}>
      {seg}
      {i < segments.length - 1 && (
        <span
          onClick={(e) => { e.stopPropagation(); onCopy(TOKEN); }}
          title={TOKEN}
          style={{
            display: 'inline-block',
            backgroundColor: copied ? '#9ddc7d' : '#fff3a8',
            border: '1px solid #000',
            borderRadius: 6,
            padding: '0 8px',
            margin: '0 2px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 14,
            color: '#000',
            cursor: 'pointer',
            userSelect: 'all',
            transition: 'background-color 0.2s',
          }}
        >
          {copied ? '✓ ' + copiedLabel : TOKEN}
        </span>
      )}
    </span>
  ));
}

function ChevronDown() {
  return (
    <svg width="18" height="12" viewBox="0 0 18 12" fill="none">
      <path d="M1.5 1.5L9 9.5L16.5 1.5" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function SettingsPage({ nativeLang, targetLang, onLanguageChange, onLogout }) {
  const [pickerType, setPickerType] = useState(null); // 'native' | 'target' | null
  const [pendingCode, setPendingCode] = useState(null);
  const t = UI_TEXT[nativeLang] || UI_TEXT.zh;
  const prefix = ROW_PREFIX[nativeLang] || ROW_PREFIX.zh;
  const pickerTitles = PICKER_TITLES[nativeLang] || PICKER_TITLES.zh;

  const GUEST_LABEL = { zh: '游客', en: 'Guest', ja: 'ゲスト' };

  // Install-to-home-screen state.
  // Note: we deliberately do NOT short-circuit on display-mode/standalone —
  // that detection misfires on iOS after a user has previously installed +
  // deleted the home-screen icon, leaving the button incorrectly disabled.
  // Always let the click happen and show the appropriate modal / native prompt.
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isAndroid = /Android/.test(ua);
  const isMobile = isIOS || isAndroid;
  // iOS Chrome (and other non-Safari iOS browsers) — share menu lives at
  // the top, not the bottom, so the screenshot we show needs to differ.
  const isIOSNonSafari = isIOS && /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  // Safari macOS has no beforeinstallprompt and no address-bar install icon;
  // the only install path is File menu → Add to Dock (Sonoma+). Generic
  // "desktop" instructions written for Chrome don't apply here.
  const isSafariDesktop = !isMobile && /Safari/.test(ua) && !/Chrome|Chromium|Edg\/|Firefox|OPR\//.test(ua);
  const [installModal, setInstallModal] = useState(null); // 'ios' | 'android' | 'desktop' | 'safari-desktop' | 'unsupported' | null
  const [copiedFlash, setCopiedFlash] = useState(false);

  // Wait briefly for `beforeinstallprompt` to fire — Chrome often captures it
  // a moment after page load (after SW registration / engagement heuristics).
  // Without this wait, an early click falls straight to the manual modal even
  // though Chrome would have offered the native prompt half a second later.
  const waitForPrompt = (ms) => new Promise((resolve) => {
    if (window.__deferredInstallPrompt) { resolve(window.__deferredInstallPrompt); return; }
    let done = false;
    const onReady = () => {
      if (done) return;
      done = true;
      window.removeEventListener('installpromptready', onReady);
      resolve(window.__deferredInstallPrompt || null);
    };
    window.addEventListener('installpromptready', onReady);
    setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener('installpromptready', onReady);
      resolve(window.__deferredInstallPrompt || null);
    }, ms);
  });

  const handleInstallClick = async () => {
    // iOS Safari/Chrome don't support beforeinstallprompt at all — go
    // straight to the manual instructions.
    if (!isIOS) {
      const dp = await waitForPrompt(700);
      if (dp) {
        try {
          dp.prompt();
          const choice = await dp.userChoice;
          window.__deferredInstallPrompt = null;
          if (choice?.outcome === 'accepted') return; // installed
          // dismissed → fall through to platform-specific manual instructions.
        } catch { /* fall through */ }
      }
    }
    if (isIOS) { setInstallModal('ios'); return; }
    if (isAndroid) { setInstallModal('android'); return; }
    if (isSafariDesktop) { setInstallModal('safari-desktop'); return; }
    if (!isMobile) { setInstallModal('desktop'); return; }
    setInstallModal('unsupported');
  };

  // Password binding state
  const [user, setUser] = useState(null);
  const [avatarUrl, setAvatarUrl] = useState('');
  const [avatarError, setAvatarError] = useState('');
  const avatarInputRef = useRef(null);
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdError, setPwdError] = useState('');
  const [pwdInfo, setPwdInfo] = useState('');
  const [pwdLoading, setPwdLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return;
      const u = data.user || null;
      setUser(u);
      const stored = readStoredAvatar(u?.id);
      // OAuth providers expose the profile picture under different keys.
      // Check user_metadata first, then drill into each identity's identity_data.
      const m = u?.user_metadata || {};
      const fromIdentities = (u?.identities || [])
        .map((i) => i.identity_data || {})
        .find((d) => d.avatar_url || d.picture);
      const oauthPic = m.avatar_url
        || m.picture
        || (fromIdentities && (fromIdentities.avatar_url || fromIdentities.picture))
        || '';
      setAvatarUrl(stored || oauthPic || '');
      // Ensure today's login is counted even if App.jsx mounted before sign-in
      bumpLoginDay(u?.id);
    });
    return () => { mounted = false; };
  }, []);

  const handleAvatarClick = () => {
    avatarInputRef.current?.click();
  };

  const handleAvatarChange = (e) => {
    setAvatarError('');
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onerror = () => {
      setAvatarError(t.avatarUploadFailed || '头像上传失败，请重试');
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      // Downscale large images to keep localStorage usage modest.
      const img = new Image();
      img.onload = () => {
        try {
          const target = 256; // max dimension
          const scale = Math.min(1, target / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          try { localStorage.setItem(AVATAR_KEY(user?.id), dataUrl); } catch {
            setAvatarError(t.avatarUploadFailed || '头像上传失败，请重试');
            return;
          }
          setAvatarUrl(dataUrl);
        } catch {
          setAvatarError(t.avatarUploadFailed || '头像上传失败，请重试');
        }
      };
      img.onerror = () => {
        setAvatarError(t.avatarUploadFailed || '头像上传失败，请重试');
      };
      img.src = result;
    };
    reader.readAsDataURL(file);
  };

  // Detect password presence reliably. OAuth users (Google/Discord) who later
  // set a password don't get an "email" identity automatically, so we also check
  // a user_metadata flag we set on success, plus a per-user localStorage marker.
  const hasPassword = !!(
    user?.user_metadata?.has_password ||
    (user?.id && localStorage.getItem('has_password_' + user.id) === 'true') ||
    user?.identities?.some((i) => i.provider === 'email') ||
    user?.app_metadata?.providers?.includes('email')
  );
  const showPasswordRow = !!user; // hide for guest mode

  const openPwdModal = () => {
    setCurrentPwd(''); setNewPwd(''); setConfirmPwd(''); setPwdError(''); setPwdInfo('');
    setShowPwdModal(true);
  };
  const closePwdModal = () => {
    setShowPwdModal(false);
  };

  const handlePwdSubmit = async () => {
    setPwdError(''); setPwdInfo('');
    // Validate new password first (cheap, client-side)
    if (newPwd.length < 6) {
      setPwdError(t.passwordTooShort || '密码至少 6 位');
      return;
    }
    const hasLower = /[a-z]/.test(newPwd);
    const hasUpper = /[A-Z]/.test(newPwd);
    const hasDigit = /[0-9]/.test(newPwd);
    if (!hasLower || !hasUpper || !hasDigit) {
      setPwdError(t.passwordComplexity || '密码需包含大小写字母和数字');
      return;
    }
    if (newPwd !== confirmPwd) {
      setPwdError(t.passwordMismatch || '两次密码不一致');
      return;
    }
    setPwdLoading(true);
    try {
      // When changing existing password, verify current password first
      if (hasPassword) {
        if (!currentPwd) {
          setPwdError(t.currentPasswordRequired || '请先输入当前密码');
          setPwdLoading(false);
          return;
        }
        const email = user?.email;
        if (!email) throw new Error('No email');
        const { error: signInErr } = await supabase.auth.signInWithPassword({
          email,
          password: currentPwd,
        });
        if (signInErr) {
          setPwdError(t.currentPasswordWrong || '当前密码不正确');
          setPwdLoading(false);
          return;
        }
      }
      const { data, error } = await supabase.auth.updateUser({
        password: newPwd,
        data: { has_password: true },
      });
      if (error) throw error;
      // Show success message while keeping the modal contents intact.
      // Defer user-state update + modal close until after the message
      // has been visible for a beat, so the inputs don't appear to reset.
      setPwdInfo(hasPassword ? (t.passwordChangeSuccess || '密码已更新！') : (t.passwordSetSuccess || '密码已设置！'));
      setPwdLoading(false);
      await new Promise((r) => setTimeout(r, 1200));
      const { data: u } = await supabase.auth.getUser();
      const refreshed = u.user || data.user || null;
      if (refreshed?.id) {
        try { localStorage.setItem('has_password_' + refreshed.id, 'true'); } catch {}
      }
      setUser(refreshed);
      setShowPwdModal(false);
      setCurrentPwd(''); setNewPwd(''); setConfirmPwd('');
      return; // skip finally's setPwdLoading reset
    } catch (err) {
      const raw = err?.message || '';
      const isComplexity = /should contain at least one character of each/i.test(raw);
      setPwdError(isComplexity
        ? (t.passwordComplexity || '密码需包含大小写字母和数字')
        : (raw || t.passwordSetFailed || '设置失败'));
    } finally {
      setPwdLoading(false);
    }
  };

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

        {/* Profile section */}
        {(() => {
          const guestLabel = GUEST_LABEL[nativeLang] || GUEST_LABEL.zh;
          const displayName = user
            ? (user.user_metadata?.full_name
                || user.user_metadata?.name
                || (user.email ? user.email.split('@')[0] : guestLabel))
            : guestLabel;
          const days = getLoginDayCount(user?.id);
          const memberLine = (t.memberDays || '累计登录第 {n} 天').replace('{n}', String(days));
          const avatarSize = 54; // 63 × 0.85 (shrunk 15%)
          const isDefaultAvatar = !avatarUrl;
          return (
            <div style={{ position: 'absolute', left: 26, top: 58, display: 'flex', alignItems: 'center', gap: 11, maxWidth: 340 }}>
              <button
                type="button"
                onClick={handleAvatarClick}
                aria-label="Change avatar"
                className="active:scale-95"
                style={{
                  width: avatarSize, height: avatarSize,
                  flexShrink: 0,
                  padding: 0,
                  border: '2px solid #000',
                  background: isDefaultAvatar ? AVATAR_BG : '#fff',
                  borderRadius: '50%',
                  cursor: 'pointer',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxSizing: 'border-box',
                }}
              >
                <img
                  src={isDefaultAvatar ? DEFAULT_AVATAR_ICON : avatarUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    if (e.currentTarget.dataset.fallback) return;
                    e.currentTarget.dataset.fallback = '1';
                    e.currentTarget.src = DEFAULT_AVATAR_ICON;
                  }}
                  style={{
                    width: '100%', height: '100%',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                onChange={handleAvatarChange}
                style={{ display: 'none' }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{
                  fontSize: 22, color: '#000', lineHeight: 1.2,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{displayName}</p>
                <p style={{
                  fontSize: 14, color: '#000', lineHeight: 1.2, marginTop: 2,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {avatarError || memberLine}
                </p>
              </div>
            </div>
          );
        })()}

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

        {/* Add-to-home-screen pill — placed above password row */}
        <button
          onClick={handleInstallClick}
          className="absolute flex items-center active:scale-[0.98]"
          style={{
            left: 20, top: 368,
            width: 353, height: 50,
            backgroundColor: '#fff',
            border: '2px solid #000',
            borderRadius: 100,
          }}
        >
          <span style={{ marginLeft: 19, fontSize: 18, color: '#000' }}>
            <span style={{ marginRight: 8 }}>📲</span>
            {t.installToHome || '添加到桌面'}
          </span>
          <span style={{ marginLeft: 'auto', marginRight: 17, display: 'flex', alignItems: 'center' }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M9 1.5V11.5M9 11.5L4.5 7M9 11.5L13.5 7" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 13.5V15.5C2.5 16.0523 2.94772 16.5 3.5 16.5H14.5C15.0523 16.5 15.5 16.0523 15.5 15.5V13.5" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>

        {/* Password pill — only for logged-in users (not guest) */}
        {showPasswordRow && (
          <button
            onClick={openPwdModal}
            className="absolute flex items-center active:scale-[0.98]"
            style={{
              left: 20, top: 471,
              width: 353, height: 50,
              backgroundColor: '#fff',
              border: '2px solid #000',
              borderRadius: 100,
            }}
          >
            <span style={{ marginLeft: 19, fontSize: 18, color: '#000' }}>
              {hasPassword ? (t.changePasswordRow || '修改密码') : (t.setPasswordRow || '设置密码')}
            </span>
            <span style={{ marginLeft: 'auto', marginRight: 15 }}>
              <ChevronDown />
            </span>
          </button>
        )}

        {/* Logout / Sign-in button — yellow pill. Position follows last button above. */}
        {onLogout && (
          <div className="absolute flex justify-center" style={{ top: showPasswordRow ? 561 : 458, left: 0, right: 0 }}>
            <button
              onClick={() => {
                if (!user) {
                  // Guest mode: jump straight to login, no data to preserve.
                  onLogout();
                  return;
                }
                if (window.confirm(t.logoutConfirm || '确定要退出登录吗？')) {
                  onLogout();
                }
              }}
              className="active:scale-95 transition-transform"
              style={{
                width: user ? 128 : 148, height: 48,
                backgroundColor: '#ffd016',
                border: '2px solid #000',
                borderRadius: 100,
                fontSize: nativeLang === 'ja' ? 16 : 18,
                color: '#000',
                whiteSpace: 'nowrap',
              }}
            >
              {user
                ? (t.logout || '退出')
                : (nativeLang === 'en' ? 'Exit Test Mode' : nativeLang === 'ja' ? 'テストモードを終了' : '退出测试模式')}
            </button>
          </div>
        )}

      </div>

      {/* Language picker modal */}
      {pickerType && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={closePicker}
        >
          {/* Card — centered both axes */}
          <div
            className="relative"
            style={{
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

      {/* Install info modal (iOS instructions or unsupported notice) */}
      {installModal && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={() => setInstallModal(null)}
        >
          <div
            style={{
              width: 320,
              backgroundColor: '#fff',
              border: '2px solid #000',
              borderRadius: 20,
              padding: '26px 22px 22px',
              display: 'flex', flexDirection: 'column',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p style={{ textAlign: 'center', fontSize: 18, color: '#000', marginBottom: 14 }}>
              {t.installIosTitle || '添加到主屏幕'}
            </p>
            <p style={{ textAlign: 'center', fontSize: 15, color: '#000', lineHeight: 1.5, whiteSpace: 'pre-line' }}>
              {renderTipWithCode(
                installModal === 'ios'
                  ? (isIOSNonSafari
                      ? (t.installIosChromeTip || '请点击右上角「分享」按钮，然后选择「添加到主屏幕」。')
                      : (t.installIosTip || '请点击底部 Safari 的「分享」按钮，然后选择「添加到主屏幕」。'))
                  : installModal === 'android'
                  ? (t.installAndroidTip || '请点击 Chrome 右上角的「⋮」菜单，选择「安装应用」即可。')
                  : installModal === 'desktop'
                  ? (t.installDesktopTip || '看到这个提示，多半是你之前装过 PlushieWord 但卸载得不够干净。请在地址栏输入 chrome://apps，找到 PlushieWord 右键选择「从 Chrome 中删除」，回来再试一次。')
                  : installModal === 'safari-desktop'
                  ? (t.installSafariDesktopTip || '请点击 Safari 窗口右上角的分享按钮，在弹出的菜单里选择「添加到程序坞」。')
                  : (t.installUnsupported || '当前浏览器不支持一键添加。'),
                {
                  copied: copiedFlash,
                  copiedLabel: t.copied || 'Copied!',
                  onCopy: async (txt) => {
                    try { await navigator.clipboard.writeText(txt); }
                    catch {
                      const ta = document.createElement('textarea');
                      ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
                      document.body.appendChild(ta); ta.select();
                      try { document.execCommand('copy'); } catch {}
                      document.body.removeChild(ta);
                    }
                    setCopiedFlash(true);
                    setTimeout(() => setCopiedFlash(false), 1500);
                  },
                }
              )}
            </p>
            {(installModal === 'ios' || installModal === 'safari-desktop') && (
              <img
                src={(() => {
                  const lang = ['en','zh','ja','es','fr','ko'].includes(nativeLang) ? nativeLang : 'en';
                  if (installModal === 'safari-desktop') return `/assets/install/safari-desktop-${lang}.png`;
                  if (isIOSNonSafari) return `/assets/install/chrome-mobile-${lang}.jpg`;
                  return `/assets/install/safari-mobile-${lang}.jpg`;
                })()}
                alt=""
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                style={{
                  marginTop: 14,
                  width: '100%',
                  borderRadius: 12,
                  border: '1px solid #ddd',
                  display: 'block',
                }}
              />
            )}
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 18 }}>
              <button
                onClick={() => setInstallModal(null)}
                className="active:scale-95"
                style={{
                  width: 130, height: 39,
                  backgroundColor: '#ffd016',
                  border: '2px solid #000',
                  borderRadius: 100,
                  fontSize: 18, color: '#000',
                }}
              >
                {t.iKnow || (t.ok || '确认')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Password modal */}
      {showPwdModal && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
        >
          <div
            style={{
              width: 353,
              backgroundColor: '#fff',
              border: '2px solid #000',
              borderRadius: 20,
              padding: '30px 24px 28px',
              display: 'flex', flexDirection: 'column',
            }}
          >
            {/* Title */}
            <p style={{
              textAlign: 'center', fontSize: 18, color: '#000',
              marginBottom: 22,
            }}>
              {hasPassword ? (t.changePasswordTitle || '修改登录密码') : (t.setPasswordTitle || '设置登录密码')}
            </p>

            {/* Current password — only when changing an existing password */}
            {hasPassword && (
              <>
                <label style={{
                  fontSize: 14, color: '#000', marginLeft: 4, marginBottom: 6,
                }}>
                  {t.currentPasswordLabel || '当前密码'}
                </label>
                <input
                  type="password"
                  value={currentPwd}
                  onChange={(e) => setCurrentPwd(e.target.value)}
                  placeholder={t.currentPasswordPlaceholder || '请输入当前密码'}
                  autoFocus
                  style={{
                    height: 44,
                    border: '2px solid #000',
                    borderRadius: 22,
                    paddingLeft: 18, paddingRight: 18,
                    fontSize: 15, color: '#000',
                    outline: 'none',
                    backgroundColor: '#fff',
                    marginBottom: 14,
                  }}
                />
              </>
            )}

            {/* New password */}
            <label style={{
              fontSize: 14, color: '#000', marginLeft: 4, marginBottom: 6,
            }}>
              {t.newPasswordLabel || '新密码'}
            </label>
            <input
              type="password"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              placeholder={t.passwordPlaceholder || '至少6位且包含大小写字母和数字'}
              autoFocus={!hasPassword}
              style={{
                height: 44,
                border: '2px solid #000',
                borderRadius: 22,
                paddingLeft: 18, paddingRight: 18,
                fontSize: 15, color: '#000',
                outline: 'none',
                backgroundColor: '#fff',
                marginBottom: 14,
              }}
            />

            {/* Confirm new password */}
            <label style={{
              fontSize: 14, color: '#000', marginLeft: 4, marginBottom: 6,
            }}>
              {t.confirmPasswordLabel || '确认新密码'}
            </label>
            <input
              type="password"
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              placeholder={t.passwordPlaceholder || '至少6位且包含大小写字母和数字'}
              style={{
                height: 44,
                border: '2px solid #000',
                borderRadius: 22,
                paddingLeft: 18, paddingRight: 18,
                fontSize: 15, color: '#000',
                outline: 'none',
                backgroundColor: '#fff',
              }}
            />

            {/* Error / info message */}
            {(pwdError || pwdInfo) && (
              <p style={{
                textAlign: 'center', fontSize: 13,
                color: pwdError ? '#dc2626' : '#15803d',
                lineHeight: 1.3,
                marginTop: 12,
                wordBreak: 'break-word',
              }}>
                {pwdError || pwdInfo}
              </p>
            )}

            {/* Cancel + Next/Confirm buttons */}
            <div style={{
              display: 'flex', justifyContent: 'center', gap: 16,
              marginTop: 20,
            }}>
              <button
                onClick={closePwdModal}
                className="active:scale-95"
                style={{
                  width: 110, height: 39,
                  backgroundColor: '#fff',
                  border: '2px solid #000',
                  borderRadius: 100,
                  fontSize: 16, color: '#000',
                }}
              >
                {t.cancel || '取消'}
              </button>
              <button
                onClick={handlePwdSubmit}
                disabled={pwdLoading}
                className="active:scale-95 disabled:opacity-50"
                style={{
                  width: 130, height: 39,
                  backgroundColor: '#ffd016',
                  border: '2px solid #000',
                  borderRadius: 100,
                  fontSize: 18, color: '#000',
                }}
              >
                {pwdLoading ? '...' : (t.ok || '确认')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
