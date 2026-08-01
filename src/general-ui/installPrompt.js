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
// missed it. The exact 8 lines live in the pwa-kit boot.js (portable body);
// the protocol:
//   window.__deferredInstallPrompt   the captured BeforeInstallPromptEvent
//   'installpromptready'             fired when the stash lands
//   'appinstalled'                   native event; the stash is nulled on it
import { useEffect, useState } from 'react'

// Is this session running as an installed app? Powers "already added" pill
// states and install-gated rewards.
//
// Only ever flips to true on a POSITIVE signal — absence of
// beforeinstallprompt is throttled by engagement heuristics, not proof.
// getInstalledRelatedApps matches `related_applications` in the manifest
// (Chrome desktop / Android, even from a normal browser tab).
export function usePwaInstalled() {
  const [installed, setInstalled] = useState(() => {
    try {
      // QA/preview override (mirrors InAppBrowserBanner's ?inapp=): ?pwa=1 forces the
      // "installed" state, ?pwa=0 the browser state — lets the operator eyeball both
      // the "Add it" and "Claim" states of a gated gift without a real install.
      const forced = new URLSearchParams(window.location.search).get('pwa')
      if (forced === '1') return true
      if (forced === '0') return false
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true
      if (window.navigator.standalone === true) return true // iOS Safari
    } catch {}
    return false
  })
  useEffect(() => {
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
  return installed
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
