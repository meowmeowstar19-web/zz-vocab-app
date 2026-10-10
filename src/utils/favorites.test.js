// 收藏 store —— 赌注有三处：
//   · 分槽必须跟进度同一套 key（换账号/换目标语言不能串味）；
//   · toggle 要返回写入后的新 map，调用方直接 setState，不回读 localStorage；
//   · 存储坏了（手改成数组、半截 JSON、配额满）读写都不许抛 —— 这个 app 没有
//     error boundary，渲染期抛一次就是永久白屏。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { getFavorites, saveFavorites, isFavorite, toggleFavorite } from './favorites.js'

// 同 customWords.test.js / progressSync.test.js：测试环境没有 localStorage，
// 塞一个最小实现。
function fakeLS() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

let n = 0
const freshKey = () => `guest_test_${++n}`

beforeEach(() => { globalThis.localStorage = fakeLS() })
afterEach(() => { delete globalThis.localStorage })

describe('getFavorites', () => {
  it('空槽返回空对象', () => {
    expect(getFavorites(freshKey())).toEqual({})
  })

  it('坏 JSON 不抛，当空处理', () => {
    const k = freshKey()
    localStorage.setItem(`vocab_favorites_${k}`, '{半截')
    expect(getFavorites(k)).toEqual({})
  })

  it('形状不对（数组/字符串）也当空 —— 否则 favorites[id] 会在渲染期炸', () => {
    const k1 = freshKey()
    localStorage.setItem(`vocab_favorites_${k1}`, '["a","b"]')
    expect(getFavorites(k1)).toEqual({})

    const k2 = freshKey()
    localStorage.setItem(`vocab_favorites_${k2}`, '"nope"')
    expect(getFavorites(k2)).toEqual({})

    const k3 = freshKey()
    localStorage.setItem(`vocab_favorites_${k3}`, 'null')
    expect(getFavorites(k3)).toEqual({})
  })
})

describe('toggleFavorite', () => {
  it('收藏 → 取消 往返', () => {
    const k = freshKey()
    const added = toggleFavorite('apple', k)
    expect(added.apple).toBeGreaterThan(0)
    expect(isFavorite('apple', k)).toBe(true)

    const removed = toggleFavorite('apple', k)
    expect(removed.apple).toBeUndefined()
    expect(isFavorite('apple', k)).toBe(false)
  })

  it('返回的是写入后的新 map（调用方直接拿去 setState）', () => {
    const k = freshKey()
    const returned = toggleFavorite('dog', k)
    expect(returned).toEqual(getFavorites(k))
  })

  it('不改旧引用 —— useMemo 依赖靠新引用才会重算', () => {
    const k = freshKey()
    const before = getFavorites(k)
    const after = toggleFavorite('cat', k)
    expect(before).toEqual({})
    expect(after).not.toBe(before)
  })

  it('多个词各自独立，落盘能读回来', () => {
    const k = freshKey()
    toggleFavorite('a', k)
    toggleFavorite('b', k)
    toggleFavorite('a', k) // 取消 a
    expect(getFavorites(k)).toEqual({ b: expect.any(Number) })
  })

  it('时间戳用于「最近收藏」排序', () => {
    const k = freshKey()
    toggleFavorite('old', k)
    const favs = toggleFavorite('new', k)
    expect(favs.new).toBeGreaterThanOrEqual(favs.old)
  })
})

describe('分槽', () => {
  it('不同 userScope / targetLang 互不串味', () => {
    toggleFavorite('apple', 'guest_en')
    expect(isFavorite('apple', 'guest_en')).toBe(true)
    expect(isFavorite('apple', 'guest_ja')).toBe(false)
    expect(isFavorite('apple', 'u_abc_en')).toBe(false)
  })

  it('key 跟进度同一套命名', () => {
    toggleFavorite('apple', 'u_abc_ja')
    expect(localStorage.getItem('vocab_favorites_u_abc_ja')).toBeTruthy()
  })
})

describe('saveFavorites', () => {
  it('写 null 不抛，读回是空对象', () => {
    const k = freshKey()
    expect(() => saveFavorites(null, k)).not.toThrow()
    expect(getFavorites(k)).toEqual({})
  })
})
