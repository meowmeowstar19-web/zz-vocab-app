// general-ui scroll kit — the two affordances a long scrolling page owes the
// user: a slim pale-white scrollbar (where am I?) and a back-to-top button that
// appears once they're past the first screen (get me out of here).
//
// The bar follows the phone convention rather than the desktop one: invisible
// at rest, appears the instant a finger moves, fades out ~1s after it stops.
// (iOS and Android both do this; only Windows / desktop web keep a bar parked
// on screen.) We draw our own instead of styling ::-webkit-scrollbar because
// iOS Safari ignores that styling completely — the native indicator is not
// ours to restyle, so the only way to get this look is to paint it.
//
// The button's visual is NOT redeclared here — it composes popKit's BACK_BTN
// token (the round translucent-white outlined chip) so it stays a twin of the
// house back button, and its glyph is the shared `up` chevron from icons.jsx.
import { useState, useEffect, useRef, useCallback } from 'react'
import { BACK_BTN } from './popKit.jsx'
import { Icon } from './icons.jsx'

const MIN_THUMB = 28      // long lists must not shrink the thumb to a dot
const OVERFLOW_EPS = 4    // sub-pixel rounding is not "scrollable"
const HIDE_DELAY = 1000   // how long after the finger stops before it fades
const FADE_IN = '.1s'     // arrives with the finger…
const FADE_OUT = '.4s'    // …leaves gently

/* Watches a scroll container (ref → the overflow-y element) and drives both
 * affordances from one passive listener:
 *   past     — scrolled beyond one full screen (首屏), i.e. show the button
 *   barRef   — the scrollbar wrapper; its opacity is driven here
 *   thumbRef — the thumb inside it; its height / offset are driven here
 * Only `past` round-trips through React, and it flips at most once per
 * crossing. Everything that changes per scroll frame is written straight to
 * the DOM: a word list is hundreds of rows, and re-rendering the page on every
 * frame is how a cheap phone starts to stutter.
 * Re-measures on scroll, on viewport resize, and on content changes — the list
 * is swapped wholesale when a filter / tab is tapped, so a stale thumb would
 * be describing a list that no longer exists. */
export function useScrollWatch(ref) {
  const barRef = useRef(null)
  const thumbRef = useRef(null)
  const hideTimer = useRef(0)
  const [past, setPast] = useState(false)

  const fade = useCallback((on) => {
    const bar = barRef.current
    if (!bar) return
    bar.style.transition = `opacity ${on ? FADE_IN : FADE_OUT} ease`
    bar.style.opacity = on ? '1' : '0'
  }, [])

  // Geometry + the button's flag. Safe to call on any layout change — it never
  // shows the bar, so a tap that reveals a translation doesn't flash it.
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return false
    const { scrollTop, scrollHeight, clientHeight } = el
    // clientHeight is 0 while the page sits behind display:none — treat that
    // as "nothing to show" rather than dividing by zero.
    const overflowing = clientHeight > 0 && scrollHeight - clientHeight > OVERFLOW_EPS
    if (overflowing) {
      const thumbH = Math.max(MIN_THUMB, (clientHeight / scrollHeight) * clientHeight)
      const ratio = Math.min(1, Math.max(0, scrollTop / (scrollHeight - clientHeight)))
      const thumb = thumbRef.current
      if (thumb) {
        thumb.style.height = `${thumbH}px`
        thumb.style.transform = `translateY(${ratio * (clientHeight - thumbH)}px)`
      }
    } else {
      // The list shrank under a filter and no longer scrolls — take the bar
      // away now instead of leaving it to time out.
      clearTimeout(hideTimer.current)
      fade(false)
    }
    const next = overflowing && scrollTop > clientHeight
    setPast(p => p === next ? p : next)
    return overflowing
  }, [ref, fade])

  // A finger (or wheel) moved: show the bar, and restart the countdown. During
  // iOS momentum the events keep coming, so it stays up until the list settles.
  const onScroll = useCallback(() => {
    if (!measure()) return
    fade(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => fade(false), HIDE_DELAY)
  }, [measure, fade])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    // Content mutations arrive in bursts (a filter tap replaces every row);
    // coalesce them into one measure per frame.
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; measure() })
    }
    measure()
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', schedule)
    // ResizeObserver catches the box changing — including the tab switch that
    // flips this page from display:none back to visible.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    ro?.observe(el)
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null
    mo?.observe(el, { childList: true, subtree: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      clearTimeout(hideTimer.current)
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', schedule)
      ro?.disconnect()
      mo?.disconnect()
    }
  }, [ref, measure, onScroll])

  const scrollToTop = useCallback(() => {
    ref.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [ref])

  return { past, barRef, thumbRef, scrollToTop }
}

/* The slim pale-white scrollbar. Purely decorative (pointer-events:none) — it
 * reports position, it isn't a drag handle; the finger scrolls the list. Sits
 * in the page's relative wrapper, spanning the same height as the scroll
 * container, so the hook's geometry maps 1:1. Starts hidden, and declares no
 * opacity transition / thumb geometry of its own: useScrollWatch owns those,
 * and React must not fight it for them. */
export function SlimScrollBar({ barRef, thumbRef, style }) {
  return (
    <div
      ref={barRef}
      aria-hidden="true"
      style={{
        position: 'absolute', top: 0, right: 3, bottom: 0, width: 4,
        pointerEvents: 'none', opacity: 0,
        ...style,
      }}
    >
      {/* track — a hint of a rail, so the thumb reads as a position on a whole */}
      <div style={{ position: 'absolute', inset: 0, borderRadius: 999, background: 'rgba(255,255,255,0.30)' }} />
      {/* thumb — pale white, with a whisper of shadow so it survives the light
          patches of the background art */}
      <div
        ref={thumbRef}
        style={{
          position: 'absolute', left: 0, top: 0, width: '100%',
          borderRadius: 999, background: 'rgba(255,255,255,0.92)',
          boxShadow: '0 1px 3px rgba(120,90,110,0.22)',
        }}
      />
    </div>
  )
}

/* Back-to-top — the house back button with its chevron stood on end. Fades in
 * once the hook says we're past the first screen, and stays put (unlike the
 * bar: this one is a control, and a control that hides is a control you can't
 * press). Pages own where it floats via `style`. Deliberately no inline
 * transform: an inline one would outrank the app's global
 * `button:active {scale(.96)}` and kill the press feedback. */
export function ScrollTopButton({ onClick, visible = true, style, label = 'Back to top', size = 36 }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      tabIndex={visible ? 0 : -1}
      aria-hidden={visible ? undefined : true}
      style={{
        ...BACK_BTN,
        width: size, height: size, borderRadius: 999, padding: 0,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity .22s ease',
        ...style,
      }}
    >
      <Icon name="up" size={Math.round(size * 0.6)} color="#3A2E2E" stroke={2.6} />
    </button>
  )
}
