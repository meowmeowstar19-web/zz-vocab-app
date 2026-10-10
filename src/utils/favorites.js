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
// ⚠️ 只落 localStorage，没进云快照（progressSync）。真要跨设备同步得动
// progressSync 的合并规则，那是另一件事，别顺手塞。

const KEY = (langKey = 'guest_en') => `vocab_favorites_${langKey}`;

/** 读这个作用域下的全部收藏；存储坏了/读不到一律当空，绝不抛。 */
export function getFavorites(langKey = 'guest_en') {
  try {
    const raw = localStorage.getItem(KEY(langKey));
    const parsed = raw ? JSON.parse(raw) : {};
    // 存储被手改成数组/字符串时 JSON.parse 不会抛，但形状是错的 —— 这里兜住，
    // 否则后面 favorites[w.id] 会在渲染期炸（app 没有 error boundary）。
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveFavorites(favorites, langKey = 'guest_en') {
  try {
    localStorage.setItem(KEY(langKey), JSON.stringify(favorites || {}));
  } catch {
    // 配额满 / 隐私模式：收藏丢了也不能让点击崩掉
  }
}

export function isFavorite(wordId, langKey = 'guest_en') {
  return !!getFavorites(langKey)[wordId];
}

/**
 * 收/取消收一个词，返回写入后的新 map（调用方直接拿去 setState，
 * 不用再读一次 localStorage）。
 */
export function toggleFavorite(wordId, langKey = 'guest_en') {
  const favorites = getFavorites(langKey);
  const next = { ...favorites };
  if (next[wordId]) {
    delete next[wordId];
  } else {
    next[wordId] = Date.now();
  }
  saveFavorites(next, langKey);
  return next;
}
