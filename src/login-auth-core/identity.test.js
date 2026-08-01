// Display-identity resolution (name + avatar) across the BOOT WINDOW.
//
// The bug these pin down (2026-07-20, reported on a day-2 mobile cold start):
// the header showed "Guest" over the account's own coins until getSession
// finally answered. Root cause was asking `isRealAccount` ("is a token live
// right now") a question that belongs to the SCOPE ("whose drawer is this") —
// the auth core deliberately renders the account's drawer optimistically
// (铁律8) and its 4s watchdog reports status:'guest' while scope stays u_<uid>
// (see the watchdog test in login-auth-core/store.test.js).
import { describe, it, expect, beforeEach } from 'vitest'

import { createIdentity } from './identity.js'
import { setScope } from './scope.js'

// app-neutral test keys — the factory binds whatever the host app passes
const NAME_KEY = 'app.name.v1'
const NAME_CACHE_KEY = 'app.nameCache.v1'
const AVATAR_CACHE_KEY = 'app.avatarCache.v1'
const { displayNameOf, cacheIdentity, cachedAvatarOf } = createIdentity({
  nameKey: NAME_KEY,
  nameCacheKey: NAME_CACHE_KEY,
  avatarCacheKey: AVATAR_CACHE_KEY,
})

function fakeLS() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    keys: () => [...m.keys()],
  }
}
const put = (scope, name, v) => globalThis.localStorage.setItem(`${scope}.${name}`, JSON.stringify(v))
const get = (scope, name) => globalThis.localStorage.getItem(`${scope}.${name}`)

// what useAuth reports: the SCOPE says account, the session hasn't landed
const ACCOUNT_SCOPE = true
const GUEST_SCOPE = false

const googleUser = {
  email: 'me@example.com',
  user_metadata: { full_name: 'Miao', avatar_url: 'https://pic/me.png' },
}

beforeEach(() => {
  globalThis.localStorage = fakeLS()
  setScope('guest')
})

describe('displayNameOf — boot window (account scope, no session yet)', () => {
  it('shows the cached account name instead of flashing "Guest"', () => {
    setScope('u_abc')
    put('u_abc', NAME_CACHE_KEY, 'Miao')
    // null user = getSession has not answered (or the watchdog gave up first)
    expect(displayNameOf(null, ACCOUNT_SCOPE)).toBe('Miao')
  })

  it('never labels an account drawer "Guest", even with nothing cached', () => {
    setScope('u_abc')
    expect(displayNameOf(null, ACCOUNT_SCOPE)).toBe('Signed in')
  })

  it('a live session outranks a stale cache (renamed on another device)', () => {
    setScope('u_abc')
    put('u_abc', NAME_CACHE_KEY, 'Old Name')
    expect(displayNameOf(googleUser, ACCOUNT_SCOPE)).toBe('Miao')
  })

  it('falls back to the email local part when the session carries no name', () => {
    setScope('u_abc')
    expect(displayNameOf({ email: 'kitty@example.com' }, ACCOUNT_SCOPE)).toBe('kitty')
  })
})

describe('displayNameOf — the rules the rewrite already settled', () => {
  it('a user-typed name wins over session and cache alike', () => {
    setScope('u_abc')
    put('u_abc', NAME_KEY, 'Sparkle')
    put('u_abc', NAME_CACHE_KEY, 'Miao')
    expect(displayNameOf(googleUser, ACCOUNT_SCOPE)).toBe('Sparkle')
  })

  it('a guest is uniformly "Guest" (用户定稿 07-16)', () => {
    setScope('guest')
    expect(displayNameOf(null, GUEST_SCOPE)).toBe('Guest')
  })

  it("a guest never inherits an account's cached name — the cache is per scope", () => {
    put('u_abc', NAME_CACHE_KEY, 'Miao')
    setScope('guest')
    expect(displayNameOf(null, GUEST_SCOPE)).toBe('Guest')
  })
})

describe('cacheIdentity', () => {
  it('mirrors a live session into the CURRENT scope only', () => {
    setScope('u_abc')
    cacheIdentity(googleUser)
    expect(JSON.parse(get('u_abc', NAME_CACHE_KEY))).toBe('Miao')
    expect(JSON.parse(get('u_abc', AVATAR_CACHE_KEY))).toBe('https://pic/me.png')
    expect(get('guest', NAME_CACHE_KEY)).toBe(null)
    setScope('u_abc')
    expect(cachedAvatarOf()).toBe('https://pic/me.png')
  })

  it('a session with no picture leaves any earlier one alone (never blanks it)', () => {
    setScope('u_abc')
    cacheIdentity(googleUser)
    cacheIdentity({ email: 'me@example.com' }) // e.g. an OTP session for the same account
    expect(cachedAvatarOf()).toBe('https://pic/me.png')
  })

  it('a null user (no session) writes nothing', () => {
    setScope('u_abc')
    cacheIdentity(null)
    expect(get('u_abc', NAME_CACHE_KEY)).toBe(null)
    expect(cachedAvatarOf()).toBe('')
  })
})
