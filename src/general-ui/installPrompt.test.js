// The "is this a launch from the home-screen icon?" matrix. It gates a real
// reward, and every signal in it is one engine's idea of the truth: iOS Safari
// answers with navigator.standalone, an Android WebAPK with a display-mode
// that isn't always `standalone`, and an iOS third-party-browser web app only
// with the start_url marker boot.js stamped. Missing one of them reads to the
// player as "I added it and the gift is still locked".
import { readFileSync } from 'node:fs'

import { describe, it, expect, afterEach } from 'vitest'

import { isHomeScreenLaunch, HOME_SCREEN_KEY } from './installPrompt.js'

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

describe('the remembered verdict', () => {
  const source = readFileSync(new URL('./installPrompt.js', import.meta.url), 'utf8')

  it('is held in sessionStorage, never localStorage', () => {
    // Android and desktop Chrome give the browser tab and the installed app ONE
    // localStorage. Remembering "launched from the icon" there would hand the
    // install-only gift to the browser tab as well — the exact thing this gate
    // exists to prevent. sessionStorage is per browsing context: it survives the
    // cache-buster reload inside this container and reaches nothing else.
    expect(source).toMatch(/sessionStorage/)
    expect(source).not.toMatch(/localStorage/)
  })

  it('uses the same key boot.js stamps', () => {
    // Two halves of one handshake in two files — boot.js writes it before React
    // exists, this module reads it. Drift = the start_url signal silently lost.
    const boot = readFileSync(new URL('../../public/boot.js', import.meta.url), 'utf8')
    expect(boot).toContain(`HOME_SCREEN_KEY = '${HOME_SCREEN_KEY}'`)
  })
})
