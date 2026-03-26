import { jaData } from '../data/jaData';
import { phoneticMap } from '../data/phonetics';
import { pinyinMap } from '../data/pinyin';

// ── Language metadata ──
export const LANGUAGES = {
  zh: { code: 'zh', ttsCode: 'zh-CN', flag: '🇨🇳', font: 'inherit' },
  en: { code: 'en', ttsCode: 'en-US', flag: '🇬🇧', font: '"Arial Black", Arial, sans-serif' },
  ja: { code: 'ja', ttsCode: 'ja-JP', flag: '🇯🇵', font: '"Hiragino Sans", "Noto Sans JP", sans-serif' },
};

// ── Get word text in a specific language ──
export function getWordText(word, lang) {
  if (!word) return '';
  if (lang === 'en') return word.en;
  if (lang === 'zh') return word.zh;
  if (lang === 'ja') return jaData[word.en]?.ja || '';
  return word.en;
}

// ── Get sentence in a specific language (static data only) ──
// Chinese has no sentences in data → returns '' (caller uses English fallback)
export function getSentence(word, lang) {
  if (!word) return '';
  if (lang === 'en') return word.sentence || '';
  if (lang === 'ja') return jaData[word.en]?.sentence || '';
  return ''; // zh: no Chinese sentences in data
}

// ── Katakana → Hiragana auto-conversion ──
function katakanaToHiragana(str) {
  if (!str) return '';
  return str.replace(/[\u30A1-\u30F6]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

// ── Get phonetic / reading (returns null if needs API fetch) ──
export function getPhonetic(word, targetLang) {
  if (!word) return '';
  if (targetLang === 'en') {
    const local = phoneticMap[word.en];
    return local || null; // null → trigger API fetch
  }
  if (targetLang === 'ja') {
    const entry = jaData[word.en];
    if (!entry) return '';
    // Use explicit reading if available; otherwise auto-convert katakana → hiragana
    if (entry.reading) return entry.reading;
    return katakanaToHiragana(entry.ja);
  }
  if (targetLang === 'zh') return pinyinMap[word.zh] || '';
  return '';
}

// ── Check if a word has valid data for both languages ──
export function isWordAvailable(word, nativeLang, targetLang) {
  return !!(getWordText(word, nativeLang) && getWordText(word, targetLang));
}

// ── MyMemory API language pair string ──
export function getTranslationPair(fromLang, toLang) {
  const codeMap = { en: 'en', zh: 'zh-CN', ja: 'ja' };
  return `${codeMap[fromLang]}|${codeMap[toLang]}`;
}

// ── TTS code ──
export function getTtsCode(lang) {
  return LANGUAGES[lang]?.ttsCode || 'en-US';
}

// ── Font family for a language ──
export function getFontFamily(lang) {
  return LANGUAGES[lang]?.font || 'inherit';
}

// ── Language name in another language ──
const LANG_NAMES = {
  zh: { zh: '中文', en: 'Chinese', ja: '中国語' },
  en: { zh: '英语', en: 'English', ja: '英語' },
  ja: { zh: '日语', en: 'Japanese', ja: '日本語' },
};

export function getLangName(langCode, inLang) {
  return LANG_NAMES[langCode]?.[inLang] || LANG_NAMES[langCode]?.en || langCode;
}

// ── Localized UI strings ──
export const UI_TEXT = {
  zh: {
    // Tabs
    learn: '学习', wordlist: '单词本', settings: '设置',
    // Learning page
    allDone: '太棒了！', reviewDone: '复习完毕！',
    reviewAll: '所有单词都已复习完！',
    allLearned: '已全部学完！',
    restart: '重新开始', backToList: '返回单词本',
    translating: '翻译加载中…',
    allWords: '所有单词',
    // Word list
    learning: '学习中单词', review: '去复习',
    timeOrder: '时间顺序', randomOrder: '随机顺序',
    starred: '收藏', mastered: '已斩单词',
    noMastered: '还没有已斩单词', noStarred: '还没有收藏单词', noLearned: '还没有学过的单词',
    masteredTip: '点击「斩」来斩杀单词吧！', starredTip: '点击星号收藏单词', learnedTip: '去学习页面开始吧',
    close: '关闭',
    // Settings
    myNativeLang: '我的母语', learningLang: '我要学的语言',
    switchConfirm: '确定切换？',
    switchNativeTitle: '切换母语？',
    switchTargetTitle: '切换学习语言？',
    switchDesc: '各语言组合的学习记录独立保存，随时可以切换回来。',
    cancel: '取消', confirm: '确定切换',
    // Category
    allLevels: '全部难度', levelPrefix: '难度',
    ok: '确认', skip: '斩',
    dKnow: '认识', dDontKnow: '不认识',
    categoryDone: '本节完成！', autoSwitching: '正在切换到其他分类…',
    loginDays: '累计登录 {n}天',
    devMode: '开发者模式：清除学习记录',
    devModeConfirm: '确定要清除所有学习记录吗？此操作不可撤销。',
  },
  en: {
    learn: 'Learn', wordlist: 'Words', settings: 'Settings',
    allDone: 'Great job!', reviewDone: 'Review complete!',
    reviewAll: 'All words reviewed!',
    allLearned: ' all learned!',
    restart: 'Start Over', backToList: 'Back to List',
    translating: 'Translating…',
    allWords: 'All words',
    learning: 'Learning', review: 'Review',
    timeOrder: 'By Time', randomOrder: 'Random',
    starred: 'Starred', mastered: 'Mastered',
    noMastered: 'No mastered words yet', noStarred: 'No starred words yet', noLearned: 'No learned words yet',
    masteredTip: 'Tap "Got it" to master words!', starredTip: 'Tap the star to save', learnedTip: 'Start learning now',
    close: 'Close',
    myNativeLang: 'My Native Language', learningLang: 'Language to Learn',
    switchConfirm: 'Confirm switch?',
    switchNativeTitle: 'Switch native language?',
    switchTargetTitle: 'Switch learning language?',
    switchDesc: 'Progress is saved independently for each language combination.',
    cancel: 'Cancel', confirm: 'Switch',
    allLevels: 'All Levels', levelPrefix: 'Level',
    ok: 'OK', skip: 'Got it',
    dKnow: 'Know', dDontKnow: "Don't know",
    categoryDone: 'Section complete!', autoSwitching: 'Switching to other words…',
    loginDays: 'Logged in {n} days',
    devMode: 'Dev Mode: Clear learning records',
    devModeConfirm: 'Clear all learning records? This cannot be undone.',
  },
  ja: {
    learn: '学習', wordlist: '単語帳', settings: '設定',
    allDone: 'すごい！', reviewDone: '復習完了！',
    reviewAll: '全ての単語を復習しました！',
    allLearned: '全て学習済み！',
    restart: 'やり直す', backToList: '単語帳に戻る',
    translating: '翻訳中…',
    allWords: '全ての単語',
    learning: '学習中の単語', review: '復習する',
    timeOrder: '時間順', randomOrder: 'ランダム',
    starred: 'お気に入り', mastered: '習得済み',
    noMastered: '習得済みの単語はまだありません', noStarred: 'お気に入りの単語はまだありません', noLearned: 'まだ学習した単語はありません',
    masteredTip: '「覚えた」で単語を習得しよう！', starredTip: '星をタップして保存', learnedTip: '学習を始めよう',
    close: '閉じる',
    myNativeLang: '母語', learningLang: '学びたい言語',
    switchConfirm: '切り替えますか？',
    switchNativeTitle: '母語を切り替えますか？',
    switchTargetTitle: '学習言語を切り替えますか？',
    switchDesc: '各言語の学習記録は独立して保存されます。',
    cancel: 'キャンセル', confirm: '切り替える',
    allLevels: '全レベル', levelPrefix: '難易度',
    ok: '確認', skip: '覚えた',
    dKnow: '知ってる', dDontKnow: '知らない',
    categoryDone: 'セクション完了！', autoSwitching: '他のカテゴリーに切り替えています…',
    loginDays: '累計ログイン {n}日',
    devMode: '開発者モード：学習記録を消去',
    devModeConfirm: '全ての学習記録を消去しますか？この操作は取り消せません。',
  },
};

// ── Category labels in each language ──
export const CATEGORY_LABELS = {
  zh: { all: '全部', animal: '动物', food: '食物', daily: '生活用品', nature: '自然', science: '科学', art: '艺术', landmark: '建筑', game: '游戏', people: '人物', myth: '神话', fashion: '服饰' },
  en: { all: 'All', animal: 'Animals', food: 'Food', daily: 'Daily', nature: 'Nature', science: 'Science', art: 'Art', landmark: 'Landmarks', game: 'Games', people: 'People', myth: 'Mythology', fashion: 'Fashion' },
  ja: { all: '全て', animal: '動物', food: '食べ物', daily: '日用品', nature: '自然', science: '科学', art: '芸術', landmark: '建築', game: 'ゲーム', people: '人物', myth: '神話', fashion: 'ファッション' },
};
