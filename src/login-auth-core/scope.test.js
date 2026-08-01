// The storage primitives every scoped key rides on. The app-owned seed
// manifest (which keys move at Sign Up, and how) has its own tests next to the
// manifest itself — nothing here knows any real key names.
import { describe, it, expect, beforeEach } from 'vitest'

import { setScope, getScope, scopedKey, loadScoped, saveScoped, clearScope } from './scope.js'

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

beforeEach(() => {
  globalThis.localStorage = fakeLS()
  setScope('guest')
})

describe('scoped keys', () => {
  it("'guest' is a normal scope with its own prefix", () => {
    expect(scopedKey('app.coins.v1')).toBe('guest.app.coins.v1')
    setScope('u_abc')
    expect(scopedKey('app.coins.v1')).toBe('u_abc.app.coins.v1')
    expect(scopedKey('app.coins.v1', 'guest')).toBe('guest.app.coins.v1')
  })

  it('a falsy scope falls back to guest', () => {
    setScope(null)
    expect(getScope()).toBe('guest')
  })

  it('load/save round-trip in the current scope', () => {
    setScope('u_abc')
    saveScoped('app.coins.v1', 42)
    expect(loadScoped('app.coins.v1', 0)).toBe(42)
    setScope('guest')
    expect(loadScoped('app.coins.v1', 0)).toBe(0) // other scope's value invisible
  })

  it('loadScoped survives corrupt JSON with the fallback', () => {
    globalThis.localStorage.setItem('guest.app.coins.v1', '{not json')
    expect(loadScoped('app.coins.v1', 7)).toBe(7)
  })
})

describe('clearScope (reset one sandbox, touch nothing else)', () => {
  it('wipes every key under the scope, leaves other scopes and unscoped keys alone', () => {
    put('guest', 'app.coins.v1', 120)
    put('guest', 'app.owned.v1', ['a'])
    put('u_abc', 'app.coins.v1', 500)
    globalThis.localStorage.setItem('auth.snapshot.v1', '{}')
    clearScope('guest')
    expect(globalThis.localStorage.getItem('guest.app.coins.v1')).toBe(null)
    expect(globalThis.localStorage.getItem('guest.app.owned.v1')).toBe(null)
    expect(globalThis.localStorage.getItem('u_abc.app.coins.v1')).not.toBe(null)
    expect(globalThis.localStorage.getItem('auth.snapshot.v1')).toBe('{}')
  })
})
