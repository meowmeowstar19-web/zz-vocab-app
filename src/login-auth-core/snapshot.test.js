// Ported from src/auth/storage.test.js — same discipline (single key, corrupt
// JSON safety, expired-marker-cleared-at-read 铁律1), v2 flow shape.
import { describe, it, expect, beforeEach } from 'vitest'
import { loadSnapshot, saveSnapshot, clearSnapshot, defaultSnapshot, SNAPSHOT_KEY } from './snapshot.js'

// minimal localStorage fake — snapshot.js reads globalThis.localStorage
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

describe('snapshot storage (v2)', () => {
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

  it('an expired flow is cleared at read time and persisted back (铁律1)', () => {
    saveSnapshot({ flow: { kind: 'otp', email: 'a@b.c', surface: 'gate', expiresAt: NOW - 1 } }, NOW - 10)
    const s = loadSnapshot(NOW)
    expect(s.flow).toBeNull() // expired → gone
    // and the cleanup was written back, not just returned
    expect(JSON.parse(localStorage.getItem(SNAPSHOT_KEY)).flow).toBeNull()
  })

  it('a live flow survives the read', () => {
    saveSnapshot({ flow: { kind: 'oauth', provider: 'google', surface: 'welcome', expiresAt: NOW + 999 } }, NOW)
    expect(loadSnapshot(NOW).flow).toMatchObject({ kind: 'oauth', provider: 'google' })
  })

  it('a flow missing expiresAt counts as expired', () => {
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({ ...defaultSnapshot(), flow: { kind: 'otp', email: 'a@b.c', surface: 'gate' } }),
    )
    expect(loadSnapshot(NOW).flow).toBeNull()
  })

  it('a flow with an unknown kind is dropped (forward shape safety)', () => {
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({ ...defaultSnapshot(), flow: { kind: 'wat', expiresAt: NOW + 999 } }),
    )
    expect(loadSnapshot(NOW).flow).toBeNull()
  })

  it('a v1 snapshot migrates: scalars carry over, otp/bind markers are dropped', () => {
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({
        v: 1,
        hadAccount: true,
        explicitLogout: true,
        lastUserScope: 'u_me',
        lastEmail: 'a@b.c',
        otp: { email: 'a@b.c', expiresAt: NOW + 999 },
        bind: { provider: 'google', surface: 'gate', mode: 'bind', expiresAt: NOW + 999 },
      }),
    )
    const s = loadSnapshot(NOW)
    expect(s).toEqual({
      v: 2,
      hadAccount: true,
      explicitLogout: true,
      lastUserScope: 'u_me',
      lastEmail: 'a@b.c',
      flow: null,
    })
    expect('otp' in s).toBe(false)
    expect('bind' in s).toBe(false)
  })

  it('unknown fields are dropped, missing ones defaulted', () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v: 2, hadAccount: 1, junk: 'x' }))
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
