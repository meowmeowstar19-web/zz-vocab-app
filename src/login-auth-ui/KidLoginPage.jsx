/* --------------------------------------------------------- KidLoginPage */
// 13岁以下的用户名账号（docs/kids-account-plan.md）。年龄弹窗答出 <13 后，
// LoginPromptModal / WelcomePage 把 Google + 邮箱换成 KidEntryButtons，点进来
// 是一张弹窗卡片（盖在当前页面上，不用整页背景图；卡片太高时遮罩可滚动）：
//   「创建账号 / 登录」两个页签 + 登录页签底下「请家长帮忙」（第三屏，表单）。
// 登录成功后 core 自己收 SIGNED_IN → enterAccount → status 'account'，宿主照常
// 关掉弹窗 / 欢迎页，这一页随之卸载 —— 所以成功后按钮一直保持转圈，不回弹。
import { useEffect, useRef, useState } from 'react'
import { YELLOW, PW_FONT, STRINGS } from './theme.js'
import { MODAL_SCRIM, MODAL_CARD, PopClose } from '../general-ui/popKit.jsx'
import { usernameProblem, passwordProblem } from './kidRules.js'
import { kidSignIn, kidSignUp, sendParentHelp } from './kidAccount.js'

const INK = '#3A2E2E'
const SUCCESS_GRACE_MS = 15_000 // 登录成功但宿主迟迟没卸载这一页 → 让按钮能再点

// 两个入口按钮：登录弹窗卡片里、欢迎页的按钮排里都用它（替换 Google / 邮箱）。
// 自己是一列、按钮是直接子元素（ZZ 欢迎页的换皮 CSS 认 `p + div > button` 这个
// 结构，别再包一层）；aria-label = 文案，data-kid 给宿主的换皮 CSS 认。
export function KidEntryButtons({ onPick, style }) {
  const pill = {
    width: 236, maxWidth: '100%', height: 46, borderRadius: 999, boxSizing: 'border-box',
    border: `1.5px solid ${INK}`, color: INK, fontFamily: 'inherit', fontSize: 16, fontWeight: 600,
    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0,
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, ...style }}>
      <button type="button" data-kid="create" aria-label={STRINGS.kidCreate}
        style={{ ...pill, background: YELLOW }} onClick={() => onPick('create')}>
        {STRINGS.kidCreate}
      </button>
      <button type="button" data-kid="login" aria-label={STRINGS.kidLogin}
        style={{ ...pill, background: '#fff' }} onClick={() => onPick('login')}>
        {STRINGS.kidLogin}
      </button>
    </div>
  )
}

const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)
const errorText = (code) => STRINGS.kidErrors[code] || STRINGS.kidErrors.failed

export function KidLoginPage({ initialTab = 'create', onBack }) {
  const [tab, setTab] = useState(initialTab) // 'create' | 'login' | 'help'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [parentEmail, setParentEmail] = useState('')
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const graceTimer = useRef(null)
  useEffect(() => () => clearTimeout(graceTimer.current), [])

  const switchTab = (next) => {
    if (loading) return
    setTab(next)
    setError('')
    setPassword('')
    setPassword2('')
    setSent(false)
  }

  const run = async (fn, { keepLoading = false } = {}) => {
    setError('')
    setLoading(true)
    try {
      await fn()
      if (keepLoading) {
        graceTimer.current = setTimeout(() => setLoading(false), SUCCESS_GRACE_MS)
        return
      }
    } catch (err) {
      setError(errorText(err?.code))
    }
    setLoading(false)
  }

  const handleSubmit = () => {
    if (loading) return
    const uBad = usernameProblem(username)
    if (tab === 'help') {
      if (uBad) return setError(errorText(uBad))
      if (!validEmail(parentEmail.trim())) return setError(errorText('parent_email'))
      return run(async () => {
        await sendParentHelp({ username, parentEmail, message })
        setSent(true)
      })
    }
    if (uBad) return setError(errorText(uBad))
    const pBad = passwordProblem(password)
    if (pBad) return setError(errorText(pBad))
    if (tab === 'create') {
      if (password !== password2) return setError(errorText('password_mismatch'))
      return run(() => kidSignUp(username, password), { keepLoading: true })
    }
    return run(() => kidSignIn(username, password), { keepLoading: true })
  }

  const handleBack = () => {
    if (tab === 'help') return switchTab('login')
    onBack?.()
  }

  const inputBase = {
    width: '100%', height: 50, borderRadius: 25,
    border: '1.5px solid #000', background: '#fff', padding: '0 20px', fontSize: 15,
    outline: 'none', transition: 'border-color 0.15s', boxSizing: 'border-box', fontFamily: 'inherit',
  }
  const focus = {
    onFocus: (e) => { e.target.style.borderColor = YELLOW },
    onBlur: (e) => { e.target.style.borderColor = '#000' },
  }
  const label = { display: 'block', fontSize: 16, color: INK, margin: '14px 0 4px' }
  const hint = { fontSize: 12.5, color: 'rgba(58,46,46,0.8)', margin: '6px 4px 0', lineHeight: 1.4 }
  const linkBtn = {
    color: INK, textDecoration: 'underline', background: 'transparent', border: 0,
    cursor: 'pointer', fontSize: 14, fontFamily: 'inherit', padding: 0,
  }
  const usernameInput = (
    <input
      type="text" value={username} maxLength={32}
      autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
      onChange={(e) => setUsername(e.target.value)} {...focus}
      style={inputBase} placeholder={tab === 'create' ? STRINGS.usernamePlaceholder : undefined}
    />
  )

  return (
    <div style={{ ...MODAL_SCRIM, zIndex: 50, overflowY: 'auto', WebkitOverflowScrolling: 'touch', ...PW_FONT }}
      onClick={handleBack}>
      {/* 卡片比屏幕高时（键盘弹起）遮罩整体滚动：margin auto 居中、放不下就从顶上排 */}
      <form
        onSubmit={(e) => { e.preventDefault(); handleSubmit() }} noValidate
        onClick={(e) => e.stopPropagation()}
        style={{
          ...MODAL_CARD, width: 'min(353px, calc(100vw - 24px))', margin: 'auto',
          padding: '52px 20px 24px', boxSizing: 'border-box',
        }}
      >
        <PopClose onClick={handleBack} />
          {tab === 'help' ? (
            <>
              <p style={{ fontSize: 20, color: INK, fontWeight: 500, margin: '0 0 8px' }}>{STRINGS.parentHelpTitle}</p>
              <p style={{ fontSize: 14, color: 'rgba(58,46,46,0.7)', margin: 0, lineHeight: 1.4 }}>
                {STRINGS.parentHelpDesc}
              </p>
            </>
          ) : (
            <div role="tablist" style={{
              display: 'flex', width: '100%', boxSizing: 'border-box',
              borderRadius: 14, background: 'rgba(58,46,46,0.07)', padding: 4, gap: 4,
            }}>
              {[['create', STRINGS.kidCreate], ['login', STRINGS.kidLogin]].map(([id, text]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id}
                  onClick={() => switchTab(id)}
                  style={{
                    flex: 1, minWidth: 0, height: 32, borderRadius: 10, border: 0, cursor: 'pointer',
                    background: tab === id ? '#fff' : 'transparent',
                    boxShadow: tab === id ? '0 1px 4px rgba(120,90,150,0.18)' : 'none',
                    color: tab === id ? INK : '#85757c',
                    fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
                  }}>
                  {text}
                </button>
              ))}
            </div>
          )}

          {tab === 'help' && sent ? (
            <div style={{ textAlign: 'center', marginTop: 36 }}>
              <p style={{ color: '#15803d', fontSize: 15, margin: '0 0 20px', lineHeight: 1.4 }}>{STRINGS.parentHelpSent}</p>
              <button type="button" style={linkBtn} onClick={() => switchTab('login')}>{STRINGS.backToLogin}</button>
            </div>
          ) : (
            <>
              <label style={label}>{STRINGS.usernameLabel}</label>
              {usernameInput}
              {tab === 'create' && <p style={hint}>{STRINGS.usernameHint}</p>}

              {tab === 'help' ? (
                <>
                  <label style={label}>{STRINGS.parentEmailLabel}</label>
                  <input
                    type="email" value={parentEmail} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                    onChange={(e) => setParentEmail(e.target.value)} {...focus}
                    style={inputBase} placeholder={STRINGS.parentEmailPlaceholder}
                  />
                  <label style={label}>{STRINGS.messageLabel}</label>
                  <textarea
                    value={message} maxLength={1000} rows={3}
                    onChange={(e) => setMessage(e.target.value)} {...focus}
                    style={{ ...inputBase, height: 96, borderRadius: 20, padding: '12px 20px', resize: 'none', lineHeight: 1.4 }}
                  />
                </>
              ) : (
                <>
                  <label style={label}>{STRINGS.passwordLabel}</label>
                  <input
                    type="password" value={password}
                    autoComplete={tab === 'create' ? 'new-password' : 'current-password'}
                    onChange={(e) => setPassword(e.target.value)} {...focus}
                    style={inputBase} placeholder={tab === 'create' ? STRINGS.passwordPlaceholder : undefined}
                  />
                  {tab === 'create' && (
                    <>
                      <label style={label}>{STRINGS.password2Label}</label>
                      <input
                        type="password" value={password2} autoComplete="new-password"
                        onChange={(e) => setPassword2(e.target.value)} {...focus}
                        style={inputBase}
                      />
                    </>
                  )}
                </>
              )}

              {error && (
                <p role="alert" style={{ color: '#ef4444', fontSize: 13, marginTop: 12, textAlign: 'center', lineHeight: 1.3 }}>
                  {error}
                </p>
              )}

              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 26 }}>
                <button
                  type="submit" disabled={loading}
                  style={{
                    minWidth: 148, height: 48, padding: '0 22px', borderRadius: 999, background: YELLOW,
                    border: `1.5px solid ${INK}`, fontSize: 18, color: INK, cursor: 'pointer',
                    fontFamily: 'inherit', opacity: loading ? 0.5 : 1,
                  }}
                >
                  {loading ? '...' : tab === 'create' ? STRINGS.kidCreate : tab === 'login' ? STRINGS.kidLogin : STRINGS.send}
                </button>
              </div>

              {tab === 'login' && (
                <p style={{ textAlign: 'center', margin: '20px 0 0' }}>
                  <button type="button" style={linkBtn} onClick={() => switchTab('help')}>{STRINGS.forgotPassword}</button>
                </p>
              )}
            </>
          )}
      </form>
    </div>
  )
}
