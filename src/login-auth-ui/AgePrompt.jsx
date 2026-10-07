/* ------------------------------------------------------------- AgePrompt */
// 登录前的年龄弹窗（docs/kids-account-plan.md）：直接问年龄，一个中立下拉
// （1–99），不预选、不暗示答案。答完写设备级答案（kidAccount.answerAge，答过就锁定），
// 年龄本身用完即弃。
//  - AgePromptBody：只有内容，LoginPromptModal 直接塞进自己的卡片里；
//  - AgePromptModal：自带遮罩 + 卡片 + 右上 X，WelcomePage 盖在页面上用。
// 表单类弹窗房规：右上 X + 一个居中 CTA，不放 Cancel。
import { useState } from 'react'
import { STRINGS, PW_FONT } from './theme.js'
import { answerAge } from './kidAccount.js'
import {
  MODAL_SCRIM, MODAL_CARD, MODAL_TITLE, MODAL_DESC, CTA_SOLO, CTA_OFF, PopClose,
} from '../general-ui/popKit.jsx'

const INK = '#3A2E2E'

function Dropdown({ value, onChange, placeholder, options, label }) {
  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%', height: 46, borderRadius: 23, border: `1.5px solid ${INK}`,
          background: '#fff', padding: '0 34px', boxSizing: 'border-box', textAlign: 'center', textAlignLast: 'center',
          font: 'inherit', fontSize: 15, color: value === '' ? 'rgba(58,46,46,0.5)' : INK,
          appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
          outline: 'none', cursor: 'pointer',
        }}
      >
        <option value="" disabled>{placeholder}</option>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={INK} strokeWidth="2.6"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ position: 'absolute', right: 14, top: 16, pointerEvents: 'none' }}>
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
  )
}

export function AgePromptBody({ onAnswered }) {
  const [age, setAge] = useState('')
  const ages = Array.from({ length: 99 }, (_, i) => i + 1)
  const ready = age !== ''

  const submit = () => {
    if (!ready) return
    // 先存再回调 —— 别写成 onAnswered?.(answerAge(...))：可选调用短路时连参数都不求值
    const band = answerAge(Number(age))
    onAnswered?.(band)
  }

  return (
    <>
      {/* 标题 + 副标题 + 下拉框作为一整块，在卡片顶部和按钮之间上下居中 */}
      <div style={{
        flex: 1, width: '100%', paddingBottom: 24,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}>
        <p style={{ ...MODAL_TITLE, padding: '0 24px' }}>{STRINGS.ageTitle}</p>
        <p style={{ ...MODAL_DESC, opacity: 0.6, margin: '6px 0 0' }}>{STRINGS.ageNote}</p>
        <div style={{ display: 'flex', justifyContent: 'center', width: '100%', marginTop: 20 }}>
          <div style={{ width: 160, display: 'flex' }}>
            <Dropdown label={STRINGS.agePlaceholder} value={age} onChange={setAge}
              placeholder={STRINGS.agePlaceholder} options={ages.map((a) => [a, a])} />
          </div>
        </div>
      </div>
      <button
        type="button"
        disabled={!ready}
        onClick={submit}
        style={ready ? CTA_SOLO : { ...CTA_SOLO, ...CTA_OFF, cursor: 'default' }}
      >
        {STRINGS.ageContinue}
      </button>
    </>
  )
}

export function AgePromptModal({ onAnswered, onClose, style }) {
  return (
    <div style={{ ...MODAL_SCRIM, zIndex: 30, ...PW_FONT, ...style }} onClick={onClose}>
      <div
        style={{
          ...MODAL_CARD,
          width: 'min(353px, calc(100vw - 24px))', minHeight: 290,
          padding: '34px 24px 28px', boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <PopClose onClick={onClose} />
        <AgePromptBody onAnswered={onAnswered} />
      </div>
    </div>
  )
}
