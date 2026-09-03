// 自定义词组 —— 用户在 App 里自己手打的「进阶」内容，归到「自定义」分类。
//
// 跟 src/data/ 下那些 AUTO-GENERATED 的词库分开：那边是 Excel 生成的正本，
// 这边是运行时的用户数据，只落 localStorage，按账号 scope（'guest' / `u_${uid}`）
// 分槽存 —— 跟 progress 一样，换账号不串味。
//
// 形状故意跟 devPhrases 的词对象**完全同构**（level:'dev'）：学习队列、复习、
// 已斩、搜索、pop 详情这些既有逻辑拿到它就直接能跑，一处都不用分叉。
//
// 音频：故意不注册任何录音（用户要求「不生成默认音频」）。speakDevPhrase 在
// dev-phrases manifest 里查不到 key 就退回浏览器 TTS —— 不发任何请求、不占
// 任何资源，词照样能读出来。
// 音标：不带 ipa，langHelpers.getPhonetic 返回空 → pop 里干脆不显示音标，
// 跟 CLAUDE.md「只显示数据里标注过的」那条规矩一致。

import { useSyncExternalStore } from 'react';

export const CUSTOM_CATEGORY = '自定义';
export const CUSTOM_MAX_PER_BATCH = 10;

const KEY = (scope) => `vocab_custom_words_${scope || 'guest'}`;
const DRAFT_KEY = (scope) => `vocab_custom_draft_${scope || 'guest'}`;

/* ── hydration ──────────────────────────────────────────────────
 * 存的是精简条目（只有用户打的字），用的时候补齐成完整词对象。 */
function hydrate(e) {
  return {
    id: e.id,
    en: e.en,
    zh: e.zh,
    category: CUSTOM_CATEGORY,
    img: null,
    level: 'dev',
    sentence: e.sentence || '',
    // 自定义词组只留英文例句：用户明确不要中文例句，也不要自动翻译。
    // 字段留着是因为 getStaticSentence 会读它 —— 永远是空串。
    sentenceZh: '',
    ja: null, jaSentence: null,
    ipa: '', pinyin: '', jaReading: null,
    custom: true,
    createdAt: e.createdAt || 0,
  };
}

function readRaw(scope) {
  try {
    const s = localStorage.getItem(KEY(scope));
    const arr = s ? JSON.parse(s) : [];
    return Array.isArray(arr) ? arr.filter(e => e && e.id && e.en && e.zh) : [];
  } catch {
    return [];
  }
}

/* ── store ──────────────────────────────────────────────────────
 * useSyncExternalStore 要求 getSnapshot 返回**稳定引用**，否则每次渲染都是
 * 新数组 → 无限重渲染。所以按 scope 缓存 hydrate 结果，只有写入时才失效。 */
const EMPTY = Object.freeze([]);
const _cache = new Map();
const _listeners = new Set();

function emit() {
  _listeners.forEach(fn => { try { fn(); } catch {} });
}

function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function getCustomWords(scope) {
  if (!_cache.has(scope)) {
    const list = readRaw(scope).map(hydrate);
    _cache.set(scope, list.length ? Object.freeze(list) : EMPTY);
  }
  return _cache.get(scope);
}

// id 前缀 'custom-' 天然跟 'dev-' / 单词 id 隔开，只需要在自定义内部去重。
// 跟 devPhrases 的 makeId 同一套规矩：id 既是 React list key 又是 progress
// 的存储键，重了就等于两条词共用一份「学过/已斩」。
function makeId(en, used) {
  const slug = en.toLowerCase()
    .replace(/['’]+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const base = 'custom-' + (slug || 'word');
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// 只有英文 + 中文都填了的行才算数；半截的行直接丢掉（调用方负责提示）。
export function normalizeRows(rows) {
  return (rows || [])
    .map(r => ({
      en: clean(r.en),
      zh: clean(r.zh),
      sentence: clean(r.sentence),
    }))
    .filter(r => r.en && r.zh);
}

/** 追加若干条自定义词组，返回**新加的**词对象（已 hydrate，保持传入顺序）。 */
export function addCustomWords(scope, rows) {
  const entries = normalizeRows(rows).slice(0, CUSTOM_MAX_PER_BATCH);
  if (!entries.length) return [];

  const existing = readRaw(scope);
  const used = new Set(existing.map(e => e.id));
  const now = Date.now();
  const added = entries.map((r, i) => {
    const id = makeId(r.en, used);
    used.add(id);
    return { id, ...r, createdAt: now + i };
  });

  try {
    localStorage.setItem(KEY(scope), JSON.stringify([...existing, ...added]));
  } catch {
    // 配额满 / 隐私模式：写不进去就当没加，别让页面挂掉。
    return [];
  }
  _cache.delete(scope);
  emit();
  return added.map(hydrate);
}

/* ── 草稿 ────────────────────────────────────────────────────────
 * 手打十条词组，误触关闭就全没了 —— 所以边打边存，重开 pop 原样接着填。
 * 提交成功后由调用方清掉。 */
export function readDraft(scope) {
  try {
    const s = localStorage.getItem(DRAFT_KEY(scope));
    const arr = s ? JSON.parse(s) : null;
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch {
    return null;
  }
}

export function writeDraft(scope, rows) {
  try {
    localStorage.setItem(DRAFT_KEY(scope), JSON.stringify(rows));
  } catch {}
}

export function clearDraft(scope) {
  try { localStorage.removeItem(DRAFT_KEY(scope)); } catch {}
}

/** 订阅式读取：任何一处添加了词，学习页和单词本同一帧就都看得到。 */
export function useCustomWords(scope) {
  return useSyncExternalStore(
    subscribe,
    () => getCustomWords(scope),
    () => EMPTY,
  );
}
