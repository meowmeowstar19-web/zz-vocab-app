// Add-to-Home-Screen MECHANICS — the shared plumbing under every install UI.
// Byte-copied between apps (pwa-kit; see docs/pwa-kit.md). The GUIDE MODAL on
// top of this is deliberately app-owned: each app has its own designed flow
// (Muku Fuku shows Chrome + Safari side by side in English; PlushieWord picks
// one browser's steps, localized) — only the fiddly, identical machinery lives
// here.
//
// HOST CONTRACT: the app's boot script must stash the install prompt on
// window BEFORE React mounts — Chrome fires `beforeinstallprompt` exactly
// once, very early, and a listener added after React hydrates has already
// missed it. It must also stamp the home-screen launch (see below), because
// the `?source=pwa` marker is gone by the time React looks. Both live in the
// pwa-kit boot.js (portable body); the protocol:
//   window.__deferredInstallPrompt   the captured BeforeInstallPromptEvent
//   'installpromptready'             fired when the stash lands
//   'appinstalled'                   native event; the stash is nulled on it
//   window.__launchedFromHomeScreen  true when boot saw a home-screen launch
//   sessionStorage['pwa.launch.v1']  the same verdict, held for this launch
import { useEffect, useState } from 'react'

// TWO DIFFERENT QUESTIONS, deliberately not merged:
//
//   useHomeScreenLaunch()  is the app running RIGHT NOW from the icon?
//   usePwaInstalled()      does this device have the app at all?
//
// An install-gated REWARD must ask the first one: "a web page can't claim it,
// the home-screen app can" is the whole rule, and on Android and desktop
// Chrome the browser tab and the installed app share one storage container and
// one getInstalledRelatedApps answer — so anything remembered across launches,
// or any "is it installed" probe, leaks the reward back into the browser tab.
// (iOS containers are separate, which is exactly why that leak is easy to miss
// in testing.) An "Add to Home Screen" PILL wants the second one: once the
// device has the app, offering to install it again is noise.

// Verdict for "THIS launch came from the icon", kept in sessionStorage: it has
// to survive a reload inside this container (our own ?v= cache-buster drops
// the start_url marker) and must NOT survive into any other browsing context.
// Shared with boot.js — change it in both.
export const HOME_SCREEN_KEY = 'pwa.launch.v1'

// Every display mode a home-screen launch can land in. `standalone` covers
// the normal case, but an Android WebAPK can come up `minimal-ui`, a manifest
// with `display_override` can come up `fullscreen`, and an installed desktop
// app can come up `window-controls-overlay` — all of them are "opened from the
// installed app", none of them are a browser tab.
const LAUNCH_MODES = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']

// Is THIS moment a home-screen launch? Every signal is positive-only; none of
// them is trusted to answer on the first millisecond, which is why callers
// re-ask (iOS answers the media query late in a cold start).
export function isHomeScreenLaunch() {
  try {
    if (window.navigator.standalone === true) return true // iOS Safari home-screen app
    if (window.matchMedia) {
      for (const mode of LAUNCH_MODES) {
        if (window.matchMedia(`(display-mode: ${mode})`).matches) return true
      }
    }
    // Stamped by boot.js from the manifest's `start_url` marker (`?source=pwa`)
    // — the one signal that still works in an engine whose display-mode query
    // lies (iOS third-party-browser web apps), and it survives our own URL
    // tidy-up and cache-buster reload only because boot grabbed it first.
    if (window.__launchedFromHomeScreen === true) return true
  } catch {}
  return false
}

function readLaunchFlag() {
  try { return window.sessionStorage.getItem(HOME_SCREEN_KEY) === '1' } catch { return false }
}

function writeLaunchFlag() {
  try { window.sessionStorage.setItem(HOME_SCREEN_KEY, '1') } catch {}
}

// QA/preview override (mirrors InAppBrowserBanner's ?inapp=): ?pwa=1 forces the
// "installed" state, ?pwa=0 the browser state — lets the operator eyeball both
// the "Add it" and "Claim" states of a gated gift without a real install.
// Never written to the launch flag: a forced state must not outlive the tab.
function forcedOverride() {
  try {
    const forced = new URLSearchParams(window.location.search).get('pwa')
    if (forced === '1') return true
    if (forced === '0') return false
  } catch {}
  return null
}

// Answer now, and hold a positive answer for the rest of this launch: a launch
// that already proved itself must not be un-proved by a later render, a late
// media query, or a reload that dropped the start_url marker.
function detectLaunch() {
  if (isHomeScreenLaunch()) { writeLaunchFlag(); return true }
  return readLaunchFlag()
}

// Was THIS session opened from the home-screen icon? The gate for
// install-only rewards. Never true in a browser tab, on any platform.
//
// The answer is re-asked rather than snapshotted at mount: a cold start can
// answer "browser tab" for a beat while the web-app container is still coming
// up, and freezing that wrong answer for the whole session is how a player who
// did add the icon still finds the gift locked. Media-query listeners catch the
// flip; visibility/pageshow catch a container resumed from the page cache; the
// timers catch an engine that flips silently.
export function useHomeScreenLaunch() {
  const [fromIcon, setFromIcon] = useState(() => {
    const forced = forcedOverride()
    return forced === null ? detectLaunch() : forced
  })
  useEffect(() => {
    if (forcedOverride() !== null) return undefined
    let cancelled = false
    const recheck = () => { if (!cancelled && detectLaunch()) setFromIcon(true) }
    const queries = []
    if (window.matchMedia) {
      for (const mode of LAUNCH_MODES) {
        try {
          const q = window.matchMedia(`(display-mode: ${mode})`)
          if (q.addEventListener) q.addEventListener('change', recheck)
          else if (q.addListener) q.addListener(recheck) // Safari < 14
          queries.push(q)
        } catch {}
      }
    }
    document.addEventListener('visibilitychange', recheck)
    window.addEventListener('pageshow', recheck)
    const timers = [300, 1500, 4000].map((ms) => setTimeout(recheck, ms))
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', recheck)
      window.removeEventListener('pageshow', recheck)
      timers.forEach(clearTimeout)
      queries.forEach((q) => {
        try {
          if (q.removeEventListener) q.removeEventListener('change', recheck)
          else if (q.removeListener) q.removeListener(recheck)
        } catch {}
      })
    }
  }, [])
  return fromIcon
}

// Does this device have the app? Powers "already added" pill states — NOT
// reward gates (see the two-questions note at the top: this one is true in a
// browser tab too, which is the point for a pill and wrong for a gift).
//
// Only ever flips to true on a POSITIVE signal — absence of
// beforeinstallprompt is throttled by engagement heuristics, not proof.
// getInstalledRelatedApps matches `related_applications` in the manifest
// (Chrome desktop / Android, even from a normal browser tab).
export function usePwaInstalled() {
  const fromIcon = useHomeScreenLaunch()
  const [installed, setInstalled] = useState(false)
  useEffect(() => {
    if (forcedOverride() !== null) return undefined
    let cancelled = false
    if (navigator.getInstalledRelatedApps) {
      navigator.getInstalledRelatedApps()
        .then((apps) => { if (!cancelled && apps && apps.length > 0) setInstalled(true) })
        .catch(() => {})
    }
    const onInstalled = () => { if (!cancelled) setInstalled(true) }
    window.addEventListener('appinstalled', onInstalled)
    return () => { cancelled = true; window.removeEventListener('appinstalled', onInstalled) }
  }, [])
  return fromIcon || installed
}

// Resolve the stashed BeforeInstallPromptEvent, waiting up to `ms` for a boot
// that hasn't captured it yet. Resolves null where the event never fires
// (iOS — every browser there; desktop Safari; already installed).
export function waitForInstallPrompt(ms) {
  return new Promise((resolve) => {
    if (window.__deferredInstallPrompt) { resolve(window.__deferredInstallPrompt); return }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      window.removeEventListener('installpromptready', finish)
      resolve(window.__deferredInstallPrompt || null)
    }
    window.addEventListener('installpromptready', finish)
    setTimeout(finish, ms)
  })
}

// Live boolean: "would a one-tap native install work right now?" — true while
// a captured prompt is stashed, false again once the app is installed. For
// callers that gate an install NUDGE on it (a dead-end modal is worse than no
// nudge); callers that always have manual steps to show don't need this.
export function useInstallPromptReady() {
  const [ready, setReady] = useState(
    typeof window !== 'undefined' && !!window.__deferredInstallPrompt,
  )
  useEffect(() => {
    const onReady = () => setReady(!!window.__deferredInstallPrompt)
    const onInstalled = () => setReady(false)
    window.addEventListener('installpromptready', onReady)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('installpromptready', onReady)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])
  return ready
}
