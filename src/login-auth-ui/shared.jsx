// Shared pieces of the login UI three-piece set, moved verbatim from
// src/auth/ui.jsx (Phase 2, 蓝图 §5 总规则: 近乎原样搬运). Nothing in this
// file touches auth state — pure presentational helpers + the legal hook.
import { useEffect, useState } from 'react'
import { STRINGS } from './theme.js'

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

export function CloseX({ onClick, style }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Close"
      style={{
        position: 'absolute', right: 6, top: 6, width: 36, height: 36,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', border: 0, cursor: 'pointer', ...style,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2 2 L12 12 M12 2 L2 12" stroke="#333" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </button>
  )
}

// The house back button — one closet style/icon site-wide (was inline in
// EmailLoginPage). A round 30px pill over a photo bg: 1.5px stroke to match
// every other outlined control, blur backdrop, single chevron. Caller supplies
// positioning via `style` (absolute on full pages, in-flow inside a top bar).
export function BackButton({ onClick, style, className, size = 30 }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back"
      className={className}
      style={{
        width: size, height: size, borderRadius: 999, padding: 0,
        background: 'rgba(255,255,255,0.78)', backdropFilter: 'blur(6px)',
        border: '1.5px solid #3A2E2E', boxShadow: '0 2px 8px rgba(120,90,110,0.16)',
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        ...style,
      }}
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

// 服务条款/隐私协议弹窗 (fetch local HTML → render)
export function DocPopup({ doc, loading, onClose, width = 340 }) {
  if (!doc) return null
  return (
    <div
      style={{
        position: 'absolute', inset: 0, zIndex: 70, display: 'flex',
        alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          position: 'relative', width, maxHeight: 'calc(100% - 40px)',
          background: '#fff', borderRadius: 16, boxShadow: '0 25px 50px rgba(0,0,0,0.25)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '10px 44px', borderBottom: '1px solid rgba(0,0,0,0.1)',
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#3A2E2E', textAlign: 'center' }}>{doc.title}</span>
          <button
            type="button"
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }}
            onClick={(e) => { e.stopPropagation(); onClose() }}
            aria-label="Close"
            style={{
              position: 'absolute', right: 0, top: 0, bottom: 0, width: 44,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: 0, cursor: 'pointer', touchAction: 'manipulation',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2 L12 12 M12 2 L2 12" stroke="#333" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', fontSize: 13, color: '#3A2E2E', lineHeight: 1.6 }}>
          {loading && !doc.html
            ? <p style={{ color: 'rgba(58,46,46,0.5)' }}>…</p>
            : <div dangerouslySetInnerHTML={{ __html: doc.html }} />}
        </div>
      </div>
    </div>
  )
}

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
