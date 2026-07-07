import { describe, it, expect, beforeEach } from 'vitest'
import { loadSnapshot, saveSnapshot, clearSnapshot, defaultSnapshot, SNAPSHOT_KEY } from './storage.js'

// minimal localStorage fake — storage.js reads globalThis.localStorage
function fakeLS() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

const NOW = 5_000_000

beforeEach(() => {
  globalThis.localStorage = fakeLS()
})

describe('snapshot storage', () => {
  it('fresh device → defaults', () => {
    expect(loadSnapshot(NOW)).toEqual(defaultSnapshot())
  })

  it('save merges a patch and round-trips', () => {
    saveSnapshot({ hadAccount: true, lastEmail: 'a@b.c' }, NOW)
    const s = loadSnapshot(NOW)
    expect(s.hadAccount).toBe(true)
    expect(s.lastEmail).toBe('a@b.c')
    expect(s.explicitLogout).toBe(false)
  })

  it('corrupt JSON never bricks boot (铁律3 spirit)', () => {
    localStorage.setItem(SNAPSHOT_KEY, '{oops')
    expect(loadSnapshot(NOW)).toEqual(defaultSnapshot())
  })

  it('expired otp/bind are cleared at read time and persisted back (铁律1)', () => {
    saveSnapshot(
      {
        otp: { email: 'a@b.c', expiresAt: NOW - 1 },
        bind: { provider: 'google', surface: 'gate', mode: 'bind', expiresAt: NOW + 999 },
      },
      NOW - 10,
    )
    const s = loadSnapshot(NOW)
    expect(s.otp).toBeNull() // expired → gone
    expect(s.bind).not.toBeNull() // still live → kept
    // and the cleanup was written back, not just returned
    expect(JSON.parse(localStorage.getItem(SNAPSHOT_KEY)).otp).toBeNull()
  })

  it('a marker missing expiresAt counts as expired', () => {
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({ ...defaultSnapshot(), otp: { email: 'a@b.c' } }),
    )
    expect(loadSnapshot(NOW).otp).toBeNull()
  })

  it('unknown fields are dropped, missing ones defaulted (forward shape safety)', () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v: 1, hadAccount: 1, junk: 'x' }))
    const s = loadSnapshot(NOW)
    expect(s).toEqual({ ...defaultSnapshot(), hadAccount: true })
    expect('junk' in s).toBe(false)
  })

  it('clearSnapshot resets to defaults', () => {
    saveSnapshot({ hadAccount: true }, NOW)
    clearSnapshot()
    expect(loadSnapshot(NOW)).toEqual(defaultSnapshot())
  })

  it('no localStorage at all → safe no-ops', () => {
    delete globalThis.localStorage
    expect(loadSnapshot(NOW)).toEqual(defaultSnapshot())
    expect(() => saveSnapshot({ hadAccount: true }, NOW)).not.toThrow()
  })
})
