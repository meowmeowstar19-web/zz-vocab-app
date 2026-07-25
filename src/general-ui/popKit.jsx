// general-ui pop kit — THE single source of truth for popup + button styling.
// Every pop in the host app (and this module's own pops) composes from these
// tokens; an app never redeclares a card border, a Cancel colour or a title
// size locally. Copied byte-for-byte between apps like the rest of general-ui —
// the theme values (YELLOW, BTN_FONT_SIZE) come from config.js.
//
// THE X / CANCEL RULE (用户拍板 07-23): every pop has exactly ONE exit control.
//   · decision pops (buy / spend / log out / destructive confirm)
//       → paired footer buttons PAIR_GHOST (Cancel) + PAIR_PRIMARY, NO top-right X
//   · form / content pops (feedback, avatar, rename, guides, packs, reveals)
//       → top-right <PopClose /> + at most one centred CTA_SOLO, NO Cancel
import { YELLOW, BTN_FONT_SIZE } from './config.js'
import { Icon } from './icons.jsx'

/* ------------------------------------------------------------------ fonts */
export const FONT_STACK = '"Baloo 2", "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif'

/* --------------------------------------------------------- injected CSS
 * The kit carries its own keyframes + scrollbar-hiding class so a host app
 * needs NO css of its own for these (portable: works the moment the module
 * is copied in). Injected once per document, guarded by the style id. */
export const SCROLL_HIDE = 'guiScrollHide'
const KIT_CSS = `
.${SCROLL_HIDE}{scrollbar-width:none}
.${SCROLL_HIDE}::-webkit-scrollbar{display:none}
@keyframes guiFade{from{opacity:0}to{opacity:1}}
@keyframes guiPop{0%{opacity:0;transform:scale(.82)}100%{opacity:1;transform:scale(1)}}
`
if (typeof document !== 'undefined' && !document.getElementById('gui-pop-kit')) {
  const el = document.createElement('style')
  el.id = 'gui-pop-kit'
  el.textContent = KIT_CSS
  document.head.appendChild(el)
}

/* ---------------------------------------------------------------- buttons
 * PlushieWord button system: bright-yellow pill + dark outline. One shared
 * height; width snaps to a small scale by role (never one-off widths). */
export const BTN = {
  height: 42, boxSizing: 'border-box', borderRadius: 999,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  fontSize: BTN_FONT_SIZE, fontWeight: 600, letterSpacing: 0.3, whiteSpace: 'nowrap',
  fontFamily: 'inherit',
}
export const BTN_S = { ...BTN, width: 104 } // inline / on-art pills (banner status, gift Claim)
export const BTN_M = { ...BTN, width: 132 } // standalone modal CTAs (Claim, Collect, Save…)
export const BTN_ROW = { ...BTN, flex: 1, minWidth: 0 } // paired footer CTAs: side by side, equal width

// colourways — every button has a stroke; the stroke is the fill one shade deeper
export const CTA = { background: YELLOW, border: '1.5px solid #3A2E2E', color: '#3A2E2E', cursor: 'pointer', fontWeight: 600 }
export const CTA_OFF = { background: '#ece4e9', color: '#3A2E2E', border: '1.5px solid #cdbcc6', boxShadow: 'none' }
export const GHOST = { background: '#efe3ea', border: '1.5px solid #cbb0bf', color: '#3A2E2E', cursor: 'pointer' }

// ready-made compositions (what pops actually use)
export const CTA_STANDALONE = { ...BTN_M, alignSelf: 'center', maxWidth: '100%' }
export const CTA_SOLO = { ...CTA, ...CTA_STANDALONE } // the ONE centred CTA of a form/content pop
export const PAIR_PRIMARY = { ...CTA, ...BTN_ROW }
export const PAIR_PRIMARY_OFF = { ...CTA_OFF, ...BTN_ROW, cursor: 'default' }
export const PAIR_GHOST = { ...GHOST, ...BTN_ROW } // Cancel — the decision pop's exit control

// round translucent-white button with the dark outline (back buttons + pop X)
export const BACK_BTN = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
  border: '1.5px solid #3A2E2E', background: 'rgba(255,255,255,0.78)', backdropFilter: 'blur(6px)',
  boxShadow: '0 2px 8px rgba(120,90,110,0.16)',
}

/* ----------------------------------------------------------------- modals
 * ONE modal frame for every popup so they read identically: mauve blurred
 * scrim, clean white card, soft border, same pop animation. Per-pop styles
 * only add width / padding / layout (and the host adds its zIndex). */
export const MODAL_SCRIM = {
  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(80,50,70,0.34)', backdropFilter: 'blur(2px)', padding: 24,
  animation: 'guiFade .18s ease',
}
export const MODAL_CARD = {
  position: 'relative', borderRadius: 24, background: '#fff',
  border: '1.5px solid #3A2E2E',
  boxShadow: '0 18px 48px rgba(150,90,120,0.34)',
  animation: 'guiPop .26s cubic-bezier(.34,1.56,.64,1)',
}
export const MODAL_CLOSE = {
  ...BACK_BTN, position: 'absolute', top: 12, right: 12,
  width: 30, height: 30, borderRadius: 999, zIndex: 2,
}
// pop header text (16/700) — sites add their own margin/padding for layout
export const MODAL_TITLE = {
  fontSize: 16, fontWeight: 700, letterSpacing: 0.3, color: '#3A2E2E',
  textAlign: 'center', lineHeight: 1.3, margin: 0,
}
// pop body copy (confirm questions, hints)
export const MODAL_DESC = { fontSize: 12.5, fontWeight: 400, color: '#3A2E2E', textAlign: 'center', lineHeight: 1.45 }
// footer: 1 button → centred; 2 buttons → side by side (each fills half), NEVER stacked
export const MODAL_FOOTER = { flex: '0 0 auto', alignSelf: 'stretch', display: 'flex', gap: 10, justifyContent: 'center' }

/* ------------------------------------------------------------- components */
// The pop's top-right X — the round outlined button with the X glyph.
export function PopClose({ onClick, style, label = 'Close' }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      style={{ ...MODAL_CLOSE, ...style }}>
      <Icon name="close" size={16} color="#3A2E2E" stroke={2.4} />
    </button>
  )
}

// The round back button (chevron) — pages position it via `style` (top/left/z).
export function BackButton({ onClick, style, label = 'Back' }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      style={{ ...BACK_BTN, width: 30, height: 30, borderRadius: 999, ...style }}>
      <Icon name="back" size={18} color="#3A2E2E" stroke={2.6} />
    </button>
  )
}
