/* ---------------------------------------------------------- WelcomePage */
// Full-screen page shown ONLY on the welcome/logged-out gate (new core:
// status === 'guest' && atWelcome — the old LOGGED_OUT). Moved near-verbatim
// from src/auth/ui.jsx (Phase 2). PW design minus welcome-text.png (the one
// deliberate difference).
import { useState } from 'react'
import { useAuth } from '../authSetup.js'
import { TOS_URL, PRIVACY_URL, PW_FONT, asset, STRINGS } from './theme.js'
import { friendlyAuthError, SocialButton, Acknowledge, DocPopup, useLegal } from './shared.jsx'
import { EmailLoginPage } from './EmailLoginPage.jsx'

export function WelcomePage() {
  const auth = useAuth()
  const legal = useLegal()
  const [showEmail, setShowEmail] = useState(false)
  const [oauthError, setOauthError] = useState(auth.urlAuthError || '')

  const withGuard = (fn) => () => { if (legal.guard()) fn() }

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

  if (showEmail) {
    return (
      <EmailLoginPage
        surface="welcome"
        onBack={() => setShowEmail(false)}
        onDone={() => setShowEmail(false)}
      />
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

        {/* two 48px round icons (Google / Email), gap 26 — no Discord */}
        <div style={{ display: 'flex', gap: 26, marginTop: 15 }}>
          <SocialButton icon={asset('icon-google.png')} label="Google"
            onClick={withGuard(() => { setOauthError(''); auth.clearError(); auth.loginWithGoogle({ surface: 'welcome' }) })} />
          <SocialButton icon={asset('icon-email.png')} label="Email"
            onClick={withGuard(() => { setOauthError(''); auth.clearError(); setShowEmail(true) })} />
        </div>

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
    </div>
  )
}
