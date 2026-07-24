// Ported from src/auth/scopedStorage.test.js — same merge policy and plumbing.
// Dropped: the reconcileGuestScopeOnce suite (the one-time anon-uid migration
// is deleted with the anon world) and the old machine-effect suite (when the
// merge fires is now covered end-to-end in store.test.js). Added: scopeHasData.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  mergeData,
  mergeScopes,
  clearScope,
  scopeHasData,
  setScope,
  scopedKey,
  loadScoped,
  saveScoped,
} from './scope.js'

function fakeLS() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    keys: () => [...m.keys()],
  }
}

beforeEach(() => {
  globalThis.localStorage = fakeLS()
  setScope('guest')
})

/* ---------------------------------------------------------- merge policy */
describe('mergeData (user-approved policy: coins max, owned union, to-wins)', () => {
  it('coins take the max, never sum', () => {
    expect(mergeData({ coins: 120 }, { coins: 80 }).coins).toBe(120)
    expect(mergeData({ coins: 10 }, { coins: 999 }).coins).toBe(999)
  })

  it('owned & claimed are unions, deduped', () => {
    const m = mergeData(
      { owned: ['a', 'b'], claimed: ['r1'] },
      { owned: ['b', 'c'], claimed: ['r1', 'r2'] },
    )
    expect(m.owned.sort()).toEqual(['a', 'b', 'c'])
    expect(m.claimed.sort()).toEqual(['r1', 'r2'])
  })

  it('equipped: target account wins per slot, guest fills the gaps', () => {
    const m = mergeData(
      { equipped: { default: { top: 'g_top', shoes: 'g_shoes' } } },
      { equipped: { default: { top: 'acct_top' } } },
    )
    expect(m.equipped.default).toEqual({ top: 'acct_top', shoes: 'g_shoes' })
  })

  it('daily login progress takes the further-along pack', () => {
    const m = mergeData(
      { daily: { pack1: { last: '2026-07-01', count: 3 }, pack2: { last: '2026-07-06', count: 1 } } },
      { daily: { pack1: { last: '2026-07-05', count: 5 } } },
    )
    expect(m.daily.pack1.count).toBe(5)
    expect(m.daily.pack2.count).toBe(1)
  })

  it('daily tie (equal count) keeps the account side', () => {
    const m = mergeData(
      { daily: { p: { last: 'guest-day', count: 2 } } },
      { daily: { p: { last: 'acct-day', count: 2 } } },
    )
    expect(m.daily.p.last).toBe('acct-day')
  })

  it('seen red-dot state unions per tab', () => {
    const m = mergeData(
      { seen: { shop: ['a', 'b'] } },
      { seen: { shop: ['b', 'c'], closet: ['x'] } },
    )
    expect(m.seen.shop.sort()).toEqual(['a', 'b', 'c'])
    expect(m.seen.closet).toEqual(['x'])
  })

  it('loginDays are a union of distinct dates, sorted', () => {
    const m = mergeData(
      { loginDays: ['2026-07-05', '2026-07-06'] },
      { loginDays: ['2026-07-01', '2026-07-05'] },
    )
    expect(m.loginDays).toEqual(['2026-07-01', '2026-07-05', '2026-07-06'])
  })

  it('loginDays tolerate a corrupt (non-array) side', () => {
    expect(mergeData({ loginDays: 'junk' }, { loginDays: ['2026-07-06'] }).loginDays).toEqual(['2026-07-06'])
    expect(mergeData({}, {}).loginDays).toEqual([])
  })

  it('avatar: account wins, guest fills the gap', () => {
    expect(mergeData({ avatar: 'g.png' }, { avatar: 'acct.png' }).avatar).toBe('acct.png')
    expect(mergeData({ avatar: 'g.png' }, {}).avatar).toBe('g.png')
    expect(mergeData({ avatar: 'g.png' }, { avatar: '' }).avatar).toBe('g.png') // '' = unset
    expect(mergeData({}, {}).avatar).toBeNull()
  })

  it('empty guest merges into account as a no-op', () => {
    const acct = { coins: 50, owned: ['x'], claimed: [], daily: {}, equipped: {}, seen: {}, active: 'default' }
    const m = mergeData({}, acct)
    expect(m.coins).toBe(50)
    expect(m.owned).toEqual(['x'])
    expect(m.active).toBe('default')
  })
})

/* ------------------------------------------------------------ scoped keys */
describe('scoped keys', () => {
  it("'guest' is a normal scope with its own prefix", () => {
    expect(scopedKey('miraclezz.coins.v5', 'guest')).toBe('guest.miraclezz.coins.v5')
    expect(scopedKey('miraclezz.coins.v5', 'u_abc')).toBe('u_abc.miraclezz.coins.v5')
  })

  it('load/save round-trip in the current scope', () => {
    setScope('u_abc')
    saveScoped('miraclezz.coins.v5', 42)
    expect(loadScoped('miraclezz.coins.v5', 0)).toBe(42)
    expect(JSON.parse(localStorage.getItem('u_abc.miraclezz.coins.v5'))).toBe(42)
    setScope('guest')
    expect(loadScoped('miraclezz.coins.v5', 0)).toBe(0) // other scope, other data
    saveScoped('miraclezz.coins.v5', 7)
    expect(JSON.parse(localStorage.getItem('guest.miraclezz.coins.v5'))).toBe(7)
  })
})

/* ---------------------------------------------------------- scopeHasData */
describe('scopeHasData (onUpgrade skips an empty guest)', () => {
  it('false on a never-played scope, true once coins or owned exist', () => {
    expect(scopeHasData('guest')).toBe(false)
    localStorage.setItem('guest.miraclezz.owned.v5', '["a"]')
    expect(scopeHasData('guest')).toBe(true)
  })

  it('coins alone count too', () => {
    localStorage.setItem('guest.miraclezz.coins.v5', '0')
    expect(scopeHasData('guest')).toBe(true) // key present = the guest has played
  })

  it('ANY game key counts — an avatar-only guest is not "empty" (its seed must not be skipped)', () => {
    localStorage.setItem('guest.miraclezz.avatar.v1', '"data:x"')
    expect(scopeHasData('guest')).toBe(true)
    localStorage.removeItem('guest.miraclezz.avatar.v1')
    localStorage.setItem('guest.miraclezz.equipped.v5', '{"default":{"top":"t1"}}')
    expect(scopeHasData('guest')).toBe(true)
  })

  it('other scopes never bleed in', () => {
    localStorage.setItem('u_x.miraclezz.coins.v5', '10')
    expect(scopeHasData('guest')).toBe(false)
  })
})

/* ----------------------------------------------------------- clearScope */
describe('clearScope (guest reset after a sign-up seed)', () => {
  it('wipes every key under the scope, leaves other scopes and unscoped keys alone', () => {
    localStorage.setItem('guest.miraclezz.coins.v5', '500')
    localStorage.setItem('guest.miraclezz.owned.v5', '["a"]')
    localStorage.setItem('u_acct.miraclezz.coins.v5', '80')
    localStorage.setItem('miraclezz.someUnscoped.v1', '{"x":1}')
    clearScope('guest')
    expect(localStorage.getItem('guest.miraclezz.coins.v5')).toBeNull()
    expect(localStorage.getItem('guest.miraclezz.owned.v5')).toBeNull()
    expect(localStorage.getItem('u_acct.miraclezz.coins.v5')).toBe('80') // untouched
    expect(localStorage.getItem('miraclezz.someUnscoped.v1')).not.toBeNull()
  })
})

/* ------------------------------------------------------- mergeScopes (io) */
describe('mergeScopes localStorage plumbing', () => {
  it('folds the guest scope into the account scope; guest keys stay put', () => {
    localStorage.setItem('guest.miraclezz.coins.v5', '120')
    localStorage.setItem('guest.miraclezz.owned.v5', '["a","b"]')
    localStorage.setItem('u_acct.miraclezz.coins.v5', '80')
    localStorage.setItem('u_acct.miraclezz.owned.v5', '["b","c"]')
    mergeScopes('guest', 'u_acct')
    expect(JSON.parse(localStorage.getItem('u_acct.miraclezz.coins.v5'))).toBe(120)
    expect(JSON.parse(localStorage.getItem('u_acct.miraclezz.owned.v5')).sort()).toEqual(['a', 'b', 'c'])
    expect(localStorage.getItem('guest.miraclezz.coins.v5')).toBe('120') // backup intact
  })

  it('carries loginDays and avatar over to the account scope', () => {
    localStorage.setItem('guest.miraclezz.loginDays.v1', '["2026-07-05","2026-07-06"]')
    localStorage.setItem('guest.miraclezz.avatar.v1', '"data:guest"')
    localStorage.setItem('u_acct.miraclezz.loginDays.v1', '["2026-07-01"]')
    mergeScopes('guest', 'u_acct')
    expect(JSON.parse(localStorage.getItem('u_acct.miraclezz.loginDays.v1')))
      .toEqual(['2026-07-01', '2026-07-05', '2026-07-06'])
    // account has no avatar → guest's fills the gap
    expect(JSON.parse(localStorage.getItem('u_acct.miraclezz.avatar.v1'))).toBe('data:guest')
  })

  it('does not overwrite an existing account avatar', () => {
    localStorage.setItem('guest.miraclezz.avatar.v1', '"data:guest"')
    localStorage.setItem('u_acct.miraclezz.avatar.v1', '"data:acct"')
    mergeScopes('guest', 'u_acct')
    expect(JSON.parse(localStorage.getItem('u_acct.miraclezz.avatar.v1'))).toBe('data:acct')
  })

  it('same-scope merge is a no-op and reports false (caller must not clear the only copy)', () => {
    localStorage.setItem('u_same.miraclezz.coins.v5', '77')
    expect(mergeScopes('u_same', 'u_same')).toBe(false)
    expect(localStorage.getItem('u_same.miraclezz.coins.v5')).toBe('77')
  })

  it('returns true only when the fold landed — the caller gates clearScope on it', () => {
    localStorage.setItem('guest.miraclezz.coins.v5', '5')
    expect(mergeScopes('guest', 'u_acct')).toBe(true)
    delete globalThis.localStorage // storage gone → nothing could have been written
    expect(mergeScopes('guest', 'u_acct')).toBe(false)
  })
})
