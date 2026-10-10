// 收藏 —— 用户在单词详情 pop 里点五角星收起来的词。
//
// 跟「已斩」(progress.mastered) 分开：已斩是学习状态（学会了、不想再练），
// 收藏是纯主观书签（想回头再看）。两者互不影响，一个词可以既收藏又已斩。
//
// 存储沿用 storage.js 的分槽规矩：key 带 `${userScope}_${targetLang}`，
// 所以换账号不串味、换目标语言各有各的收藏（词池本来就按 isWordAvailable
// 按语言过滤，跟进度保持同一套作用域才不会出现「收藏了却不在本语言词池里」）。
//
// 形状 = { [wordId]: favoritedAtMs }，跟 progress 的 timestamp 同款，
// 这样收藏列表能按「最近收藏」倒序排。
//
// 跨设备同步（progressSync 云快照的 `favorites` 字段）：
// 取消收藏必须也能同步过去，光做并集的话，A 机取消的词会被 B 机的旧副本
// 「复活」。所以取消时留一个墓碑 `vocab_favorites_removed_*` = { [wordId]: 取消时间 }，
// 合并按「每个词最后一次操作赢」：收藏时间 > 取消时间 才算收藏着。

const KEY = (langKey = 'guest_en') => `vocab_favorites_${langKey}`;
const REMOVED_KEY = (langKey = 'guest_en') => `vocab_favorites_removed_${langKey}`;

// 存储被手改成数组/字符串时 JSON.parse 不会抛，但形状是错的 —— 一律当空，
// 否则后面 favorites[w.id] 会在渲染期炸（app 没有 error boundary）。
function readMap(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(key, map) {
  try {
    localStorage.setItem(key, JSON.stringify(map || {}));
  } catch {
    // 配额满 / 隐私模式：收藏丢了也不能让点击崩掉
  }
}

/** 读这个作用域下的全部收藏；存储坏了/读不到一律当空，绝不抛。 */
export function getFavorites(langKey = 'guest_en') {
  return readMap(KEY(langKey));
}

export function saveFavorites(favorites, langKey = 'guest_en') {
  writeMap(KEY(langKey), favorites);
}

export function isFavorite(wordId, langKey = 'guest_en') {
  return !!getFavorites(langKey)[wordId];
}

/**
 * 收/取消收一个词，返回写入后的新 map（调用方直接拿去 setState，
 * 不用再读一次 localStorage）。
 */
export function toggleFavorite(wordId, langKey = 'guest_en') {
  const now = Date.now();
  const next = { ...getFavorites(langKey) };
  const removed = { ...readMap(REMOVED_KEY(langKey)) };
  if (next[wordId]) {
    delete next[wordId];
    removed[wordId] = now;
  } else {
    next[wordId] = now;
    delete removed[wordId];
  }
  saveFavorites(next, langKey);
  writeMap(REMOVED_KEY(langKey), removed);
  // App.jsx 听这个事件把账号的收藏尽快推上云（跟自定义词组一样走 400ms 去抖）
  try { window.dispatchEvent(new CustomEvent('app:favorites-changed')); } catch {}
  return next;
}

/* ── 云同步用（progressSync 调） ───────────────────────────────── */

/** 一个作用域+目标语言的完整收藏状态（含墓碑），即云快照里的一格。 */
export function readFavoriteState(langKey) {
  return { fav: readMap(KEY(langKey)), removed: readMap(REMOVED_KEY(langKey)) };
}

export function writeFavoriteState(langKey, state) {
  writeMap(KEY(langKey), state?.fav || {});
  writeMap(REMOVED_KEY(langKey), state?.removed || {});
}

export function clearFavoriteState(langKey) {
  try { localStorage.removeItem(KEY(langKey)); } catch {}
  try { localStorage.removeItem(REMOVED_KEY(langKey)); } catch {}
}

/** 每个词「最后一次操作赢」；同一时刻收藏和取消打平时算收藏（宁可多留）。 */
export function mergeFavoriteStates(a = {}, b = {}) {
  const num = (m, id) => Number(m?.[id]) || 0;
  const aFav = a?.fav || {}, bFav = b?.fav || {};
  const aRm = a?.removed || {}, bRm = b?.removed || {};
  const ids = new Set([...Object.keys(aFav), ...Object.keys(bFav), ...Object.keys(aRm), ...Object.keys(bRm)]);
  const fav = {};
  const removed = {};
  for (const id of ids) {
    const favAt = Math.max(num(aFav, id), num(bFav, id));
    const rmAt = Math.max(num(aRm, id), num(bRm, id));
    if (favAt && favAt >= rmAt) fav[id] = favAt;
    else if (rmAt) removed[id] = rmAt;
  }
  return { fav, removed };
}
