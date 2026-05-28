import { useState, useEffect } from 'react';
import { usePostHog } from '@posthog/react';
import { getInstallAssetUrl } from '../utils/assetUrl';

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

// Add-to-home-screen prompt + manual-instructions modal. Owns platform
// detection, the deferred BeforeInstallPromptEvent wait, modal state, and
// the modal JSX itself — so any caller can fire the install flow with a
// single openInstall() and just render modalNode at app level.
export function useInstallPrompt(nativeLang, t) {
  const posthog = usePostHog();
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isAndroid = /Android/.test(ua);
  const isMobile = isIOS || isAndroid;
  const isIOSNonSafari = isIOS && /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const isSafariDesktop = !isMobile && /Safari/.test(ua) && !/Chrome|Chromium|Edg\/|Firefox|OPR\//.test(ua);

  const [installModal, setInstallModal] = useState(null);
  const [copiedFlash, setCopiedFlash] = useState(false);
  // Whether `openInstall()` will actually lead somewhere actionable. On iOS /
  // Android / Safari desktop we always show manual instructions (real steps
  // the user can follow). On other desktops the flow only works if Chrome has
  // fired `beforeinstallprompt` — otherwise the fallback modal just tells the
  // user to wipe a stale install. Callers use this to decide whether to even
  // surface an install nudge.
  const [deferredReady, setDeferredReady] = useState(
    typeof window !== 'undefined' && !!window.__deferredInstallPrompt
  );
  useEffect(() => {
    const onReady = () => setDeferredReady(!!window.__deferredInstallPrompt);
    const onInstalled = () => setDeferredReady(false);
    window.addEventListener('installpromptready', onReady);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('installpromptready', onReady);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  const installAvailable = isIOS || isAndroid || isSafariDesktop || deferredReady;

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

  const openInstall = async () => {
    posthog?.capture('install_prompt_clicked', { platform: isIOS ? 'ios' : isAndroid ? 'android' : 'desktop', native_lang: nativeLang });
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
        } catch { /* fall through */ }
      }
    }
    if (isIOS) { setInstallModal('ios'); return; }
    if (isAndroid) { setInstallModal('android'); return; }
    if (isSafariDesktop) { setInstallModal('safari-desktop'); return; }
    if (!isMobile) { setInstallModal('desktop'); return; }
    setInstallModal('unsupported');
  };

  const modalNode = installModal ? (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center"
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
              if (installModal === 'safari-desktop') return getInstallAssetUrl(`safari-desktop-${lang}.png`);
              if (isIOSNonSafari) return getInstallAssetUrl(`chrome-mobile-${lang}.jpg`);
              return getInstallAssetUrl(`safari-mobile-${lang}.jpg`);
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
              backgroundColor: '#FFDF4E',
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
  ) : null;

  return { openInstall, modalNode, installAvailable };
}
