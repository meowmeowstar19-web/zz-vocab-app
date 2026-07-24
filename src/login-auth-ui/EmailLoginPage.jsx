/* ------------------------------------------------------- EmailLoginPage */
// Two-step email OTP form, moved near-verbatim from src/auth/ui.jsx (Phase 2).
// ONE door by design (蓝图 §11): a registered address signs in, a new one
// gets an account — startEmail/verifyEmail carry no intent, and the copy
// below says so ("New here? We'll create your account automatically.").
// Full-screen; used standalone from WelcomePage and as an overlay inside
// LoginPromptModal.
import { useState } from 'react'
import { useAuth } from '../authSetup.js'
import { YELLOW, PW_FONT, asset, STRINGS } from './theme.js'
import { friendlyAuthError } from './shared.jsx'

export function EmailLoginPage({ onBack, onDone, surface = 'welcome', initialStep = 'email' }) {
  const auth = useAuth()
  const [step, setStep] = useState(initialStep) // 'email' | 'verify'
  // the email ENTRY step always starts blank — never prefill a previously-typed
  // email (用户要求每次进来都是空的). But a mount straight onto the VERIFY step
  // (page killed mid-OTP, pane restored from the snapshot) must recover the
  // in-flight address from the core's flow — verify/resend send it to supabase,
  // so a blank here would make the restored pane reject even a correct code.
  const [email, setEmail] = useState(
    initialStep === 'verify' ? auth.flow?.email || '' : '',
  )
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [loading, setLoading] = useState(false)

  const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)

  const handleSend = async () => {
    setError(''); setInfo('')
    const v = email.trim()
    if (!validEmail(v)) { setError(STRINGS.emailInvalid); return }
    setLoading(true)
    try {
      await auth.startEmail(v, { surface })
      setStep('verify')
      setCode('')
    } catch (err) {
      setError(err?.message || STRINGS.sendFailed)
    } finally {
      setLoading(false)
    }
  }

  const handleVerify = async () => {
    setError(''); setInfo('')
    const trimmed = code.replace(/\s+/g, '')
    if (!/^\d{6}$/.test(trimmed)) { setError(STRINGS.codeInvalidFormat); return }
    setLoading(true)
    try {
      await auth.verifyEmail(trimmed)
      onDone?.()
    } catch (err) {
      setError(/expired|invalid|incorrect/i.test(err?.message || '')
        ? STRINGS.codeExpired
        : (err?.message || STRINGS.genericError))
    } finally {
      setLoading(false)
    }
  }

  const handleResend = async () => {
    setError(''); setInfo('')
    setLoading(true)
    try {
      await auth.resendEmail()
      setInfo(STRINGS.codeSent)
    } catch (err) {
      setError(err?.message || STRINGS.resendFailed)
    } finally {
      setLoading(false)
    }
  }

  const handleBack = () => {
    auth.exitFlow() // ONE exit for back/close — falls back to wherever the flow launched from
    onBack?.()
  }

  const inputBase = {
    width: 'min(329px, 100%)', height: 50, borderRadius: 25,
    border: '1.5px solid #000', background: '#fff', padding: '0 20px',
    outline: 'none', transition: 'border-color 0.15s', boxSizing: 'border-box',
  }

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', ...PW_FONT }}>
      <img
        src={asset('login-bg.jpg')} alt=""
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
      />

      {/* back button — closet style/icon kept consistent site-wide, original position */}
      <button
        onClick={handleBack}
        style={{
          position: 'absolute', top: 40, left: 20, zIndex: 10, width: 30, height: 30,
          borderRadius: 999, background: 'rgba(255,255,255,0.78)', backdropFilter: 'blur(6px)',
          border: '1.5px solid #3A2E2E', boxShadow: '0 2px 8px rgba(120,90,110,0.16)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3A2E2E" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.5 5 8 12l6.5 7" />
        </svg>
      </button>

      <form
        onSubmit={(e) => { e.preventDefault(); step === 'verify' ? handleVerify() : handleSend() }}
        style={{ position: 'absolute', left: 0, right: 0, top: 111, padding: '0 29px' }}
      >
        {step === 'verify' ? (
          <>
            <p style={{ fontSize: 20, color: '#3A2E2E', fontWeight: 500, margin: '0 0 8px' }}>{STRINGS.verifyTitle}</p>
            <p style={{ fontSize: 14, color: 'rgba(58,46,46,0.7)', margin: '0 0 8px', lineHeight: 1.4 }}>
              {STRINGS.codeSentTo(email)}
            </p>
            <p style={{ fontSize: 12, color: 'rgba(58,46,46,0.5)', margin: '0 0 20px', lineHeight: 1.4 }}>
              {STRINGS.checkSpam}
            </p>
            <label style={{ display: 'block', fontSize: 16, color: '#3A2E2E', marginBottom: 4 }}>{STRINGS.codeLabel}</label>
            <input
              type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onFocus={(e) => { e.target.style.borderColor = YELLOW }}
              onBlur={(e) => { e.target.style.borderColor = '#000' }}
              style={{ ...inputBase, fontSize: 22, letterSpacing: '0.3em', textAlign: 'center' }}
              placeholder={STRINGS.codePlaceholder}
              autoFocus
            />
          </>
        ) : (
          <>
            <label style={{ display: 'block', fontSize: 16, color: '#3A2E2E', marginBottom: 4 }}>{STRINGS.emailLabel}</label>
            <input
              type="email" value={email}
              onChange={(e) => setEmail(e.target.value)}
              onFocus={(e) => { e.target.style.borderColor = YELLOW }}
              onBlur={(e) => { e.target.style.borderColor = '#000' }}
              style={{ ...inputBase, fontSize: 15 }}
              placeholder={STRINGS.emailPlaceholder}
              autoFocus
            />
            <p style={{ fontSize: 12, color: 'rgba(58,46,46,0.55)', margin: '8px 0 0', lineHeight: 1.4 }}>
              {STRINGS.emailHint}
            </p>
          </>
        )}

        {error && (
          <p style={{ color: '#ef4444', fontSize: 13, marginTop: 12, textAlign: 'center', lineHeight: 1.3, whiteSpace: 'pre-line' }}>{friendlyAuthError(error)}</p>
        )}
        {info && (
          <p style={{ color: '#15803d', fontSize: 13, marginTop: 12, textAlign: 'center' }}>{info}</p>
        )}

        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 30 }}>
          <button
            type="submit" disabled={loading}
            style={{
              width: 148, height: 48, borderRadius: 999, background: YELLOW,
              border: '1.5px solid #3A2E2E', fontSize: 18, color: '#3A2E2E', cursor: 'pointer',
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? '...' : step === 'verify' ? STRINGS.verify : STRINGS.sendCode}
          </button>
        </div>

        {step === 'verify' && (
          <div style={{ textAlign: 'center', marginTop: 20, fontSize: 14 }}>
            <p style={{ margin: '0 0 8px' }}>
              <button type="button" onClick={handleResend} disabled={loading}
                style={{ color: '#3A2E2E', textDecoration: 'underline', background: 'transparent', border: 0, cursor: 'pointer', fontSize: 14, opacity: loading ? 0.5 : 1 }}>
                {STRINGS.resend}
              </button>
            </p>
            <p style={{ margin: 0 }}>
              <button type="button" onClick={() => { setStep('email'); setCode(''); setError(''); setInfo('') }}
                style={{ color: '#3A2E2E', textDecoration: 'underline', background: 'transparent', border: 0, cursor: 'pointer', fontSize: 14 }}>
                {STRINGS.useDifferentEmail}
              </button>
            </p>
          </div>
        )}
      </form>
    </div>
  )
}
