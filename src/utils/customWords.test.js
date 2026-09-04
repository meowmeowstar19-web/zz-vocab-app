// 自定义词组 store —— 赌注在 id 和快照引用两处：
//   · id 既是 React list key 又是 progress 的存储键，重了就是两条词共用一份
//     「学过/已斩」（devPhrases 的 makeId 注释里踩过同一个坑）。
//   · getCustomWords 是 useSyncExternalStore 的 getSnapshot：每次调用返回新
//     数组就等于无限重渲染，必须是同一个引用。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  CUSTOM_CATEGORY,
  CUSTOM_MAX_PER_BATCH,
  addCustomWords,
  updateCustomWord,
  getCustomWords,
  normalizeRows,
  readDraft,
  writeDraft,
  clearDraft,
  readCustomWordEntries,
  writeCustomWordEntries,
  clearCustomWordEntries,
} from './customWords.js'

// 每个用例一个新 scope：模块级缓存是按 scope 存的，复用会串味。
let n = 0
const freshScope = () => `test_scope_${++n}`

// 同 progressSync.test.js：测试环境没有 localStorage，塞一个最小实现。
function fakeLS() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

beforeEach(() => { globalThis.localStorage = fakeLS() })
afterEach(() => { delete globalThis.localStorage })

describe('normalizeRows', () => {
  it('英文或中文缺一半的行直接丢掉', () => {
    expect(normalizeRows([
      { en: 'Rain check', zh: '改天吧' },
      { en: 'no chinese', zh: '   ' },
      { en: '', zh: '没有英文' },
    ])).toEqual([
      { en: 'Rain check', zh: '改天吧', sentence: '' },
    ])
  })

  it('首尾空格和中间连续空白都压成单个空格', () => {
    const [row] = normalizeRows([{ en: '  Rain   check  ', zh: ' 改天吧 ' }])
    expect(row.en).toBe('Rain check')
    expect(row.zh).toBe('改天吧')
  })

  it('英文词组的第一个字母自动大写（包括开头有引号时）', () => {
    expect(normalizeRows([{ en: 'call it a day', zh: '收工' }])[0].en).toBe('Call it a day')
    expect(normalizeRows([{ en: '“rain check”', zh: '改天吧' }])[0].en).toBe('“Rain check”')
  })
})

describe('addCustomWords', () => {
  it('补齐成跟 devPhrases 同构的词对象：dev 等级、自定义分类、没图没音标', () => {
    const scope = freshScope()
    const [w] = addCustomWords(scope, [{ en: 'Call it a day', zh: '今天就到这儿' }])
    expect(w).toMatchObject({
      en: 'Call it a day',
      zh: '今天就到这儿',
      level: 'dev',
      category: CUSTOM_CATEGORY,
      img: null,
      ipa: '',
      custom: true,
    })
  })

  it('中文例句永远是空的 —— 用户明确不要中文例句，也不要自动翻译', () => {
    const scope = freshScope()
    const [w] = addCustomWords(scope, [
      { en: 'Rain check', zh: '改天吧', sentence: 'Can I take a rain check?', sentenceZh: '不该被写进去' },
    ])
    expect(w.sentence).toBe('Can I take a rain check?')
    expect(w.sentenceZh).toBe('')
  })

  it('同一个英文加两次也拿到不同的 id', () => {
    const scope = freshScope()
    const ids = addCustomWords(scope, [
      { en: 'Call it a day', zh: '今天就到这儿' },
      { en: 'call it a day', zh: '重复的' },
    ]).map(w => w.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('跨批次也不撞 id（第二批要认得已经存过的那些）', () => {
    const scope = freshScope()
    const first = addCustomWords(scope, [{ en: 'Rain check', zh: '改天吧' }])[0]
    const second = addCustomWords(scope, [{ en: 'Rain check', zh: '再来一次' }])[0]
    expect(second.id).not.toBe(first.id)
    expect(getCustomWords(scope)).toHaveLength(2)
  })

  it('不同设备独立添同一个词也不撞 id', () => {
    const phone = freshScope()
    const desktop = freshScope()
    const a = addCustomWords(phone, [{ en: 'Rain check', zh: '改天吧' }])[0]
    const b = addCustomWords(desktop, [{ en: 'Rain check', zh: '改日再约' }])[0]
    expect(a.id).not.toBe(b.id)
  })

  it(`一次最多 ${CUSTOM_MAX_PER_BATCH} 条`, () => {
    const scope = freshScope()
    const rows = Array.from({ length: 15 }, (_, i) => ({ en: `phrase ${i}`, zh: `词 ${i}` }))
    expect(addCustomWords(scope, rows)).toHaveLength(CUSTOM_MAX_PER_BATCH)
  })

  it('半截的行不落盘，全是半截时什么也不加', () => {
    const scope = freshScope()
    expect(addCustomWords(scope, [{ en: 'no chinese', zh: '' }])).toEqual([])
    expect(getCustomWords(scope)).toHaveLength(0)
  })

  it('按账号 scope 分槽，互不串味', () => {
    const a = freshScope()
    const b = freshScope()
    addCustomWords(a, [{ en: 'Rain check', zh: '改天吧' }])
    expect(getCustomWords(a)).toHaveLength(1)
    expect(getCustomWords(b)).toHaveLength(0)
  })
})

describe('getCustomWords', () => {
  it('没写入就一直是同一个引用（getSnapshot 的硬要求）', () => {
    const scope = freshScope()
    addCustomWords(scope, [{ en: 'Rain check', zh: '改天吧' }])
    expect(getCustomWords(scope)).toBe(getCustomWords(scope))
  })

  it('写入之后换一个新引用，订阅方才看得到新词', () => {
    const scope = freshScope()
    const before = getCustomWords(scope)
    addCustomWords(scope, [{ en: 'Rain check', zh: '改天吧' }])
    expect(getCustomWords(scope)).not.toBe(before)
  })

  it('存储里的脏数据（缺 id/en/zh）跳过，不让整份词库挂掉', () => {
    const scope = freshScope()
    localStorage.setItem(`vocab_custom_words_${scope}`, JSON.stringify([
      { id: 'custom-ok', en: 'Rain check', zh: '改天吧' },
      { id: 'custom-broken', en: 'no chinese' },
      null,
    ]))
    expect(getCustomWords(scope).map(w => w.id)).toEqual(['custom-ok'])
  })

  it('存储里根本不是数组时返回空，不抛', () => {
    const scope = freshScope()
    localStorage.setItem(`vocab_custom_words_${scope}`, '{"nope":1}')
    expect(getCustomWords(scope)).toEqual([])
  })
})

describe('updateCustomWord', () => {
  it('保留 id 和学习关联，同时规范首字母并更新正文', () => {
    const scope = freshScope()
    const original = addCustomWords(scope, [{ en: 'Rain check', zh: '改天吧' }])[0]
    const updated = updateCustomWord(scope, original.id, {
      en: 'call it a day', zh: '今天到这里', sentence: "Let's stop here.",
    })
    expect(updated).toMatchObject({
      id: original.id,
      en: 'Call it a day',
      zh: '今天到这里',
      sentence: "Let's stop here.",
    })
    expect(updated.updatedAt).toBeGreaterThanOrEqual(original.updatedAt)
    expect(getCustomWords(scope)).toHaveLength(1)
  })
})

describe('云快照读写', () => {
  it('只导出用户输入字段，云落地后可直接 hydrate 使用', () => {
    const scope = freshScope()
    const [added] = addCustomWords(scope, [
      { en: 'Call it a day', zh: '今天就到这儿', sentence: "Let's call it a day." },
    ])
    const entries = readCustomWordEntries(scope)
    expect(entries).toEqual([{
      id: added.id,
      en: 'Call it a day',
      zh: '今天就到这儿',
      sentence: "Let's call it a day.",
      createdAt: added.createdAt,
      updatedAt: added.updatedAt,
    }])

    const restoredScope = freshScope()
    expect(writeCustomWordEntries(restoredScope, entries)).toBe(true)
    expect(getCustomWords(restoredScope)[0]).toMatchObject({
      id: added.id,
      en: 'Call it a day',
      custom: true,
      level: 'dev',
    })
  })

  it('清掉 scope 时内存快照也同时失效', () => {
    const scope = freshScope()
    addCustomWords(scope, [{ en: 'Rain check', zh: '改天吧' }])
    clearCustomWordEntries(scope)
    expect(readCustomWordEntries(scope)).toEqual([])
    expect(getCustomWords(scope)).toEqual([])
  })
})

describe('草稿', () => {
  it('存了能读回来，清了就没了', () => {
    const scope = freshScope()
    writeDraft(scope, [{ en: 'half typed', zh: '', sentence: '' }])
    expect(readDraft(scope)).toHaveLength(1)
    clearDraft(scope)
    expect(readDraft(scope)).toBeNull()
  })

  it('空草稿当作没有，重开 pop 不会顶出一堆空行', () => {
    const scope = freshScope()
    writeDraft(scope, [])
    expect(readDraft(scope)).toBeNull()
  })
})
