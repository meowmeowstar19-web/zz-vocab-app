// The 单词/短语/进阶 lists corrupt each other the moment two rows share an id:
// it is both the React list key and the progress storage key. 进阶 shipped that
// once ("Have a falling-out" vs "have a falling out" → one id) and the ghost
// rows leaked into every sub-tab. This locks the invariant on the real data.
import { describe, it, expect } from 'vitest'
import { collectIssues, loadPools, slug } from '../../scripts/check-data.mjs'

describe('data integrity — id uniqueness', () => {
  it('every shipped row has its own id', async () => {
    const { errors } = collectIssues(await loadPools())
    expect(errors).toEqual([])
  })

  it('catches two rows normalizing to one id', () => {
    const { errors } = collectIssues([{ name: 'fake', rows: [
      { id: 'dev-x', en: 'To top it off...', zh: 'a', category: '常用句型' },
      { id: 'dev-x', en: 'to top it off', zh: 'b', category: '原声精讲' },
    ] }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('dev-x')
  })

  it('catches an id colliding across two data files', () => {
    const { errors } = collectIssues([
      { name: 'words.js', rows: [{ id: 'walk', en: 'walk', zh: '走', category: 'action' }] },
      { name: 'devPhrases.js', rows: [{ id: 'walk', en: 'Walk!', zh: '走啊', category: '日常口语' }] },
    ])
    expect(errors.some(e => e.includes('跨表'))).toBe(true)
  })

  it('flags identical content as mergeable, different senses as keep-both', () => {
    const { errors, warnings } = collectIssues([{ name: 'devPhrases.js', rows: [
      { id: 'a', en: "Let's go!", zh: '走吧', category: '日常口语' },
      { id: 'a-2', en: 'Lets go', zh: '走吧', category: '实用词组' },
      { id: 'b', en: 'bat', zh: '蝙蝠', category: '日常口语' },
      { id: 'b-2', en: 'bat', zh: '球棒', category: '实用词组' },
    ] }])
    expect(errors).toEqual([])                                   // suffixed ids are safe
    expect(warnings.some(w => w.includes('完全重复'))).toBe(true)   // same en + same zh
    expect(warnings.some(w => w.includes('同英文不同释义'))).toBe(true)
  })

  it('slug matches the makeId normalization', () => {
    expect(slug('To top it off...')).toBe(slug('to top it off'))
    expect(slug('Have a falling-out')).toBe('have-a-falling-out')
  })
})
