// 服务条款/隐私协议弹窗 (fetch local HTML → render) — general-ui 共享件。
// 式样（2026-07-25 用户拍板 v2，取代同日"保留旧样"的 v1）：popKit 框（紫 scrim +
// 白卡描边圆角 24 + 右上 PopClose + MODAL_TITLE）+ **永远长框**——卡高撑满
// 手机屏（scrim 的 24px padding 即四周边距），无论从整页 login 还是
// LoginPromptModal 里点开都一样高，不许出现内容多短框就短的小框。
// ⚠️ 挂载契约：必须挂在整屏容器层级（它的 inset:0 要覆盖整个手机屏）；
// 别塞进小卡片 div 里，否则会被卡片困成小框（就是当初的 bug）。
// scrim 点击自带 stopPropagation——挂在别的 pop 的 scrim 里也不会把宿主 pop 关掉。
import { MODAL_SCRIM, MODAL_CARD, MODAL_TITLE, PopClose } from './popKit.jsx'

export function DocPopup({ doc, loading, onClose, width = 340 }) {
  if (!doc) return null
  return (
    <div
      style={{ ...MODAL_SCRIM, zIndex: 70 }}
      onClick={(e) => { e.stopPropagation(); onClose() }}
    >
      <div
        style={{
          ...MODAL_CARD, width, height: '100%',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <PopClose onClick={onClose} />
        <p style={{ ...MODAL_TITLE, flex: '0 0 auto', padding: '20px 48px 10px' }}>{doc.title}</p>
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 16px', fontSize: 13, color: '#3A2E2E', lineHeight: 1.6 }}>
          {loading && !doc.html
            ? <p style={{ color: 'rgba(58,46,46,0.5)' }}>…</p>
            : <div dangerouslySetInnerHTML={{ __html: doc.html }} />}
        </div>
      </div>
    </div>
  )
}
