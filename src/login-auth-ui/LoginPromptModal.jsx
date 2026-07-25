/* ----------------------------------------------------- LoginPromptModal */
// The shared 353px card modal — the 20-item closet gate AND the account-entry
// popover both open this. Moved near-verbatim from src/auth/ui.jsx (Phase 2).
// ONE door by design (蓝图 §11, 2026-07-16 用户拍板): no Sign up ↔ Sign in
// split anywhere — email or Google, an existing account signs in and a new
// address creates one, and the title says exactly that ("Log in or sign up").
// DATA movement is decided by the app's empty-account check (蓝图 §3.1);
// entering a brand-new account raises the core's account-created notice.
// Closable (top-right X / backdrop) EXCEPT while the OAuth round trip is
// being verified (pending) — a verdict must have somewhere to land. The
// rejected-error pane swaps in with a yellow confirm button.
import { useState } from 'react'
import { useAuth } from '../authSetup.js'
import { TOS_URL, PRIVACY_URL, PW_FONT, asset, STRINGS } from './theme.js'
import { friendlyAuthError, CloseX, SocialButton, Acknowledge, DocPopup, useLegal } from './shared.jsx'
import { MODAL_SCRIM, MODAL_CARD, MODAL_TITLE, CTA_SOLO } from '../general-ui/popKit.jsx'
import { EmailLoginPage } from './EmailLoginPage.jsx'

export function LoginPromptModal({ surface = 'account', onClose, onDone }) {
  const auth = useAuth()
  const legal = useLegal()
  const [showEmail, setShowEmail] = useState(false)
  const [oauthError, setOauthError] = useState('')

  // OAuth round-trip verification in flight (boot restored the flow marker).
  // Old test: status === 'BINDING' && bind.provider !== 'email'; new: an
  // oauth flow.
  const pending = auth.flow?.kind === 'oauth'
  const error = auth.error

  const handleClose = () => {
    if (pending) return // no exit while a verdict is due
    // clear a stale login error on the way out, or reopening the modal (or
    // toggling to Sign up) would land straight back on the error pane instead
    // of a fresh form — closing means "start over"
    if (error) auth.clearError()
    onClose?.()
  }

  const startOAuth = () => {
    if (!legal.guard()) return
    setOauthError('')
    auth.loginWithGoogle({ surface })
  }

  if (showEmail) {
    return (
      <div style={{ position: 'absolute', inset: 0, zIndex: 50, backgroundColor: '#fff' }}>
        <EmailLoginPage
          surface={surface}
          onBack={() => setShowEmail(false)}
          onDone={() => onDone?.()}
        />
      </div>
    )
  }

  return (
    <div
      style={{ ...MODAL_SCRIM, zIndex: 50, ...PW_FONT }}
      onClick={handleClose}
    >
      <div
        style={{
          ...MODAL_CARD,
          width: 'min(353px, calc(100vw - 24px))', minHeight: 353,
          padding: '34px 24px 28px',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {!pending && <CloseX onClick={handleClose} />}

        <p style={{ ...MODAL_TITLE, padding: '0 24px' }}>
          {STRINGS.loginTitle}
        </p>

        {/* welcome-back subtitle — reads the snapshot's hadAccount, no loose keys */}
        {!pending && !error && auth.hadAccount && (
          <p style={{
            fontSize: 13, color: '#3A2E2E', textAlign: 'center', opacity: 0.75,
            margin: '8px 0 0', lineHeight: 1.4, padding: '0 8px',
          }}>
            {STRINGS.welcomeBack}
          </p>
        )}
        {/* one door: new players get an account automatically — grouped right
            under the subtitle (07-16 用户定稿位置), not orphaned by the icons */}
        {!pending && !error && (
          <p style={{
            fontSize: 13, color: '#3A2E2E', textAlign: 'center', opacity: 0.75,
            margin: '8px 0 0', lineHeight: 1.4, padding: '0 8px',
          }}>
            {STRINGS.autoCreateNote}
          </p>
        )}

        {pending ? (
          <>
            <div style={{ flex: 1, minHeight: 24 }} />
            <div style={{
              width: 32, height: 32, border: '3px solid rgba(0,0,0,0.15)',
              borderTopColor: '#000', borderRadius: '50%', animation: 'mzSpin 0.9s linear infinite',
            }} />
            <style>{'@keyframes mzSpin { to { transform: rotate(360deg); } }'}</style>
            <p style={{ fontSize: 13, color: '#3A2E2E', textAlign: 'center', marginTop: 14, opacity: 0.7 }}>
              {STRINGS.checkingAccount}
            </p>
            <div style={{ flex: 1, minHeight: 24 }} />
          </>
        ) : error ? (
          <>
            <div style={{ flex: 1, minHeight: 24 }} />
            <p style={{
              fontSize: 15, color: '#3A2E2E', textAlign: 'center', lineHeight: 1.6,
              whiteSpace: 'pre-line', padding: '0 4px', margin: 0,
            }}>
              {friendlyAuthError(error)}
            </p>
            <div style={{ flex: 1, minHeight: 24 }} />
            <button style={CTA_SOLO} onClick={() => auth.clearError()}>
              {STRINGS.ok}
            </button>
          </>
        ) : (
          <>
            <div style={{ flex: 1, minHeight: 20 }} />

            {/* social row: Google / Email (48px, gap 26) — no Discord */}
            <div style={{ display: 'flex', gap: 26 }}>
              <SocialButton icon={asset('icon-google.png')} label="Google" onClick={startOAuth} />
              <SocialButton icon={asset('icon-email.png')} label="Email"
                onClick={() => { if (legal.guard()) setShowEmail(true) }} />
            </div>

            {oauthError && (
              <p style={{ color: '#ef4444', fontSize: 12, textAlign: 'center', padding: '0 8px', marginTop: 12 }}>
                {oauthError}
              </p>
            )}

            <div style={{ flex: 1, minHeight: 20 }} />

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <Acknowledge checked={legal.tos} setChecked={legal.setTos} name={STRINGS.tosName} url={TOS_URL} openDoc={legal.openDoc} />
              <Acknowledge checked={legal.privacy} setChecked={legal.setPrivacy} name={STRINGS.privacyName} url={PRIVACY_URL} openDoc={legal.openDoc} />
            </div>
          </>
        )}

        {legal.toast && (
          <div style={{
            position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 12, zIndex: 60,
            maxWidth: 320, padding: '10px 16px', borderRadius: 14, pointerEvents: 'none',
            background: 'rgba(0,0,0,0.8)', color: '#fff', fontSize: 12, textAlign: 'center', lineHeight: 1.4,
          }}>
            {legal.toast}
          </div>
        )}

        <DocPopup doc={legal.doc} loading={legal.docLoading} onClose={() => legal.setDoc(null)} width={300} />
      </div>
    </div>
  )
}
