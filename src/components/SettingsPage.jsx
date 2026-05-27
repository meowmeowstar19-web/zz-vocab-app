import { useState, useEffect, useRef, useCallback } from 'react';
import { getLangName, UI_TEXT } from '../utils/langHelpers';
import { supabase } from '../lib/supabase';
import { getLoginDayCount, bumpLoginDay } from '../utils/storage';
import { canSwitchLanguageFreely } from '../config/languageWhitelist';
import { usePostHog } from '@posthog/react';

const DEFAULT_AVATAR_ICON = '/icons/icon-source.png';
const AVATAR_KEY = (uid) => `app_avatar_${uid || 'guest'}`;

// Per-user lifetime cap on language switches. Whitelist + test mode bypass.
// Native and target are tracked separately, each with its own cap.
const MAX_LANG_SWITCHES = 2;
const SWITCH_KEY = (type, uid) => `lang_switches_${type}_${uid || 'guest'}`;
function readSwitchCount(type, uid) {
  try { return parseInt(localStorage.getItem(SWITCH_KEY(type, uid)) || '0', 10) || 0; }
  catch { return 0; }
}
function bumpSwitchCount(type, uid) {
  const next = readSwitchCount(type, uid) + 1;
  try { localStorage.setItem(SWITCH_KEY(type, uid), String(next)); } catch {}
  return next;
}

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

function ChevronDown() {
  return (
    <svg width="18" height="12" viewBox="0 0 18 12" fill="none">
      <path d="M1.5 1.5L9 9.5L16.5 1.5" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function SettingsPage({ nativeLang, targetLang, onLanguageChange, onLogout, onInstallClick, pwaInstalled, bindOAuthPending = false, onOpenLoginPrompt }) {
  const posthog = usePostHog();
  const [pickerType, setPickerType] = useState(null); // 'native' | 'target' | null
  const [pendingCode, setPendingCode] = useState(null);
  // { type: 'native'|'target', code: 'en'|'ja'|'zh', remainingAfter: number } — confirmation popup state
  const [pendingSwitch, setPendingSwitch] = useState(null);
  const [switchCounts, setSwitchCounts] = useState({ native: 0, target: 0 });
  const t = UI_TEXT[nativeLang] || UI_TEXT.zh;
  const prefix = ROW_PREFIX[nativeLang] || ROW_PREFIX.zh;
  const pickerTitles = PICKER_TITLES[nativeLang] || PICKER_TITLES.zh;

  // Short-screen gap shift: matches the home page's responsive scaling
  // threshold so the pills tighten up on small phones (iPhone SE / mini).
  const [isShortScreen, setIsShortScreen] = useState(() => typeof window !== 'undefined' && window.innerHeight < 700);
  useEffect(() => {
    const update = () => setIsShortScreen(window.innerHeight < 700);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const pillGap = isShortScreen ? 25 : 35;

  const GUEST_LABEL = { zh: '游客', en: 'Guest', ja: 'ゲスト' };

  // Feedback state
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackError, setFeedbackError] = useState('');
  const [feedbackSending, setFeedbackSending] = useState(false);
  // Each item: { id, dataUrl, file }. `dataUrl` is the in-memory preview;
  // we upload `file` to supabase storage on send.
  const [feedbackImages, setFeedbackImages] = useState([]);
  const feedbackFileInputRef = useRef(null);
  const FEEDBACK_MAX_IMAGES = 10;
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(id);
  }, [toast]);

  const openFeedbackModal = () => {
    // Step 1's anon refactor made guests a real `user`, so the old `!user`
    // gate stopped firing — feedback rows started coming in with no email
    // (anon users don't have one). Restore the original intent: feedback
    // requires a real (non-anonymous) signed-in account.
    if (!user || user.is_anonymous) {
      setToast(t.feedbackLoginRequired || '登录后才能发送意见反馈哦~');
      return;
    }
    setFeedbackText('');
    setFeedbackError('');
    setFeedbackImages([]);
    setShowFeedbackModal(true);
  };
  const closeFeedbackModal = () => {
    setShowFeedbackModal(false);
    setFeedbackImages([]);
  };

  // Downscale + JPEG-encode an image File so a single feedback row stays bounded.
  // Stored as base64 data URLs directly in the feedback row, so a smaller cap
  // keeps the row safely under Postgres limits even with 10 images attached.
  // Max edge 900px, quality 0.7 → ~50–150 KB per shot.
  const compressImageFile = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') { reject(new Error('read')); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const max = 900;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          resolve({ dataUrl });
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('decode'));
      img.src = result;
    };
    reader.readAsDataURL(file);
  });

  const handleFeedbackImagePick = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    const remaining = FEEDBACK_MAX_IMAGES - feedbackImages.length;
    const accepted = files.slice(0, remaining);
    if (files.length > remaining) {
      setFeedbackError(t.feedbackImagesTooMany || '最多只能选 10 张图哦~');
    } else if (feedbackError === (t.feedbackImagesTooMany || '最多只能选 10 张图哦~')) {
      setFeedbackError('');
    }
    const out = [];
    for (const f of accepted) {
      if (!f.type.startsWith('image/')) continue;
      try {
        const { dataUrl } = await compressImageFile(f);
        out.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, dataUrl });
      } catch {/* ignore individual failures */}
    }
    if (out.length === 0) return;
    setFeedbackImages((prev) => [...prev, ...out].slice(0, FEEDBACK_MAX_IMAGES));
  };

  const removeFeedbackImage = (id) => {
    setFeedbackImages((prev) => prev.filter((img) => img.id !== id));
  };

  const handleFeedbackSend = async () => {
    const msg = feedbackText.trim();
    if (!msg) {
      setFeedbackError(t.feedbackEmpty || '请先输入反馈内容');
      return;
    }
    if (!user) return; // safety — modal shouldn't be open in test mode
    setFeedbackError('');
    setFeedbackSending(true);
    try {
      // Images are stored as base64 data URLs in the `images` jsonb column on
      // the feedback row — no storage bucket required. Compression in
      // compressImageFile keeps the row bounded.
      const images = feedbackImages.map((img) => img.dataUrl);
      const { error } = await supabase.from('feedback').insert({
        user_id: user.id,
        email: user.email || null,
        message: msg,
        native_lang: nativeLang,
        target_lang: targetLang,
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        images: images.length ? images : null,
      });
      if (error) throw error;
      posthog?.capture('feedback_submitted', {
        native_lang: nativeLang, target_lang: targetLang,
        image_count: images.length,
      });
      setShowFeedbackModal(false);
      setFeedbackImages([]);
      setToast(t.feedbackSent || '反馈已发送，谢谢你！');
    } catch (err) {
      setFeedbackError(err?.message || t.feedbackSendFailed || '发送失败，请稍后再试');
    } finally {
      setFeedbackSending(false);
    }
  };

  const SOCIAL_LINKS = [
    { key: 'discord', icon: '/assets/figma/social-icon-discord.png', url: 'https://discord.gg/FbkNw2AYYB' },
    { key: 'tiktok', icon: '/assets/figma/social-icon-tiktok.png', url: 'https://www.tiktok.com/@getplushieword?_r=1&_t=ZT-96dQssXqgHO' },
    { key: 'youtube', icon: '/assets/figma/social-icon-youtube.png', url: 'https://youtube.com/@plushieword?si=UggxFGiMaDEYE-PB' },
    { key: 'instagram', icon: '/assets/figma/social-icon-ig.png', url: 'https://www.instagram.com/getplushieword?igsh=MWVnY2ptMzNoeW9rZw%3D%3D&utm_source=qr' },
  ];

  // Use a real <a target="_blank"> below — window.open() in iOS standalone
  // PWAs hijacks the PWA view itself and leaves the user stranded on a blank
  // in-app browser when they come back. Anchors with target="_blank" open in
  // Safari without breaking the PWA shell.
  const handleSocialClick = (key) => {
    posthog?.capture('social_link_clicked', { network: key });
  };

  // Save-progress modal is now owned by App.jsx (single instance, Step 4).
  // SettingsPage signals "user clicked Sign up / Log in" via the
  // onOpenLoginPrompt callback. App reads its loginModal reducer to render
  // the LoginPromptModal at App level — that removes the entire class of
  // stacked-popup bugs and the pending/error state-pipeline that lived here.

  const [user, setUser] = useState(null);
  const [avatarUrl, setAvatarUrl] = useState('');
  const [avatarError, setAvatarError] = useState('');
  const avatarInputRef = useRef(null);

  // applyUser is shared between the initial load, the auth listener, and the
  // OAuth-bind resolution effect below. Wrapped in useCallback so the
  // dependency closure stays stable across renders.
  const applyUser = useCallback((u) => {
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
    // Hydrate per-user switch counts so the gate / confirmation popup are accurate.
    setSwitchCounts({
      native: readSwitchCount('native', u?.id),
      target: readSwitchCount('target', u?.id),
    });
    // Ensure today's login is counted even if App.jsx mounted before sign-in
    bumpLoginDay(u?.id);
  }, []);

  // Initial and post-OAuth-bind user load. We re-run when `bindOAuthPending`
  // transitions to false: on mount with the flag set, we deliberately
  // SKIP fetching the user so SettingsPage doesn't briefly render the
  // existing account's identity (email, avatar) while
  // App.jsx is still resolving whether the bind should be rejected. App.jsx
  // flips `bindOAuthPending` to false in `runSyncOrReject`'s finally — at
  // which point the session is either kept (success) or cleared via signOut
  // (rejection), and getUser() returns the correct final state.
  useEffect(() => {
    if (bindOAuthPending) return;
    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (mounted) applyUser(data.user || null);
    });
    return () => { mounted = false; };
  }, [bindOAuthPending, applyUser]);

  // Keep `user` in sync with auth state for the rest of the session. Without
  // this listener, after a bind-rejection signOut (or any later logout),
  // SettingsPage would keep rendering the previous account's identity until
  // the next remount — exactly the bug that made the guest look silently
  // swapped onto the existing account.
  useEffect(() => {
    let mounted = true;
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      if (!mounted) return;
      // Suppress SIGNED_IN-type events while an OAuth bind is still being
      // resolved — applying the OAuth user here would re-introduce the flash.
      // SIGNED_OUT (s === null) is fine to apply; it's what restores guest UI
      // after the rejection signOut.
      if (s?.user) {
        try {
          if (localStorage.getItem('bind_oauth_pending') === '1') return;
        } catch {}
        applyUser(s.user);
      } else {
        applyUser(null);
      }
    });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, [applyUser]);

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

  // Step 1's anonymous-session refactor gave guests a real supabase session,
  // so `user` is now truthy for anon guests too. Treat anon as guest-equivalent
  // for the "Sign up / Log in" pill split.
  const isRealUser = !!user && !user.is_anonymous;

  // Test mode (guest, no supabase user) and whitelisted emails can switch freely.
  // Everyone else gets a per-side cap of MAX_LANG_SWITCHES (2 by default).
  const hasUnlimitedSwitches = !user || canSwitchLanguageFreely(user?.email);

  const openPicker = (type) => {
    if (!hasUnlimitedSwitches && switchCounts[type] >= MAX_LANG_SWITCHES) {
      setToast(t.languageSwitchLocked || '切换次数已用完，暂时不支持继续切换哦~');
      return;
    }
    setPendingCode(type === 'native' ? nativeLang : targetLang);
    setPickerType(type);
  };

  const closePicker = () => {
    setPickerType(null);
    setPendingCode(null);
  };

  // Apply the language change without bumping any counter.
  const applyLanguageChange = (type, code) => {
    if (type === 'native') {
      if (code === nativeLang) return;
      posthog?.capture('language_changed', { type: 'native', from: nativeLang, to: code });
      if (code === targetLang) {
        onLanguageChange({ native: code, target: nativeLang });
      } else {
        onLanguageChange({ native: code });
      }
    } else {
      if (code === targetLang) return;
      posthog?.capture('language_changed', { type: 'target', from: targetLang, to: code, native_lang: nativeLang });
      if (code === nativeLang) {
        onLanguageChange({ native: targetLang, target: code });
      } else {
        onLanguageChange({ target: code });
      }
    }
  };

  const handleConfirm = () => {
    if (!pickerType || !pendingCode) { closePicker(); return; }
    const isSame = pickerType === 'native' ? pendingCode === nativeLang : pendingCode === targetLang;
    if (isSame) { closePicker(); return; }
    if (hasUnlimitedSwitches) {
      applyLanguageChange(pickerType, pendingCode);
      closePicker();
      return;
    }
    // Non-allowlisted, real account: show confirmation popup with remaining count.
    const remainingAfter = Math.max(0, MAX_LANG_SWITCHES - (switchCounts[pickerType] + 1));
    setPendingSwitch({ type: pickerType, code: pendingCode, remainingAfter });
  };

  const confirmSwitch = () => {
    if (!pendingSwitch) return;
    const { type, code } = pendingSwitch;
    if (user?.id) {
      const next = bumpSwitchCount(type, user.id);
      setSwitchCounts((prev) => ({ ...prev, [type]: next }));
    }
    applyLanguageChange(type, code);
    setPendingSwitch(null);
    closePicker();
  };

  const cancelSwitch = () => {
    // Keep the picker open so the user can re-pick or back out.
    setPendingSwitch(null);
  };

  // Icon positions relative to the modal card (card left=20 on screen)
  // From Figma: en at screen-left=44 → card-rel=24, ja=146, zh=268
  const ICON_LEFT = { en: 24, ja: 146, zh: 268 };
  const ICON_TOP = 90;   // 252 - 162 (card top)
  const LABEL_MT = 12;   // gap between circle bottom and label (97px from container - 85px icon = 12px)

  return (
    <div className="relative h-full overflow-hidden">
      {/* Background — stays fixed in the outer (non-scrolling) layer so the
          decorative artwork doesn't slide off as the content scrolls. */}
      <img
        src="/assets/figma/setting-background.jpg"
        alt=""
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
        style={{ zIndex: 0 }}
      />

      {/* Scroll layer — everything (profile, pills, signup) flows naturally
          and scrolls together when the viewport is short. */}
      <div className="relative z-10 h-full overflow-y-auto scrollbar-hide flex flex-col">

      {/* Top: Profile */}
      <div className="shrink-0" style={{ paddingLeft: 26, paddingTop: 25, paddingBottom: 16, paddingRight: 18 }}>

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
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, maxWidth: 340 }}>
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
                  background: '#fff',
                  borderRadius: '50%',
                  cursor: 'pointer',
                  overflow: 'hidden',
                  boxSizing: 'border-box',
                }}
              >
                <img
                  src={avatarUrl || DEFAULT_AVATAR_ICON}
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
      </div>

      {/* Middle: pills region. Flows inline with profile + signup so the
          entire settings page scrolls together when the viewport is short. */}
      <div className="shrink-0" style={{ padding: '0 18px' }}>
        <div className="flex flex-col items-center" style={{ gap: pillGap }}>

        {/* Native language pill */}
        <button
          onClick={() => openPicker('native')}
          className="flex items-center active:scale-[0.98]"
          style={{
            width: 357, height: 50, flexShrink: 0,
            backgroundColor: 'rgba(255,255,255,0.4)',
            border: '2px solid #000',
            borderRadius: 100,
          }}
        >
          <span style={{ marginLeft: 19, fontSize: 18, color: '#000' }}>
            <span style={{ marginRight: 8 }}>🗣️</span>
            {prefix.native}：{getLangName(nativeLang, nativeLang)}
          </span>
          <span style={{ marginLeft: 'auto', marginRight: 15 }}>
            <ChevronDown />
          </span>
        </button>

        {/* Target language pill */}
        <button
          onClick={() => openPicker('target')}
          className="flex items-center active:scale-[0.98]"
          style={{
            width: 357, height: 50, flexShrink: 0,
            backgroundColor: 'rgba(255,255,255,0.4)',
            border: '2px solid #000',
            borderRadius: 100,
          }}
        >
          <span style={{ marginLeft: 19, fontSize: 18, color: '#000' }}>
            <span style={{ marginRight: 8 }}>📚</span>
            {prefix.target}：{getLangName(targetLang, nativeLang)}
          </span>
          <span style={{ marginLeft: 'auto', marginRight: 15 }}>
            <ChevronDown />
          </span>
        </button>

        {/* Add-to-home-screen pill.
            When the PWA is already installed, become a non-clickable status row
            so the user knows it's done. The check-in popup follows the same
            pwaInstalled state, so the two stay in sync. */}
        <button
          onClick={pwaInstalled ? undefined : onInstallClick}
          disabled={pwaInstalled}
          className={'flex items-center' + (pwaInstalled ? '' : ' active:scale-[0.98]')}
          style={{
            width: 357, height: 50, flexShrink: 0,
            backgroundColor: 'rgba(255,255,255,0.4)',
            border: '2px solid #000',
            borderRadius: 100,
            cursor: pwaInstalled ? 'default' : 'pointer',
          }}
        >
          <span style={{ marginLeft: 19, fontSize: 18, color: '#000' }}>
            <span style={{ marginRight: 8 }}>{pwaInstalled ? '✅' : '📲'}</span>
            {pwaInstalled ? (t.installAlready || '已添加到桌面') : (t.installToHome || '添加到桌面')}
          </span>
          {!pwaInstalled && (
            <span style={{ marginLeft: 'auto', marginRight: 17, display: 'flex', alignItems: 'center' }}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M9 1.5V11.5M9 11.5L4.5 7M9 11.5L13.5 7" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M2.5 13.5V15.5C2.5 16.0523 2.94772 16.5 3.5 16.5H14.5C15.0523 16.5 15.5 16.0523 15.5 15.5V13.5" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          )}
        </button>

        {/* Feedback pill — placed below "Add to home screen" */}
        <button
          onClick={openFeedbackModal}
          className="flex items-center active:scale-[0.98]"
          style={{
            width: 357, height: 50, flexShrink: 0,
            backgroundColor: 'rgba(255,255,255,0.4)',
            border: '2px solid #000',
            borderRadius: 100,
          }}
        >
          <span style={{ marginLeft: 19, fontSize: 18, color: '#000' }}>
            <span style={{ marginRight: 8 }}>💬</span>
            {t.feedbackRow || '意见反馈'}
          </span>
          <span style={{ marginLeft: 'auto', marginRight: 17, display: 'flex', alignItems: 'center' }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M3 3H15V12H10L6 15V12H3V3Z" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>

        {/* Follow-us pill — 4 social icons inside a pill matching the other rows.
            Each icon is a separate tap target opening the external profile in a
            new tab. */}
        <div
          className="flex items-center"
          style={{
            width: 357, height: 50, flexShrink: 0,
            backgroundColor: 'rgba(255,255,255,0.4)',
            border: '2px solid #000',
            borderRadius: 100,
          }}
        >
          <span style={{ marginLeft: 19, fontSize: 18, color: '#000', whiteSpace: 'nowrap' }}>
            <span style={{ marginRight: 8 }}>❤️</span>
            {t.followUsRow || '求关注'}
          </span>
          {/* Icons stretch across the remaining pill space with space-evenly so
              each tap target is comfortably wide on a phone. */}
          <div style={{
            flex: 1,
            marginLeft: 8,
            marginRight: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-evenly',
          }}>
            {SOCIAL_LINKS.map((s) => (
              <a
                key={s.key}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => handleSocialClick(s.key)}
                aria-label={s.key}
                className="active:scale-90"
                style={{
                  width: 34, height: 34,
                  padding: 0,
                  background: 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  textDecoration: 'none',
                }}
              >
                <img src={s.icon} alt={s.key} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              </a>
            ))}
          </div>
        </div>

        </div>
      </div>

      {/* Bottom: Sign-up + Log-in link, OR Logout button. Distance from the
          last pill matches the pill-to-pill gap so the spacing rhythm is
          consistent down the page. */}
      <div className="shrink-0" style={{ paddingTop: pillGap, paddingBottom: 20 }}>
        {/* Guest mode: small centered "Sign up" yellow button + "Already have
            an account? Log in" link below. Both open the LoginPromptModal —
            Sign up pre-selects the Email signup form, Log in pre-selects the
            Email login form. Anon users (Step 1) are treated as guests here —
            they need to sign up / bind. */}
        {!isRealUser && (
          <>
            <div className="flex justify-center">
              <button
                onClick={() => onOpenLoginPrompt?.({ flowType: 'bind', emailMode: 'signup' })}
                className="active:scale-95 transition-transform"
                style={{
                  minWidth: 138, height: 48,
                  padding: '0 22px',
                  backgroundColor: '#FFDF4E',
                  border: '2px solid #000',
                  borderRadius: 100,
                  fontSize: 20, color: '#000',
                  whiteSpace: 'nowrap',
                }}
              >
                {t.signupBtn || 'Sign up'}
              </button>
            </div>

            <p
              className="text-center"
              style={{
                marginTop: 14,
                fontSize: 15, color: '#000', lineHeight: 1.4,
              }}
            >
              {t.hasAccountAlready || 'Already have an account? '}
              <button
                type="button"
                onClick={() => onOpenLoginPrompt?.({ flowType: 'login', emailMode: 'login' })}
                className="underline active:opacity-70"
                style={{
                  background: 'transparent', border: 0, padding: 0, margin: 0,
                  color: '#000', fontSize: 15, cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {t.loginBtn || 'Log in'}
              </button>
            </p>
          </>
        )}

        {/* Yellow logout pill — real (non-anon) users only. Anon guests
            don't have an account to log out of; signing out their anon
            session would just orphan their local progress. */}
        {isRealUser && onLogout && (
          <div className="flex justify-center">
            <button
              onClick={() => {
                if (window.confirm(t.logoutConfirm || '确定要退出登录吗？')) {
                  onLogout();
                }
              }}
              className="active:scale-95 transition-transform"
              style={{
                width: 128, height: 48,
                backgroundColor: '#FFDF4E',
                border: '2px solid #000',
                borderRadius: 100,
                fontSize: nativeLang === 'ja' ? 16 : 18,
                color: '#000',
                whiteSpace: 'nowrap',
              }}
            >
              {t.logout || '退出'}
            </button>
          </div>
        )}
      </div>

      </div>{/* /scroll layer */}

      {/* Language picker modal — content swaps to a confirmation prompt
          when the user is on a capped path and has selected a different language. */}
      {pickerType && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={pendingSwitch ? cancelSwitch : closePicker}
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
            {pendingSwitch ? (
              <>
                {/* Inline confirmation prompt */}
                <p style={{
                  position: 'absolute',
                  left: 28, right: 28,
                  top: '50%', transform: 'translateY(-50%)',
                  marginTop: -28,
                  textAlign: 'center',
                  fontSize: 18, color: '#000',
                  lineHeight: 1.6,
                }}>
                  {(t.languageSwitchConfirm || '切换后只剩 {n} 次切换机会，确认要切换吗？')
                    .replace('{n}', String(pendingSwitch.remainingAfter))}
                </p>
                <div style={{
                  position: 'absolute',
                  left: 0, right: 0, bottom: 34,
                  display: 'flex', justifyContent: 'center', gap: 16,
                }}>
                  <button
                    onClick={cancelSwitch}
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
                    onClick={confirmSwitch}
                    className="active:scale-95"
                    style={{
                      width: 130, height: 39,
                      backgroundColor: '#FFDF4E',
                      border: '2px solid #000',
                      borderRadius: 100,
                      fontSize: 18, color: '#000',
                    }}
                  >
                    {t.ok || '确认'}
                  </button>
                </div>
              </>
            ) : (
              <>
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
                    backgroundColor: '#FFDF4E',
                    border: '2px solid #000',
                    borderRadius: 100,
                    fontSize: 18, color: '#000',
                  }}
                >
                  {t.ok}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Save-progress LoginPromptModal lives at App level (Step 4). */}

      {/* Toast (login-required, send-success, etc.) */}
      {toast && (
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[60] max-w-[320px] px-[16px] py-[10px] rounded-[14px] bg-black/80 text-white text-[13px] text-center leading-snug shadow-lg pointer-events-none whitespace-nowrap"
        >
          {toast}
        </div>
      )}

      {/* Feedback modal */}
      {showFeedbackModal && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
          onClick={closeFeedbackModal}
        >
          <div
            style={{
              width: 373,
              backgroundColor: '#fff',
              border: '2px solid #000',
              borderRadius: 20,
              padding: '30px 24px 28px',
              display: 'flex', flexDirection: 'column',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p style={{
              textAlign: 'center', fontSize: 18, color: '#000', marginBottom: 18,
            }}>
              {t.feedbackTitle || '意见反馈'}
            </p>

            <textarea
              value={feedbackText}
              onChange={(e) => { setFeedbackText(e.target.value); if (feedbackError) setFeedbackError(''); }}
              placeholder={t.feedbackPlaceholder || '欢迎告诉我们你的想法、问题或建议……'}
              autoFocus
              rows={5}
              style={{
                width: '100%',
                minHeight: 120,
                border: '2px solid #000',
                borderRadius: 16,
                padding: '12px 14px',
                fontSize: 15, color: '#000',
                lineHeight: 1.4,
                outline: 'none',
                resize: 'vertical',
                boxSizing: 'border-box',
                fontFamily: 'inherit',
                backgroundColor: '#fff',
              }}
            />

            {/* Image attachments — 4-column grid that spans the textarea's full
                width so first/last cells align with its left/right edges. The
                remove button (×) sits OUTSIDE each thumb's overflow:hidden
                clip so it can't get cropped. */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 16,
              marginTop: 18,
            }}>
              {feedbackImages.map((img) => (
                <div
                  key={img.id}
                  style={{
                    position: 'relative',
                    aspectRatio: '1 / 1',
                  }}
                >
                  {/* Inner div clips the rounded image; X sits on the outer */}
                  <div style={{
                    width: '100%', height: '100%',
                    border: '2px solid #000',
                    borderRadius: 12,
                    overflow: 'hidden',
                    backgroundColor: '#fff',
                  }}>
                    <img
                      src={img.dataUrl}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeFeedbackImage(img.id)}
                    aria-label="Remove"
                    className="active:scale-90"
                    style={{
                      position: 'absolute', top: -8, right: -8,
                      width: 22, height: 22,
                      borderRadius: '50%',
                      border: '2px solid #000',
                      backgroundColor: '#fff',
                      color: '#000',
                      fontSize: 14, lineHeight: 1,
                      cursor: 'pointer',
                      padding: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      zIndex: 1,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              {feedbackImages.length < FEEDBACK_MAX_IMAGES && (
                <button
                  type="button"
                  onClick={() => feedbackFileInputRef.current?.click()}
                  aria-label={t.feedbackAddImage || '添加图片'}
                  className="active:scale-95"
                  style={{
                    aspectRatio: '1 / 1',
                    border: '2px dashed #000',
                    borderRadius: 12,
                    backgroundColor: '#fff',
                    color: '#000',
                    fontSize: 28, lineHeight: 1,
                    cursor: 'pointer',
                    padding: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  +
                </button>
              )}
              <input
                ref={feedbackFileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFeedbackImagePick}
                style={{ display: 'none' }}
              />
            </div>

            {feedbackError && (
              <p style={{
                textAlign: 'center', fontSize: 13, color: '#dc2626',
                lineHeight: 1.3, marginTop: 10,
              }}>
                {feedbackError}
              </p>
            )}

            <div style={{
              display: 'flex', justifyContent: 'center', gap: 16, marginTop: 18,
            }}>
              <button
                onClick={closeFeedbackModal}
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
                onClick={handleFeedbackSend}
                disabled={feedbackSending}
                className="active:scale-95 disabled:opacity-50"
                style={{
                  width: 130, height: 39,
                  backgroundColor: '#FFDF4E',
                  border: '2px solid #000',
                  borderRadius: 100,
                  fontSize: 18, color: '#000',
                }}
              >
                {feedbackSending ? '...' : (t.send || '发送')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
