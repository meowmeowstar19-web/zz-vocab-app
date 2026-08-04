// The "is this a launch from the home-screen icon?" matrix. It gates a real
// reward, and every signal in it is one engine's idea of the truth: iOS Safari
// answers with navigator.standalone, an Android WebAPK with a display-mode
// that isn't always `standalone`, and an iOS third-party-browser web app only
// with the start_url marker boot.js stamped. Missing one of them reads to the
// player as "I added it and the gift is still locked".
import { describe, it, expect, afterEach } from 'vitest'

import { isHomeScreenLaunch } from './installPrompt.js'

// Minimal window stand-in — matchMedia answers true for the modes listed.
function fakeWindow({ modes = [], standalone, stamped, search = '' } = {}) {
  globalThis.window = {
    navigator: standalone === undefined ? {} : { standalone },
    matchMedia: (q) => ({ matches: modes.some((m) => q === `(display-mode: ${m})`) }),
    location: { search },
    __launchedFromHomeScreen: stamped,
  }
}

afterEach(() => { delete globalThis.window })

describe('isHomeScreenLaunch', () => {
  it('a plain browser tab is not a launch', () => {
    fakeWindow()
    expect(isHomeScreenLaunch()).toBe(false)
  })

  it('iOS Safari home-screen app: navigator.standalone', () => {
    fakeWindow({ standalone: true })
    expect(isHomeScreenLaunch()).toBe(true)
  })

  it('navigator.standalone === false stays a tab (iOS says so explicitly)', () => {
    fakeWindow({ standalone: false })
    expect(isHomeScreenLaunch()).toBe(false)
  })

  it.each(['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'])(
    'display-mode: %s counts as installed',
    (mode) => {
      fakeWindow({ modes: [mode] })
      expect(isHomeScreenLaunch()).toBe(true)
    },
  )

  it('display-mode: browser does not', () => {
    fakeWindow({ modes: ['browser'] })
    expect(isHomeScreenLaunch()).toBe(false)
  })

  it("boot.js's start_url stamp counts on its own", () => {
    // The engine's own answer can be wrong/late; the stamp is why the gift
    // still unlocks there.
    fakeWindow({ stamped: true })
    expect(isHomeScreenLaunch()).toBe(true)
  })

  it('never throws where there is no window at all', () => {
    delete globalThis.window
    expect(isHomeScreenLaunch()).toBe(false)
  })
})
