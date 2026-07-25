// 服务条款/隐私协议弹窗 (fetch local HTML → render) — 从 login-auth-ui/shared.jsx
// 原样抽出的共享件（2026-07-25 用户拍板）。
// ⚠️ 这个弹窗的样式是定稿设计，**不套 popKit 房规**：黑遮罩、圆角 16 无描边卡、
// 顶栏标题+分割线、右侧透明整条 X 热区。移植/统一房规时不许动它（见
// general-ui-porting-no-blanket-rules）。自包含零依赖，两仓逐字节拷。
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
