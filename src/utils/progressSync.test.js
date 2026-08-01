// progressSync — the learn-settings leg (category theme + level). The stakes
// are the clobber cases: every boot self-writes a default category ('all'),
// so an unstamped snapshot must carry NO vote — a fresh A2HS container that
// syncs before the user touches anything must never overwrite the account's
// real picks, in either direction (merge or the push path's lang override).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  readLocalSnapshot,
  writeLocalSnapshot,
  mergeSnapshots,
  pushLocalToCloud,
} from './progressSync.js'

const supabaseCalls = { upserts: [], cloudRow: null }
vi.mock('../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { data: supabaseCalls.cloudRow }, error: null }),
        }),
      }),
      upsert: async (row) => {
        supabaseCalls.upserts.push(row)
        return { error: null }
      },
    }),
  },
}))

function fakeLS() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

beforeEach(() => {
  globalThis.localStorage = fakeLS()
  supabaseCalls.upserts.length = 0
  supabaseCalls.cloudRow = null
})
afterEach(() => {
  delete globalThis.localStorage
})

const emptyCloud = { progress: {}, review_states: {}, login_days: [] }

describe('readLocalSnapshot — learn settings vote rules', () => {
  it('ships category+level with the explicit pick stamp', () => {
    localStorage.setItem('app_learning_category', 'fruits')
    localStorage.setItem('app_learning_level', 'advanced')
    localStorage.setItem('app_learning_pick_ts', '1700000000000')
    const snap = readLocalSnapshot('u1', 'u_u1')
    expect(snap.preferences.learn).toEqual({
      category: 'fruits',
      level: 'advanced',
      pickedAt: 1700000000000,
    })
  })

  it("a boot-written bare 'all' with no stamp carries NO vote (the fresh-container case)", () => {
    // exactly what loadLearningCategoryOnBoot leaves behind in a new container
    localStorage.setItem('app_learning_category', 'all')
    localStorage.setItem('app_learning_category_ts', String(Date.now()))
    const snap = readLocalSnapshot('u1', 'u_u1')
    expect(snap.preferences?.learn).toBeUndefined()
  })

  it("backfills an ancient pick (1) for pre-stamp devices — non-'all' category or any level", () => {
    localStorage.setItem('app_learning_category', 'animals')
    expect(readLocalSnapshot('u1', 'u_u1').preferences.learn).toEqual({
      category: 'animals',
      level: null,
      pickedAt: 1,
    })
    globalThis.localStorage = fakeLS()
    localStorage.setItem('app_learning_category', 'all')
    localStorage.setItem('app_learning_level', 'advanced')
    // level only exists as an explicit pick, so it votes even beside 'all'
    expect(readLocalSnapshot('u1', 'u_u1').preferences.learn).toEqual({
      category: 'all',
      level: 'advanced',
      pickedAt: 1,
    })
  })
})

describe('mergeSnapshots — newest pick wins', () => {
  const local = (learn) => ({ progress: {}, review_states: {}, login_days: [], preferences: learn && { learn } })
  const cloud = (learn) => ({ ...emptyCloud, preferences: learn && { learn } })

  it('the side with no vote loses to the side with one', () => {
    const c = { category: 'fruits', level: 'advanced', pickedAt: 5 }
    expect(mergeSnapshots(local(null), cloud(c)).preferences.learn).toEqual(c)
    const l = { category: 'animals', level: null, pickedAt: 5 }
    expect(mergeSnapshots(local(l), cloud(null)).preferences.learn).toEqual(l)
  })

  it('newer stamp wins regardless of direction; ancient backfill ties settle on cloud', () => {
    const older = { category: 'fruits', level: 'beginner', pickedAt: 10 }
    const newer = { category: 'colors', level: 'advanced', pickedAt: 20 }
    expect(mergeSnapshots(local(newer), cloud(older)).preferences.learn).toEqual(newer)
    expect(mergeSnapshots(local(older), cloud(newer)).preferences.learn).toEqual(newer)
    const a = { category: 'animals', level: null, pickedAt: 1 }
    const b = { category: 'fruits', level: null, pickedAt: 1 }
    expect(mergeSnapshots(local(a), cloud(b)).preferences.learn).toEqual(b)
  })

  it('learn rides independently of the lang branches', () => {
    const l = { progress: {}, review_states: {}, login_days: [], preferences: { nativeLang: 'zh', targetLang: 'ja', learn: { category: 'food', level: null, pickedAt: 9 } } }
    const c = { ...emptyCloud, preferences: { nativeLang: 'en', targetLang: 'ja' } }
    const out = mergeSnapshots(l, c)
    expect(out.preferences.nativeLang).toBe('en') // plain login: cloud langs win (unchanged)
    expect(out.preferences.learn).toEqual({ category: 'food', level: null, pickedAt: 9 })
  })
})

describe('writeLocalSnapshot — restore without wiping', () => {
  it('writes the restored learn fields and their stamp', () => {
    writeLocalSnapshot('u1', {
      progress: {}, review_states: {},
      preferences: { learn: { category: 'fruits', level: 'advanced', pickedAt: 42 } },
    }, 'u_u1')
    expect(localStorage.getItem('app_learning_category')).toBe('fruits')
    expect(localStorage.getItem('app_learning_level')).toBe('advanced')
    expect(localStorage.getItem('app_learning_pick_ts')).toBe('42')
  })

  it('a snapshot with no learn leaves the device picks alone', () => {
    localStorage.setItem('app_learning_category', 'animals')
    localStorage.setItem('app_learning_pick_ts', '7')
    writeLocalSnapshot('u1', { progress: {}, review_states: {}, preferences: { nativeLang: 'zh' } }, 'u_u1')
    expect(localStorage.getItem('app_learning_category')).toBe('animals')
    expect(localStorage.getItem('app_learning_pick_ts')).toBe('7')
  })
})

describe('pushLocalToCloud — the lang override must not eat the learn verdict', () => {
  it("a device with langs but no learn picks pushes the CLOUD's learn intact", async () => {
    // the fresh A2HS container right after the handoff: langs restored, boot
    // default 'all' unstamped, cloud row carrying the account's real picks
    localStorage.setItem('app_native', 'zh')
    localStorage.setItem('app_target', 'ja')
    localStorage.setItem('app_learning_category', 'all')
    supabaseCalls.cloudRow = {
      ...emptyCloud,
      preferences: { nativeLang: 'zh', targetLang: 'ja', learn: { category: 'fruits', level: 'advanced', pickedAt: 99 } },
    }
    await pushLocalToCloud('u1')
    expect(supabaseCalls.upserts).toHaveLength(1)
    const pushed = supabaseCalls.upserts[0].data.preferences
    expect(pushed.learn).toEqual({ category: 'fruits', level: 'advanced', pickedAt: 99 })
    expect(pushed.nativeLang).toBe('zh')
    // and the restore leg landed the picks on this device too
    expect(localStorage.getItem('app_learning_category')).toBe('fruits')
    expect(localStorage.getItem('app_learning_level')).toBe('advanced')
  })

  it('a newer local pick beats the cloud row on the same path', async () => {
    localStorage.setItem('app_native', 'zh')
    localStorage.setItem('app_learning_category', 'colors')
    localStorage.setItem('app_learning_pick_ts', '200')
    supabaseCalls.cloudRow = {
      ...emptyCloud,
      preferences: { learn: { category: 'fruits', level: null, pickedAt: 100 } },
    }
    await pushLocalToCloud('u1')
    expect(supabaseCalls.upserts[0].data.preferences.learn).toEqual({ category: 'colors', level: null, pickedAt: 200 })
  })
})
