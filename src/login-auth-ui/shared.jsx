// Shared pieces of the login UI three-piece set, moved verbatim from
// src/auth/ui.jsx (Phase 2, 蓝图 §5 总规则: 近乎原样搬运). Nothing in this
// file touches auth state — pure presentational helpers + the legal hook.
import { useEffect, useState } from 'react'
import { STRINGS } from './theme.js'
import { PopClose, BACK_BTN } from '../general-ui/popKit.jsx'

// GoTrue's raw errors are terse and offer no next step. For the "this social
// login / email already belongs to someone else" family, keep the wording but
// add a clear thing to do next. Everything else passes through untouched.
export function friendlyAuthError(msg) {
  if (!msg) return msg
  if (/already linked to another user|identity_already_exists|already registered|already been registered|already exists/i.test(msg)) {
    const base = msg.replace(/[.\s]+$/, '')
    return `${base}. ${STRINGS.tryDifferentAccount}`
  }
  return msg
}

/* ---------------------------------------------------------- tiny shared UI */

// Pop 右上角 X — 组装自 general-ui popKit 的 PopClose（描边圆钮唯一真源）。
// 保留 CloseX 这个名字只为老调用点兼容；新代码直接用 PopClose。
export function CloseX({ onClick, style }) {
  return <PopClose onClick={onClick} style={style} />
}

// The house back button — 视觉唯一真源是 popKit 的 BACK_BTN token；这里只包一层
// 以支持 className / size（popKit 的 BackButton 组件不收这两个参数）。Caller
// supplies positioning via `style` (absolute on full pages, in-flow in a bar).
export function BackButton({ onClick, style, className, size = 30 }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back"
      className={className}
      style={{ ...BACK_BTN, width: size, height: size, borderRadius: 999, padding: 0, ...style }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3A2E2E" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.5 5 8 12l6.5 7" />
      </svg>
    </button>
  )
}

export function SocialButton({ icon, label, onClick }) {
  const [hover, setHover] = useState(false)
  const [active, setActive] = useState(false)
  return (
    <button
      onClick={onClick}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false) }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      onTouchStart={() => setActive(true)}
      onTouchEnd={() => setActive(false)}
      style={{
        width: 48, height: 48, borderRadius: 999, overflow: 'hidden',
        border: 0, padding: 0, cursor: 'pointer', background: '#fff',
        boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transform: active ? 'scale(0.95)' : hover ? 'scale(1.05)' : 'scale(1)',
        transition: 'transform 0.15s',
      }}
    >
      <img src={icon} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    </button>
  )
}

// 法律勾选行 — 文案保持中文（用户定稿，与 PW 截图一致）
export function Acknowledge({ checked, setChecked, name, url, openDoc }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', fontSize: 11.5, color: '#3A2E2E',
      lineHeight: 1.2, whiteSpace: 'nowrap',
    }}>
      <button
        type="button"
        onClick={() => setChecked(!checked)}
        role="checkbox"
        aria-checked={checked}
        style={{
          width: 16, height: 16, borderRadius: 999, marginRight: 8, padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
          cursor: 'pointer', transition: 'background-color 0.15s',
          backgroundColor: checked ? '#22c55e' : '#d1d5db',
          border: checked ? '1.5px solid #15803d' : '1.5px solid #9ca3af',
        }}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <polyline points="2.5,6.5 5,9 9.5,3.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      <span>
        {STRINGS.legalPrefix}
        <button
          type="button"
          onClick={() => openDoc(name, url)}
          style={{
            textDecoration: 'underline', color: '#3A2E2E', background: 'transparent',
            padding: 0, margin: 0, border: 0, cursor: 'pointer',
            font: 'inherit',
          }}
        >
          {name}
        </button>
      </span>
    </div>
  )
}

// 服务条款/隐私协议弹窗 — 定稿设计原样住在 general-ui/DocPopup.jsx（07-25 拍板
// 抽出共享），这里只 re-export 维持老 import 面不变。它不套 popKit 房规。
export { DocPopup } from '../general-ui/DocPopup.jsx'

// shared hook: legal checkboxes + doc popup + toast
export function useLegal() {
  const [tos, setTos] = useState(true)
  const [privacy, setPrivacy] = useState(true)
  const [toast, setToast] = useState('')
  const [doc, setDoc] = useState(null)
  const [docLoading, setDocLoading] = useState(false)

  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(''), 2400)
    return () => clearTimeout(id)
  }, [toast])

  const guard = () => {
    if (!tos || !privacy) {
      setToast(STRINGS.legalToast)
      return false
    }
    return true
  }

  const openDoc = async (title, url) => {
    setDoc({ title, html: '' })
    setDocLoading(true)
    try {
      const res = await fetch(url)
      const html = await res.text()
      setDoc((prev) => (prev && prev.title === title ? { title, html } : prev))
    } catch {
      setDoc((prev) => (prev && prev.title === title
        ? { title, html: `<p style="color:#b91c1c;">${STRINGS.docLoadFailed}</p>` }
        : prev))
    } finally {
      setDocLoading(false)
    }
  }

  return { tos, setTos, privacy, setPrivacy, toast, setToast, guard, doc, setDoc, docLoading, openDoc }
}
