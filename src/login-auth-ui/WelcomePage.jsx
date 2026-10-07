/* ---------------------------------------------------------- WelcomePage */
// Full-screen page shown ONLY on the welcome/logged-out gate (new core:
// status === 'guest' && atWelcome — the old LOGGED_OUT). Moved near-verbatim
// from src/auth/ui.jsx (Phase 2). PW design minus welcome-text.png (the one
// deliberate difference).
// 13岁以下（docs/kids-account-plan.md）：本设备还没答过年龄 → 页面一出来就盖一个
// 年龄弹窗（可关：Guest Mode 不问年龄；关了再点登录按钮会再弹）。答出 <13 →
// Google + 邮箱换成用户名账号的两个入口，点进去是全屏 KidLoginPage。
import { useState } from 'react'
import { useAuth } from '../authSetup.js'
import { TOS_URL, PRIVACY_URL, PW_FONT, asset, STRINGS } from './theme.js'
import { friendlyAuthError, SocialButton, Acknowledge, DocPopup, useLegal } from './shared.jsx'
import { EmailLoginPage } from './EmailLoginPage.jsx'
import { AgePromptModal } from './AgePrompt.jsx'
import { KidEntryButtons, KidLoginPage } from './KidLoginPage.jsx'
import { useAgeBand } from './kidAccount.js'

export function WelcomePage() {
  const auth = useAuth()
  const legal = useLegal()
  const [showEmail, setShowEmail] = useState(false)
  const [kidTab, setKidTab] = useState(null) // null | 'create' | 'login' — the full-screen username page
  const [oauthError, setOauthError] = useState(auth.urlAuthError || '')
  const ageBand = useAgeBand()
  const [askAge, setAskAge] = useState(ageBand == null)

  // every login door asks the age first (the guest door never does)
  const withGuard = (fn) => () => {
    if (!legal.guard()) return
    if (ageBand == null) { setAskAge(true); return }
    fn()
  }

  // OAuth round trip in flight — cover the screen with a spinner so the app
  // underneath never flashes through while we redirect / verify. (Old test:
  // status === 'BINDING' && bind.provider !== 'email'; new: an oauth flow.)
  const pending = auth.flow?.kind === 'oauth'
  if (pending) {
    return (
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', ...PW_FONT }}>
        <img
          src={asset('login-bg.jpg')} alt=""
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
        />
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 14,
        }}>
          <div style={{
            width: 36, height: 36, border: '3px solid rgba(0,0,0,0.15)',
            borderTopColor: '#000', borderRadius: '50%', animation: 'mzSpin 0.9s linear infinite',
          }} />
          <style>{'@keyframes mzSpin { to { transform: rotate(360deg); } }'}</style>
          <p style={{ fontSize: 14, color: '#3A2E2E', opacity: 0.7, margin: 0 }}>{STRINGS.checkingAccount}</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', ...PW_FONT }}>
      <img
        src={asset('login-bg.jpg')} alt=""
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
      />

      {/* welcome + login + guest — one wrapper, positioned per design (top 70) */}
      <div style={{
        position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: 70,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}>
        <p style={{
          fontSize: 24, color: '#3A2E2E', fontWeight: 500, whiteSpace: 'nowrap', margin: 0,
        }}>
          {STRINGS.welcomeTitle}
        </p>

        {/* two 48px round icons (Google / Email), gap 26 — no Discord.
            Under 13: the username account's two doors instead. */}
        {ageBand === 'under13' ? (
          <KidEntryButtons style={{ marginTop: 15 }}
            onPick={(tab) => withGuard(() => { setOauthError(''); auth.clearError(); setKidTab(tab) })()} />
        ) : (
          <div style={{ display: 'flex', gap: 26, marginTop: 15 }}>
            <SocialButton icon={asset('icon-google.png')} label="Google"
              onClick={withGuard(() => { setOauthError(''); auth.clearError(); auth.loginWithGoogle({ surface: 'welcome' }) })} />
            <SocialButton icon={asset('icon-email.png')} label="Email"
              onClick={withGuard(() => { setOauthError(''); auth.clearError(); setShowEmail(true) })} />
          </div>
        )}

        <button
          onClick={withGuard(() => auth.chooseGuest())}
          style={{
            marginTop: 18,
            fontSize: 16, color: '#3A2E2E', textDecoration: 'underline', whiteSpace: 'nowrap',
            background: 'transparent', border: 0, cursor: 'pointer',
          }}
        >
          {STRINGS.guestMode}
        </button>

        {(oauthError || auth.error) && (
          <p style={{ marginTop: 12, textAlign: 'center', color: '#ef4444', fontSize: 12, padding: '0 16px' }}>
            {oauthError || friendlyAuthError(auth.error)}
          </p>
        )}
      </div>

      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 24,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
      }}>
        <Acknowledge checked={legal.tos} setChecked={legal.setTos} name={STRINGS.tosName} url={TOS_URL} openDoc={legal.openDoc} />
        <Acknowledge checked={legal.privacy} setChecked={legal.setPrivacy} name={STRINGS.privacyName} url={PRIVACY_URL} openDoc={legal.openDoc} />
      </div>

      {legal.toast && (
        <div style={{
          position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 110, zIndex: 20,
          maxWidth: 340, padding: '10px 16px', borderRadius: 14,
          background: 'rgba(0,0,0,0.8)', color: '#fff', fontSize: 13, textAlign: 'center', lineHeight: 1.4,
        }}>
          {legal.toast}
        </div>
      )}

      <DocPopup doc={legal.doc} loading={legal.docLoading} onClose={() => legal.setDoc(null)} />

      {askAge && ageBand == null && <AgePromptModal onClose={() => setAskAge(false)} />}

      {/* 用户名账号 / 邮箱是盖在欢迎页上的弹窗：欢迎页一直在底下，关掉就露出来 */}
      {kidTab && <KidLoginPage initialTab={kidTab} onBack={() => setKidTab(null)} />}
      {showEmail && (
        <EmailLoginPage
          surface="welcome"
          onBack={() => setShowEmail(false)}
          onDone={() => setShowEmail(false)}
        />
      )}
    </div>
  )
}
