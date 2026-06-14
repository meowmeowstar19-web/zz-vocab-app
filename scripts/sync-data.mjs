#!/usr/bin/env node
// ============================================================================
// VocabWorkspace Data Sync
// ----------------------------------------------------------------------------
// Reads the 工厂 (data_prep) {WordList,PhraseList,category}.xlsx via the shared
// path key (Phase 3), regenerates src/data/{words,jaData,oralPhrases,categoryCovers}.js,
// compresses and moves images from updated_image/ to public/images/ (image wiring
// to the factory is reworked in publish-all, Phase 3C),
// archives processed originals, and (with --auto) git commits + pushes.
// ============================================================================

import XLSX from 'xlsx';
import sharp from 'sharp';
import {
  readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync,
  existsSync,
} from 'node:fs';
import { join, dirname, basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import { audioKey } from '../src/utils/audioKey.js';
import { hashedImageName, slugifyEn } from './imageName.mjs';
// 内容工厂：数据源 = VocabWorkspace 本仓库的 `word-data/` 正本 xlsx（唯一真相）。
// data_prep（工厂）只是草稿/生成区，经常半成品；发布时 publish-all 第①步把工厂
// 当前 xlsx「提升」进 word-data/，所以 word-data/ 永远是「最后一次发布的最终版」。
// 图片仍从工厂「已确认」桶取（生成产物，发布后压进 public/）。
import {
  IMAGES_WORD_DIR, IMAGES_MARKETING_DIR, EAGLE_INBOX_DIR,
} from '../../data_prep/scripts/paths.mjs';

// ── Paths ────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// 三个数据源 xlsx = 本仓库 word-data/ 的正本（按表头名读，列顺序无所谓）。
const WORD_DATA_DIR = join(ROOT, 'word-data');
const VOCAB_XLSX = join(WORD_DATA_DIR, 'WordList.xlsx');
const ORAL_XLSX = join(WORD_DATA_DIR, 'PhraseList.xlsx');
const DEV_XLSX = join(WORD_DATA_DIR, 'dev-单词.xlsx');
const CATEGORY_XLSX = join(WORD_DATA_DIR, 'category.xlsx');
// Phase 3：单词图只从工厂的「已确认」桶 Confirmed 取（用户拍板：以 Confirmed 为准）。
// 发布后原版图挪进工厂 eagle-inbox（待用户整批拖进 Eagle 存档）。
// 要加别的桶（如 新_Confirmed）只需往这个数组里加一行。
const IMG_IN_DIRS = [
  join(IMAGES_WORD_DIR, 'Confirmed'),
  join(IMAGES_MARKETING_DIR, 'Confirmed'),   // Phase 4: marketing 词图（World Cup / NBA …）
];
const IMG_OUT = join(ROOT, 'public', 'images');
const AUDIO_OUT = join(ROOT, 'public', 'assets', 'audio');
// Phase 3：已发布的原版图挪进工厂 eagle-inbox（用户整批拖进 Eagle 存档后清空）。
const PROCESSED_DIR = EAGLE_INBOX_DIR;
// Orphan images (words removed from Excel) are archived here — a local, gitignored
// safety net, NOT a published final, so it lives outside word-data/.
const DELETED_DIR = join(ROOT, '_deleted-images');
const SRC_DATA = join(ROOT, 'src', 'data');

// Phase 5: secret salt for hashed image filenames (read from .env.local, never
// shipped to the client). Set in main() before any word is read so readVocab,
// processImages and the cover map all produce the same hashed names.
let IMAGE_HASH_SALT = '';

// The salt is read in this priority order so the project folder can be freely
// renamed/moved/deleted without losing it:
//   1. IMAGE_HASH_SALT env var  (explicit override)
//   2. macOS Keychain           (primary store — lives outside the repo, iCloud-synced)
//   3. .env.local               (legacy fallback)
const KEYCHAIN_SALT_SERVICE = 'plushieword-image-hash-salt';

function readSaltFromKeychain() {
  if (process.platform !== 'darwin') return '';
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SALT_SERVICE, '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return ''; // not found in keychain
  }
}

function loadImageHashSalt() {
  if (process.env.IMAGE_HASH_SALT) return process.env.IMAGE_HASH_SALT;
  const fromKeychain = readSaltFromKeychain();
  if (fromKeychain) return fromKeychain;
  const envPath = join(ROOT, '.env.local');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^IMAGE_HASH_SALT=(.*)$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  }
  return '';
}

const imgName = (en) => hashedImageName(slugifyEn(en), IMAGE_HASH_SALT);

// Required content columns. A row must have every one of these filled to be
// emitted into the generated data files. Optional/legacy columns ("Image
// Prompt", "Subcategory", and "Level" for words) are intentionally excluded.
const VOCAB_REQUIRED_COLS = [
  'English', 'Example', 'Category',
  '英语音标', '单词中文翻译', '中文拼音', '例句中文翻译',
  '单词日语翻译', '日语音标', '例句日语翻译',
];
// Phase 4: the "marketing" tab holds hot-topic words (World Cup / NBA …).
// To go live a marketing word must clear the SAME bar as a core word: a Confirmed
// image PLUS the full 3-piece set (word + phonetic + example) in every language —
// i.e. it uses VOCAB_REQUIRED_COLS, NOT a relaxed gate. Marketing words that are
// still missing sentences/phonetics simply don't emit yet; they flow in
// automatically once the content (and image) is complete. (User rule 2026-06-05:
// 上线的单词一定要图 + 各语言三件套都齐全。)
// Sheet 名容错：用户随手重命名 tab（单词→core→word、WordMarketing→marketing）后仍能找到。
// 真实/规范名在前，旧名作 fallback。pickSheet 返回第一个存在的 worksheet（找不到返回 undefined）。
const CORE_SHEET_NAMES = ['word', 'core', '单词'];
const MARKETING_SHEET_NAMES = ['marketing', 'WordMarketing'];
function pickSheet(wb, names) {
  for (const n of names) if (wb.Sheets[n]) return wb.Sheets[n];
  return undefined;
}

// Phase 4 — PER-LANGUAGE availability (user rule 2026-06-05). A language is
// "live" for a word only when THAT language's own 3-piece set is present in the
// source: word + phonetic + example. Languages are INDEPENDENT — a word with
// complete zh/en/ja but only a bare word in Korean goes live in zh/en/ja and NOT
// Korean. The app currently ships en/zh/ja; when a new language is added to the
// app it gets its own 3 source columns and an entry here (+ langHelpers.LANGUAGES).
const LANG_PIECES = {
  en: ['en', 'ipa', 'sentence'],          // English / 英语音标 / Example
  zh: ['zh', 'pinyin', 'sentenceZh'],     // 单词中文翻译 / 中文拼音 / 例句中文翻译
  ja: ['ja', 'jaReading', 'jaSentence'],  // 单词日语翻译 / 日语音标 / 例句日语翻译
};
function wordLangs(entry) {
  return Object.keys(LANG_PIECES).filter(L =>
    LANG_PIECES[L].every(f => String(entry[f] || '').trim()));
}
// A vocab word ships when it has ≥2 live languages (so at least one of the
// cross-language modes can show it). The image filter in main() is the other
// half of the gate — 没图不上线.
const MIN_LIVE_LANGS = 2;
const PHRASE_REQUIRED_COLS = [
  'English', 'Example', 'Category', 'Level',
  '英语音标', '短语中文翻译', '中文拼音', '例句中文翻译',
  '短语日语翻译', '日语音标',
];
// Either spelling counts as the Japanese example sentence column for phrases.
const PHRASE_REQUIRED_ANY = [['例句日语翻译', '例句r日语翻译']];

function rowComplete(row, required, requireAny = []) {
  for (const c of required) {
    if (!String(row[c] || '').trim()) return false;
  }
  for (const group of requireAny) {
    if (!group.some(c => String(row[c] || '').trim())) return false;
  }
  return true;
}

const AUTO_PUSH = process.argv.includes('--auto');

// ── Mappings (Excel → code) ──────────────────────────────────────────────────
const VOCAB_CATEGORY_MAP = {
  // Current Excel categories (Title Case → lowercase slug)
  'Action':    'action',
  'Adjective': 'adjective',
  'Animal':    'animal',
  'Color':     'color',
  'Day':       'day',
  'Food':      'food',
  'Nature':    'nature',
  'Number':    'number',
  'Object':    'object',
  'People':    'people',
  'Place':     'place',
  'Time':      'time',
  'Transport': 'transport',
  // Legacy names (keep for backwards compat)
  'Adjectives': 'adjective',
  'Animals':    'animal',
  'Body':       'people',
  'Clothes':    'people',
  'Colors':     'color',
  'Items':      'object',
  'Numbers':    'number',
  'Places':     'place',
};

const LEVEL_MAP = { 1: 'beginner', 2: 'intermediate', 3: 'advanced' };

// Phrase category (PhraseList "Category" column, Chinese) → slug
const PHRASE_CATEGORY_MAP = {
  '寒暄': 'greeting',
  '回应': 'response',
  '生活': 'life',
  '感受': 'feeling',
  '社交': 'social',
};

// Oral category labels (3-lang) — kept in sync with PHRASE_CATEGORY_MAP keys
const ORAL_LABELS_DICT = {
  all:      { zh: '全部',   en: 'All',         ja: '全て' },
  greeting: { zh: '寒暄',   en: 'Greetings',   ja: '挨拶' },
  response: { zh: '回应',   en: 'Responses',   ja: '返事' },
  life:     { zh: '生活',   en: 'Life',        ja: '生活' },
  feeling:  { zh: '感受',   en: 'Feelings',    ja: '気持ち' },
  social:   { zh: '社交',   en: 'Social',      ja: '社交' },
};

// Multi-language category label dictionary.
// Known categories get proper translations; unknown ones fall back to Title Case English.
// To add translations for new categories: add an entry here and re-run sync.
const CATEGORY_LABELS_DICT = {
  all:       { zh: '全部',   en: 'All',        ja: '全て' },
  action:    { zh: '动作',   en: 'Actions',    ja: '動作' },
  adjective: { zh: '形容词', en: 'Adjectives', ja: '形容詞' },
  animal:    { zh: '动物',   en: 'Animals',    ja: '動物' },
  color:     { zh: '颜色',   en: 'Colors',     ja: '色' },
  day:       { zh: '星期',   en: 'Days',       ja: '曜日' },
  food:      { zh: '食物',   en: 'Food',       ja: '食べ物' },
  nature:    { zh: '自然',   en: 'Nature',     ja: '自然' },
  number:    { zh: '数字',   en: 'Numbers',    ja: '数字' },
  object:    { zh: '物品',   en: 'Objects',    ja: 'もの' },
  people:    { zh: '人物',   en: 'People',     ja: '人物' },
  place:     { zh: '地点',   en: 'Places',     ja: '場所' },
  time:      { zh: '时间',   en: 'Time',       ja: '時間' },
  transport: { zh: '交通',   en: 'Transport',  ja: '乗り物' },
  // Marketing topic categories (hot-topic vocab). Acronyms keep their casing.
  nba:       { zh: 'NBA',    en: 'NBA',        ja: 'NBA' },
};

function titleCase(s) {
  return String(s).replace(/(^|[-_\s])(\w)/g, (_, p, c) => (p === '' ? '' : ' ') + c.toUpperCase());
}

function labelFor(cat, lang) {
  return CATEGORY_LABELS_DICT[cat]?.[lang] || titleCase(cat);
}

const LEVEL_LABELS_ZH = {
  beginner: '初级',
  intermediate: '中级',
  advanced: '高级',
};

// Fallback cat covers if Excel has no "Cover For" marks (mirrors current hardcoded values)
const DEFAULT_VOCAB_COVERS = {
  adjective: 'good.jpg',
  animal:    'pig.jpg',
  body:      'eye.jpg',
  clothes:   'pants.jpg',
  food:      'mushroom.jpg',
};

const DEFAULT_ORAL_COVERS = {
  greeting: 'hand.jpg',
  response: 'talk.jpg',
  life:     'coffee.jpg',
  feeling:  'happy.jpg',
  social:   'friend.jpg',
};

// 进阶 (dev) category cover images — a vocab word's picture per tab. Tabs not
// listed here (e.g. a newly-added tab) fall back to a stable seeded pick in
// writeDevPhrasesJs, so every category always has a cover with zero extra config.
const DEFAULT_DEV_COVERS = {
  '日常口语': 'talk',
  '口语句型': 'book',
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const log = {
  info:    (m) => console.log(`\x1b[36m→\x1b[0m ${m}`),
  ok:      (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`),
  warn:    (m) => console.log(`\x1b[33m⚠\x1b[0m ${m}`),
  err:     (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`),
  section: (m) => console.log(`\n\x1b[1m\x1b[34m── ${m} ──\x1b[0m`),
};

// Emit a JS single-quoted string literal with proper escapes
function jsStr(s) {
  if (s == null) return "''";
  return "'" + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n') + "'";
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// ── Interactive prompt helper ────────────────────────────────────────────────
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// ── Duplicate detection & interactive removal ────────────────────────────────
// Reads the first sheet of `file`, finds rows where the value in `keyCol`
// (case-insensitive) appears more than once, and asks the user which row to
// keep for each group. Removes the rejected rows and writes back to the file.
// Returns true if the file was modified.
async function dedupCheck(file, keyCol, label) {
  if (!existsSync(file)) return false;
  const wb = XLSX.readFile(file);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (aoa.length < 2) return false;

  const header = aoa[0];
  const keyIdx = header.findIndex(h => String(h).trim() === keyCol);
  if (keyIdx < 0) {
    log.warn(`dedupCheck: column "${keyCol}" not found in ${file}`);
    return false;
  }

  // Group data rows (idx 1+) by lowercased key
  const groups = new Map(); // key → [{ rowIdx, row }]
  for (let i = 1; i < aoa.length; i++) {
    const k = String(aoa[i][keyIdx] || '').trim().toLowerCase();
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ rowIdx: i, row: aoa[i] });
  }
  const dupGroups = [...groups.entries()].filter(([, rows]) => rows.length > 1);
  if (dupGroups.length === 0) return false;

  log.section(`Duplicate check: ${label}`);
  log.warn(`Found ${dupGroups.length} duplicate "${keyCol}" value(s) in ${basename(file)}`);

  const toRemove = new Set(); // rowIdx values to delete

  for (const [key, rows] of dupGroups) {
    console.log(`\n  "${key}" appears ${rows.length} times:`);
    rows.forEach(({ rowIdx, row }, i) => {
      const preview = row.slice(0, Math.min(5, row.length))
        .map(c => String(c || '').replace(/\s+/g, ' ').slice(0, 60))
        .join(' | ');
      console.log(`    [${i + 1}] row ${rowIdx + 1}: ${preview}`);
    });
    const ans = await prompt(`  Keep which? (1-${rows.length}, "a"=keep all, "s"=skip all): `);
    const trimmed = ans.toLowerCase();
    if (trimmed === 'a') {
      console.log(`    → keeping all (no changes)`);
      continue;
    }
    if (trimmed === 's') {
      rows.forEach(({ rowIdx }) => toRemove.add(rowIdx));
      console.log(`    → removing all ${rows.length} rows`);
      continue;
    }
    const choice = parseInt(trimmed, 10);
    if (!Number.isInteger(choice) || choice < 1 || choice > rows.length) {
      log.warn(`    → invalid input "${ans}", keeping all`);
      continue;
    }
    rows.forEach(({ rowIdx }, i) => {
      if (i + 1 !== choice) toRemove.add(rowIdx);
    });
    console.log(`    → keeping [${choice}], removing the other ${rows.length - 1}`);
  }

  if (toRemove.size === 0) {
    log.info(`No rows removed.`);
    return false;
  }

  // Build new aoa skipping removed rows
  const newAoa = aoa.filter((_, i) => !toRemove.has(i));
  const newWs = XLSX.utils.aoa_to_sheet(newAoa);
  if (ws['!cols']) newWs['!cols'] = ws['!cols'];
  wb.Sheets[sheetName] = newWs;
  XLSX.writeFile(wb, file);
  log.ok(`Removed ${toRemove.size} duplicate row(s); saved ${basename(file)}`);
  return true;
}

// ── Read WordList.xlsx ───────────────────────────────────────────────────────
function readVocab() {
  log.section('Reading WordList.xlsx');
  if (!existsSync(VOCAB_XLSX)) throw new Error(`Missing file: ${VOCAB_XLSX}`);

  const wb = XLSX.readFile(VOCAB_XLSX);

  const words = [];
  const allRows = []; // all rows including those without sentences (for pinyin/phonetics)
  const unknownCats = new Set();
  let incomplete = 0;

  // Phase 4: read the "core" tab AND the "marketing" tab. Both share the
  // same column layout (Phase 2 merge), so one loop handles both — the only
  // difference is the tier. The completeness gate is identical and PER-LANGUAGE
  // (wordLangs / MIN_LIVE_LANGS): a word ships with whichever languages have a
  // full 3-piece set, independent of the others.
  const coreWs = pickSheet(wb, CORE_SHEET_NAMES) || wb.Sheets[wb.SheetNames[0]];
  const sources = [
    { ws: coreWs, isMarketing: false },
  ];
  const marketingWs = pickSheet(wb, MARKETING_SHEET_NAMES);
  if (marketingWs) {
    sources.push({ ws: marketingWs, isMarketing: true });
  }

  for (const src of sources) {
    const rows = XLSX.utils.sheet_to_json(src.ws, { defval: '' });

    for (const row of rows) {
      const en = String(row['English'] || '').trim();
      if (!en) continue;

      const rawCat = String(row['Category'] || '').trim();
      const cat = VOCAB_CATEGORY_MAP[rawCat] || rawCat.toLowerCase();
      // Don't warn on marketing topic categories — they're intentionally not in
      // VOCAB_CATEGORY_MAP (each hot topic is its own category key).
      if (!src.isMarketing && !VOCAB_CATEGORY_MAP[rawCat] && rawCat) unknownCats.add(rawCat);

      const lvlNum = Number(row['Level']) || 1;
      const lvl = LEVEL_MAP[lvlNum] || 'beginner';

      const sentence = String(row['Example'] || '').trim();

      // tier: core words come from the main tab; marketing words are 'specific'
      // when the "specific" switch column is filled, else 'themed'.
      const tier = src.isMarketing
        ? (String(row['specific'] || '').trim() ? 'specific' : 'themed')
        : 'core';

      const entry = {
        en,
        zh:          String(row['单词中文翻译'] || row['Chinese (中文)'] || '').trim(),
        category:    cat,
        level:       lvl,
        sentence,
        sentenceZh:  String(row['例句中文翻译'] || row['Example CN (例句中文)'] || '').trim(),
        img:         imgName(en),
        ja:          String(row['单词日语翻译'] || row['Japanese (日本語)'] || '').trim(),
        jaReading:   String(row['日语音标'] || row['Japanese Reading (日语音标)'] || '').trim(),
        jaSentence:  String(row['例句日语翻译'] || row['Example JP (例句日語)'] || '').trim(),
        pinyin:      String(row['中文拼音'] || row['Chinese Pinyin (拼音)'] || '').trim(),
        ipa:         String(row['英语音标'] || row['English IPA (音标)'] || '').trim(),
        tier,
        // concept: rare manual override to force-merge synonyms whose Chinese
        // translations differ (see project_content_factory_refactor). Blank 99.9%.
        concept:     String(row['concept'] || row['Concept'] || '').trim(),
        subcategory: String(row['Subcategory'] || '').trim(),
      };
      // langs: the languages this word is live in (per-language 3-piece gate).
      entry.langs = wordLangs(entry);

      allRows.push(entry);

      // Ship a word once ≥2 languages are live (so a cross-language mode exists).
      // Image presence is the other half of the gate, checked in main().
      if (entry.langs.length >= MIN_LIVE_LANGS) {
        words.push(entry);
      } else {
        incomplete++;
      }
    }
  }

  if (unknownCats.size > 0) {
    log.warn(`Unmapped vocab categories (add to VOCAB_CATEGORY_MAP in sync-data.mjs):`);
    unknownCats.forEach(c => console.log(`     · ${c}`));
  }
  if (incomplete > 0) {
    log.info(`Skipped ${incomplete} vocab row(s) with <${MIN_LIVE_LANGS} live languages (need a full 3-piece set in ≥${MIN_LIVE_LANGS} languages)`);
  }

  log.ok(`Parsed ${words.length} shippable vocab entries (${allRows.length} total rows)`);
  return { words, allRows };
}

// ── Sync category.xlsx — source of truth for covers + display order ──────────
// Sheet "Categories"       — vocab categories. Row order = display order.
//                            Columns: "Category" (Title Case), "Cover Image Word"
// Sheet "Phrase Categories" — oral categories. Same column structure.
// If a new category appears in the data that isn't in the sheet yet, it gets
// appended automatically so the user can reorder / update it.
function ensureCategoryXlsx(words, phrases) {
  log.section('Syncing category.xlsx (covers + order)');

  // Build lookup: category → list of word en
  const wordsByCat = {};
  for (const w of words) {
    if (!wordsByCat[w.category]) wordsByCat[w.category] = [];
    wordsByCat[w.category].push(w.en);
  }
  const allWordEns = new Set(words.map(w => w.en));

  const vocabCatsInData = new Set(words.map(w => w.category));
  const oralCatsInData  = new Set(phrases.map(p => p.category));

  if (!existsSync(CATEGORY_XLSX)) {
    log.warn('category.xlsx not found — falling back to DEFAULT_VOCAB_COVERS / DEFAULT_ORAL_COVERS');
    const covers = { vocab: {}, oral: {}, vocabOrder: [], oralOrder: [] };
    for (const [k, v] of Object.entries(DEFAULT_VOCAB_COVERS)) { covers.vocab[k] = v; covers.vocabOrder.push(k); }
    for (const [k, v] of Object.entries(DEFAULT_ORAL_COVERS))  { covers.oral[k]  = v; covers.oralOrder.push(k); }
    return covers;
  }

  const wb = XLSX.readFile(CATEGORY_XLSX);
  let changed = false;
  const warnings = [];

  // Stable pseudo-random pick by category name (same cat → same word across runs)
  function seededPick(arr, seed) {
    if (!arr || arr.length === 0) return null;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return arr[h % arr.length];
  }

  // ── Vocab: read from "Categories" sheet ──────────────────────────────────
  const vocabOrdered = [];
  if (wb.Sheets['Categories']) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Categories'], { defval: '' });
    for (const row of rows) {
      const rawCat = String(row['Category'] || '').trim();
      const word   = String(row['Cover Image Word'] || '').trim();
      if (!rawCat) continue;
      const cat = VOCAB_CATEGORY_MAP[rawCat] || rawCat.toLowerCase();
      vocabOrdered.push({ cat, word, rawCat });
    }
  }

  const vocabOut = [];
  const vocabSeen = new Set();
  for (const { cat, word } of vocabOrdered) {
    if (!vocabCatsInData.has(cat)) {
      warnings.push(`Categories: skipping "${cat}" (no words in data)`);
      continue;
    }
    if (vocabSeen.has(cat)) {
      warnings.push(`Categories: duplicate row for "${cat}" — keeping first`);
      continue;
    }
    if (word && !wordsByCat[cat]?.includes(word)) {
      warnings.push(`Categories: cover word "${word}" not in category "${cat}" — please fix in category.xlsx`);
    }
    vocabOut.push({ cat, word });
    vocabSeen.add(cat);
  }
  // Append any data categories not yet in the sheet
  const dataOrderVocab = [];
  const vdataSeen = new Set();
  for (const w of words) if (!vdataSeen.has(w.category)) { dataOrderVocab.push(w.category); vdataSeen.add(w.category); }
  for (const cat of dataOrderVocab) {
    if (vocabSeen.has(cat)) continue;
    const def = DEFAULT_VOCAB_COVERS[cat];
    const word = def ? def.replace(/\.jpg$/, '') : seededPick(wordsByCat[cat], cat);
    vocabOut.push({ cat, word: word || '' });
    vocabSeen.add(cat);
    changed = true;
    log.warn(`Categories: new category "${cat}" — appending to category.xlsx with cover "${word}"`);
  }

  // ── Oral: read from "Phrase Categories" sheet ─────────────────────────────
  if (!wb.Sheets['Phrase Categories']) changed = true; // sheet missing → will create

  const oralOrdered = [];
  if (wb.Sheets['Phrase Categories']) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Phrase Categories'], { defval: '' });
    for (const row of rows) {
      const cat  = String(row['Category'] || '').trim();
      const word = String(row['Cover Image Word'] || '').trim();
      if (!cat) continue;
      oralOrdered.push({ cat, word });
    }
  }

  const oralOut = [];
  const oralSeen = new Set();
  for (const { cat, word } of oralOrdered) {
    if (!oralCatsInData.has(cat)) {
      warnings.push(`Phrase Categories: skipping "${cat}" (no phrases in data)`);
      continue;
    }
    if (oralSeen.has(cat)) {
      warnings.push(`Phrase Categories: duplicate row for "${cat}" — keeping first`);
      continue;
    }
    if (word && !allWordEns.has(word)) {
      warnings.push(`Phrase Categories: cover word "${word}" is not a vocab word — please fix in category.xlsx`);
    }
    oralOut.push({ cat, word });
    oralSeen.add(cat);
  }
  // Append any oral categories not yet in the sheet
  const dataOrderOral = [];
  const odataSeen = new Set();
  for (const p of phrases) if (!odataSeen.has(p.category)) { dataOrderOral.push(p.category); odataSeen.add(p.category); }
  for (const cat of dataOrderOral) {
    if (oralSeen.has(cat)) continue;
    const def = DEFAULT_ORAL_COVERS[cat];
    const word = def ? def.replace(/\.jpg$/, '') : seededPick([...allWordEns], `oral-${cat}`);
    oralOut.push({ cat, word: word || '' });
    oralSeen.add(cat);
    changed = true;
    log.warn(`Phrase Categories: new category "${cat}" — appending to category.xlsx with cover "${word}"`);
  }

  warnings.forEach(w => log.warn(w));

  // ── Write back to category.xlsx if anything changed ───────────────────────
  if (changed) {
    const lockFile = join(dirname(CATEGORY_XLSX), `~$${basename(CATEGORY_XLSX)}`);
    if (existsSync(lockFile)) {
      log.err(`category.xlsx is open in Excel — close it and re-run`);
      throw new Error('Excel has category.xlsx open — close it and re-run');
    }

    // Vocab: append new rows to the existing "Categories" sheet (preserves all other columns)
    if (wb.Sheets['Categories']) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets['Categories'], { header: 1, defval: '' });
      const header = aoa[0] || [];
      const catColIdx   = header.findIndex(h => String(h).trim() === 'Category');
      const coverColIdx = header.findIndex(h => String(h).trim() === 'Cover Image Word');
      const sheetCats = new Set(
        aoa.slice(1).map(row => {
          const raw = String(row[catColIdx] || '').trim();
          return VOCAB_CATEGORY_MAP[raw] || raw.toLowerCase();
        })
      );
      for (const { cat, word } of vocabOut) {
        if (sheetCats.has(cat)) continue;
        const newRow = new Array(header.length).fill('');
        if (catColIdx   >= 0) newRow[catColIdx]   = cat;
        if (coverColIdx >= 0) newRow[coverColIdx] = word;
        aoa.push(newRow);
      }
      wb.Sheets['Categories'] = XLSX.utils.aoa_to_sheet(aoa);
    }

    // Oral: fully write "Phrase Categories" sheet
    const oralRows  = oralOut.map(({ cat, word }) => ({ 'Category': cat, 'Cover Image Word': word }));
    const oralSheet = XLSX.utils.json_to_sheet(oralRows, { header: ['Category', 'Cover Image Word'] });
    oralSheet['!cols'] = [{ wch: 20 }, { wch: 18 }];
    wb.Sheets['Phrase Categories'] = oralSheet;
    if (!wb.SheetNames.includes('Phrase Categories')) wb.SheetNames.push('Phrase Categories');

    XLSX.writeFile(wb, CATEGORY_XLSX);
    log.ok(`Updated category.xlsx (${vocabOut.length} vocab + ${oralOut.length} phrase categories)`);
  } else {
    log.ok(`category.xlsx up to date (${vocabOut.length} vocab + ${oralOut.length} phrase categories)`);
  }

  // Build final covers map + ordered category lists for consumers
  const covers = { vocab: {}, oral: {}, vocabOrder: [], oralOrder: [] };
  for (const { cat, word } of vocabOut) {
    covers.vocab[cat] = word ? imgName(word) : null;
    covers.vocabOrder.push(cat);
  }
  for (const { cat, word } of oralOut) {
    covers.oral[cat] = word ? imgName(word) : null;
    covers.oralOrder.push(cat);
  }
  return covers;
}

// ── Read PhraseList.xlsx ─────────────────────────────────────────────────────
function readOral() {
  log.section('Reading PhraseList.xlsx');
  if (!existsSync(ORAL_XLSX)) throw new Error(`Missing file: ${ORAL_XLSX}`);

  const wb = XLSX.readFile(ORAL_XLSX);
  // PhraseList 主表：规范名 core；旧名「口语」作 fallback；都没有再退第一个 sheet。
  const sheetName = ['core', '口语'].find(n => wb.SheetNames.includes(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const phrases = [];
  const incompleteRows = [];     // rows with blank required columns
  const unknownCats = new Map(); // rawCat → [english]

  // Japanese sentence column header is "例句r日语翻译" (typo in source); fall back
  // to "例句日语翻译" if ever fixed.
  const pickJaSentence = (row) =>
    String(row['例句r日语翻译'] || row['例句日语翻译'] || '').trim();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const en = String(row['English'] || '').trim();
    if (!en) continue;

    if (!rowComplete(row, PHRASE_REQUIRED_COLS, PHRASE_REQUIRED_ANY)) {
      incompleteRows.push({ rowNum: i + 2, en });
      continue;
    }

    const rawCat = String(row['Category'] || '').trim();
    const cat = PHRASE_CATEGORY_MAP[rawCat];
    if (!cat) {
      if (!unknownCats.has(rawCat)) unknownCats.set(rawCat, []);
      unknownCats.get(rawCat).push(en);
      continue;
    }

    phrases.push({
      en,
      zh:         String(row['短语中文翻译'] || '').trim(),
      category:   cat,
      sentence:   String(row['Example'] || '').trim(),
      sentenceZh: String(row['例句中文翻译'] || '').trim(),
      ja:         String(row['短语日语翻译'] || '').trim(),
      jaSentence: pickJaSentence(row),
      ipa:        String(row['英语音标'] || '').trim(),
      pinyin:     String(row['中文拼音'] || '').trim(),
      jaReading:  String(row['日语音标'] || '').trim(),
    });
  }

  if (incompleteRows.length > 0) {
    log.warn(`${incompleteRows.length} phrase row(s) skipped — one or more required columns blank:`);
    incompleteRows.forEach(({ rowNum, en }) => console.log(`     · Row ${rowNum}: "${en}"`));
  }
  if (unknownCats.size > 0) {
    log.warn(`Unmapped phrase categories (add to PHRASE_CATEGORY_MAP in sync-data.mjs):`);
    for (const [cat, ens] of unknownCats) {
      console.log(`     · "${cat}" (${ens.length} phrase${ens.length > 1 ? 's' : ''}, e.g. "${ens[0]}")`);
    }
  }

  log.ok(`Parsed ${phrases.length} complete phrases`);
  return phrases;
}

// ── Read dev-单词.xlsx (进阶 — personal, whitelist-only) ─────────────────────
// Every Excel tab/sheet = one category; its KEY and display LABEL are the sheet
// name itself, so adding a tab in Excel auto-creates a category with zero code
// changes (user rule: "每个 tab 算一个分类，分类就叫这个名字"). The gate is
// intentionally minimal: a row ships with just 英语词组 + 中文翻译. 英语例句 is
// optional (the 口语句型 tab doesn't even have that column). No audio, no
// phonetics, no per-word images. Surfaced zh→en only, behind the dev whitelist.
function readDevPhrases() {
  log.section('Reading dev-单词.xlsx (进阶)');
  if (!existsSync(DEV_XLSX)) {
    log.info('dev-单词.xlsx not found — skipping 进阶 phrases');
    return { phrases: [], categories: [] };
  }

  const wb = XLSX.readFile(DEV_XLSX);
  const phrases = [];
  const categories = []; // sheet names, in workbook order, that have ≥1 shippable row
  let skipped = 0;

  // Header tolerance: tabs are hand-made and their column headers vary (e.g. the
  // English-word column is sometimes 英语词组, the Chinese column is 中文翻译 on some
  // tabs and 中文词组翻译 on others). Read each field by trying a small alias list so
  // renaming/varying a header never silently drops a whole tab again.
  const pick = (row, aliases) => {
    for (const a of aliases) { const v = String(row[a] || '').trim(); if (v) return v; }
    return '';
  };
  const EN_COLS = ['英语词组', '英语', 'English'];
  const ZH_COLS = ['中文翻译', '中文词组翻译', '中文', 'Chinese'];
  const SENT_COLS = ['英语例句', '例句', 'Example'];
  const SENT_ZH_COLS = ['中文例句翻译', '例句中文翻译', '中文例句', 'Example CN'];

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
    const dataRows = rows.filter(r => pick(r, EN_COLS) || pick(r, ZH_COLS));
    let count = 0;
    for (const row of rows) {
      const en = pick(row, EN_COLS);
      const zh = pick(row, ZH_COLS);
      if (!en || !zh) { if (en || zh) skipped++; continue; } // need BOTH to ship
      phrases.push({
        en, zh,
        category: sheetName,
        sentence: pick(row, SENT_COLS), // optional — '' if absent
        sentenceZh: pick(row, SENT_ZH_COLS), // optional — '' if absent
      });
      count++;
    }
    if (count > 0) { categories.push(sheetName); log.ok(`  ${sheetName.padEnd(8)} ${count} phrase(s)`); }
    // Loud guard: a tab full of rows that produced ZERO phrases almost always
    // means a header mismatch (the silent-drop bug). Surface it instead of hiding.
    else if (dataRows.length > 0) {
      log.warn(`Tab "${sheetName}" has ${dataRows.length} data row(s) but 0 shipped — check column headers (need ${EN_COLS[0]} + ${ZH_COLS[0]})`);
    }
  }

  if (skipped > 0) log.info(`Skipped ${skipped} dev row(s) missing 英语词组 or 中文翻译`);
  log.ok(`Parsed ${phrases.length} 进阶 phrases across ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}`);
  return { phrases, categories };
}

// ── Filter phrases without complete pre-recorded audio ───────────────────────
// A phrase is only emitted if mp3 files exist in public/assets/audio/{en,zh,ja}/
// for the audioKey of that phrase's text in each language.
function filterPhrasesWithAudio(phrases) {
  const kept = [];
  const dropped = [];
  for (const p of phrases) {
    const enKey = audioKey(p.en, 'en');
    const zhKey = audioKey(p.zh, 'zh');
    const jaKey = audioKey(p.ja, 'ja');
    const enOk = enKey && existsSync(join(AUDIO_OUT, 'en', `${enKey}.mp3`));
    const zhOk = zhKey && existsSync(join(AUDIO_OUT, 'zh', `${zhKey}.mp3`));
    const jaOk = jaKey && existsSync(join(AUDIO_OUT, 'ja', `${jaKey}.mp3`));
    if (enOk && zhOk && jaOk) {
      kept.push(p);
    } else {
      const missing = [!enOk && 'en', !zhOk && 'zh', !jaOk && 'ja'].filter(Boolean).join(',');
      dropped.push({ en: p.en, missing });
    }
  }
  if (dropped.length > 0) {
    log.warn(`${dropped.length} phrase(s) skipped — missing audio:`);
    dropped.forEach(({ en, missing }) => console.log(`     · "${en}" (missing: ${missing})`));
  }
  return kept;
}

// Assign a stable, collision-safe id to every word (build-time).
// id = slug(en) — identical to the previous runtime formula, so existing words
// keep their ids byte-for-byte. Disambiguation only kicks in when two words
// share an English spelling but mean different things (different Chinese), e.g.
// bat/蝙蝠 vs bat/球棒 → "bat" and "bat-2". The representative tier (core) keeps
// the clean base id; same en + same zh = same concept = same id (intentional
// merge, e.g. player in both People and World Cup categories).
function assignWordIds(words) {
  const byBase = new Map(); // base slug → [{ key, id }] per distinct concept
  // Process core tier first so core entries keep the clean base id (stable sort).
  const order = [...words].sort((a, b) => (a.tier === 'core' ? 0 : 1) - (b.tier === 'core' ? 0 : 1));
  for (const w of order) {
    const base = slugifyEn(w.en);
    const key = `${w.en.toLowerCase().trim()}|${w.zh.trim()}`;
    let group = byBase.get(base);
    if (!group) { group = []; byBase.set(base, group); }
    const existing = group.find(g => g.key === key);
    if (existing) { w.id = existing.id; continue; }
    const id = group.length === 0 ? base : `${base}-${group.length + 1}`;
    group.push({ key, id });
    w.id = id;
  }
}

// ── Generate src/data/words.js ──────────────────────────────────────────────
// buildWordsJs returns the file SOURCE (pure, side-effect free) so it can be
// unit-tested with synthetic data; writeWordsJs wraps it with the disk write.
function buildWordsJs(words, catOrder) {
  assignWordIds(words);
  // catOrder: explicit category order from "Categories" sheet row order in category.xlsx.
  // Append any straggler categories (in data but missing from catOrder) at the end.
  const catsInOrder = [];
  const seen = new Set();
  for (const c of (catOrder || [])) {
    if (words.some(w => w.category === c) && !seen.has(c)) { catsInOrder.push(c); seen.add(c); }
  }
  for (const w of words) if (!seen.has(w.category)) { catsInOrder.push(w.category); seen.add(w.category); }

  // Sort words by catsInOrder so the emitted array mirrors the sheet order
  const catIndex = Object.fromEntries(catsInOrder.map((c, i) => [c, i]));
  const orderedWords = [...words].sort((a, b) => (catIndex[a.category] ?? 999) - (catIndex[b.category] ?? 999));

  // Category labels (Chinese, for words.js default display)
  const labels = { all: labelFor('all', 'zh') };
  for (const k of catsInOrder) labels[k] = labelFor(k, 'zh');

  let out = '';
  out += `// AUTO-GENERATED by scripts/sync-data.mjs — do not edit by hand\n`;
  out += `// Source: data_prep/WordList.xlsx\n`;
  out += `// Last synced: ${new Date().toISOString()}\n\n`;

  out += `// Category labels for UI\n`;
  out += `export const categoryLabels = {\n`;
  for (const [k, v] of Object.entries(labels)) out += `  ${k}: ${jsStr(v)},\n`;
  out += `};\n\n`;

  out += `export const levelLabels = {\n`;
  for (const [k, v] of Object.entries(LEVEL_LABELS_ZH)) out += `  ${k}: ${jsStr(v)},\n`;
  out += `};\n\n`;

  out += `// Format: [img, en, zh, category, level, sentence, sentenceZh, tier, concept, subcategory, id, langs]\n`;
  out += `// img is a hashed, unguessable filename (Phase 5). id is assigned at build\n`;
  out += `// time (= slug(en), de-duplicated) so renaming images never changes ids.\n`;
  out += `// tier: 'core' (main word list) | 'themed' (marketing, shown everywhere) |\n`;
  out += `//       'specific' (marketing names/events — only in their own category).\n`;
  out += `// langs: languages this word is live in (per-language 3-piece gate); a\n`;
  out += `//        language pair shows the word only if BOTH its langs are present.\n`;
  out += `const raw = [\n`;
  let lastCat = null;
  for (const w of orderedWords) {
    if (w.category !== lastCat) {
      if (lastCat !== null) out += `\n`;
      out += `  // ===== ${w.category.toUpperCase()} ${labelFor(w.category, 'zh')} =====\n`;
      lastCat = w.category;
    }
    out += `  [${[
      jsStr(w.img),
      jsStr(w.en),
      jsStr(w.zh),
      jsStr(w.category),
      jsStr(w.level),
      jsStr(w.sentence),
      jsStr(w.sentenceZh),
      jsStr(w.tier),
      jsStr(w.concept),
      jsStr(w.subcategory),
      jsStr(w.id),
      JSON.stringify(w.langs || []),
    ].join(', ')}],\n`;
  }
  out += `];\n\n`;

  out += `// Process raw data into word objects\n`;
  out += `const wordsOrdered = raw.map(([img, en, zh, category, level, sentence, sentenceZh, tier, concept, subcategory, id, langs]) => ({\n`;
  out += `  id, en, zh, category, level, sentence, sentenceZh, img, tier, concept, subcategory, langs,\n`;
  out += `}));\n\n`;

  out += `// Seeded shuffle so order is stable per session but randomized across sessions\n`;
  out += `function shuffleArray(arr) {\n`;
  out += `  const a = [...arr];\n`;
  out += `  for (let i = a.length - 1; i > 0; i--) {\n`;
  out += `    const j = Math.floor(Math.random() * (i + 1));\n`;
  out += `    [a[i], a[j]] = [a[j], a[i]];\n`;
  out += `  }\n`;
  out += `  return a;\n`;
  out += `}\n\n`;

  out += `// all-pool: the words shown under the "all" scope. Excludes the 'specific'\n`;
  out += `// tier (names/events live only in their own category) and de-dups by concept\n`;
  out += `// — concept override if present, else English+Chinese. The representative\n`;
  out += `// prefers the 'core' tier. Category pools keep the FULL \`words\` list\n`;
  out += `// (marketing included, no de-dup).\n`;
  out += `function conceptKey(w) {\n`;
  out += `  return w.concept || (w.en.toLowerCase().trim() + '|' + w.zh.trim());\n`;
  out += `}\n`;
  out += `function buildAllPool(list) {\n`;
  out += `  const rep = new Map();\n`;
  out += `  for (const w of list) {\n`;
  out += `    if (w.tier === 'specific') continue;\n`;
  out += `    const k = conceptKey(w);\n`;
  out += `    const cur = rep.get(k);\n`;
  out += `    if (!cur) { rep.set(k, w); continue; }\n`;
  out += `    if (cur.tier !== 'core' && w.tier === 'core') rep.set(k, w);\n`;
  out += `  }\n`;
  out += `  return list.filter(w => w.tier !== 'specific' && rep.get(conceptKey(w)) === w);\n`;
  out += `}\n\n`;

  out += `export const words = wordsOrdered;\n`;
  out += `export const wordsShuffled = shuffleArray(wordsOrdered);\n`;
  out += `export const wordsAllPool = buildAllPool(wordsOrdered);\n`;
  out += `export const wordsAllPoolShuffled = shuffleArray(wordsAllPool);\n`;
  out += `export const categories = ['all', ...Object.keys(categoryLabels).filter(k => k !== 'all')];\n`;

  return out;
}

function writeWordsJs(words, catOrder) {
  const out = buildWordsJs(words, catOrder);
  writeFileSync(join(SRC_DATA, 'words.js'), out);
  log.ok(`Wrote src/data/words.js (${words.length} entries)`);
}

// ── Concept de-dup summary ──────────────────────────────────────────────────
// Surfaces (does NOT change) what buildAllPool already does: 2+ non-'specific'
// words sharing a conceptKey collapse to ONE card in the "all" pool — i.e. only
// one of them shows up. Same rule as the emitted conceptKey() above:
// concept override if set, else English+Chinese. This print replaces the retired
// data_prep/scripts/report_concepts.py so the de-dup rule lives in ONE place.
//   · same en + DIFFERENT zh (bat/球棒 vs bat/蝙蝠) → different keys → both ship
//   · same en + SAME zh      (player/选手 ×2)        → same key → collapses to 1
function reportConceptMerges(words) {
  const conceptKey = (w) => w.concept || (w.en.toLowerCase().trim() + '|' + w.zh.trim());
  const groups = new Map();
  for (const w of words) {
    if (w.tier === 'specific') continue;
    const k = conceptKey(w);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  const merged = [...groups.values()].filter(g => g.length >= 2);
  if (merged.length === 0) {
    log.ok('Concept de-dup: no duplicates — every word ships as its own card');
    return;
  }
  const rows = merged.reduce((n, g) => n + g.length, 0);
  log.warn(`Concept de-dup: ${merged.length} group(s) collapse to 1 card each (${rows} rows → ${merged.length} cards):`);
  for (const g of merged) {
    console.log(`     · ${g[0].en} (${g[0].zh}) ×${g.length} → 1`);
  }
}

// ── Generate src/data/jaData.js ─────────────────────────────────────────────
function writeJaDataJs(words) {
  let out = '';
  out += `// AUTO-GENERATED by scripts/sync-data.mjs — do not edit by hand\n`;
  out += `// Source: data_prep/WordList.xlsx\n`;
  out += `// Format: { [word.en]: { ja, reading?, sentence } }\n`;
  out += `// - ja: Japanese word to display\n`;
  out += `// - reading: romaji (shown as phonetic under the word)\n`;
  out += `// - sentence: example sentence in Japanese\n\n`;
  out += `export const jaData = {\n`;

  let count = 0;
  for (const w of words) {
    if (!w.ja && !w.jaSentence) continue;
    const parts = [];
    if (w.ja)         parts.push(`ja: ${jsStr(w.ja)}`);
    if (w.jaReading)  parts.push(`reading: ${jsStr(w.jaReading)}`);
    if (w.jaSentence) parts.push(`sentence: ${jsStr(w.jaSentence)}`);
    out += `  ${jsStr(w.en)}: { ${parts.join(', ')} },\n`;
    count++;
  }
  out += `};\n`;

  writeFileSync(join(SRC_DATA, 'jaData.js'), out);
  log.ok(`Wrote src/data/jaData.js (${count} entries)`);
}

// ── Generate src/data/oralPhrases.js ────────────────────────────────────────
function writeOralPhrasesJs(phrases, catOrder) {
  // catOrder: explicit category order from "Phrase Categories" sheet row order in category.xlsx.
  const catsInOrder = [];
  const seen = new Set();
  for (const c of (catOrder || [])) {
    if (phrases.some(p => p.category === c) && !seen.has(c)) { catsInOrder.push(c); seen.add(c); }
  }
  for (const p of phrases) if (!seen.has(p.category)) { catsInOrder.push(p.category); seen.add(p.category); }

  const catIndex = Object.fromEntries(catsInOrder.map((c, i) => [c, i]));
  const orderedPhrases = [...phrases].sort((a, b) => (catIndex[a.category] ?? 999) - (catIndex[b.category] ?? 999));

  let out = '';
  out += `// AUTO-GENERATED by scripts/sync-data.mjs — do not edit by hand\n`;
  out += `// Source: data_prep/PhraseList.xlsx\n`;
  out += `// Format: [english, chinese, category, sentence, sentenceZh, ja, jaSentence, ipa, pinyin, jaReading]\n\n`;

  out += `const raw = [\n`;
  for (const p of orderedPhrases) {
    out += `  [${[
      jsStr(p.en),
      jsStr(p.zh),
      jsStr(p.category),
      jsStr(p.sentence),
      jsStr(p.sentenceZh),
      jsStr(p.ja || ''),
      jsStr(p.jaSentence || ''),
      jsStr(p.ipa || ''),
      jsStr(p.pinyin || ''),
      jsStr(p.jaReading || ''),
    ].join(', ')}],\n`;
  }
  out += `];\n\n`;

  out += `// Process into objects with stable IDs\n`;
  out += `function makeId(en) {\n`;
  out += `  return 'oral-' + en.toLowerCase().replace(/['\\u2019]+/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n`;
  out += `}\n\n`;
  out += `export const oralPhrases = raw.map(([en, zh, category, sentence, sentenceZh, ja, jaSentence, ipa, pinyin, jaReading]) => ({\n`;
  out += `  id: makeId(en),\n`;
  out += `  en, zh, category,\n`;
  out += `  img: null,\n`;
  out += `  level: 'oral',\n`;
  out += `  sentence, sentenceZh,\n`;
  out += `  ja, jaSentence,\n`;
  out += `  ipa, pinyin, jaReading,\n`;
  out += `}));\n\n`;
  out += `function shuffleArray(arr) {\n`;
  out += `  const a = [...arr];\n`;
  out += `  for (let i = a.length - 1; i > 0; i--) {\n`;
  out += `    const j = Math.floor(Math.random() * (i + 1));\n`;
  out += `    [a[i], a[j]] = [a[j], a[i]];\n`;
  out += `  }\n`;
  out += `  return a;\n`;
  out += `}\n\n`;
  out += `export const oralPhrasesShuffled = shuffleArray(oralPhrases);\n`;
  out += `// Category order: mirrors "Phrase Categories" sheet row order in category.xlsx\n`;
  out += `export const oralCategories = [${['all', ...catsInOrder].map(jsStr).join(', ')}];\n\n`;

  out += `// Category labels — mirrors ORAL_LABELS_DICT + catsInOrder in sync-data.mjs\n`;
  out += `export const ORAL_CATEGORY_LABELS = {\n`;
  const orderedKeys = ['all', ...catsInOrder];
  for (const lang of ['zh', 'en', 'ja']) {
    const pairs = orderedKeys.map(k => {
      const label = ORAL_LABELS_DICT[k]?.[lang] || titleCase(k);
      return `${k}: ${jsStr(label)}`;
    });
    out += `  ${lang}: { ${pairs.join(', ')} },\n`;
  }
  out += `};\n`;

  writeFileSync(join(SRC_DATA, 'oralPhrases.js'), out);
  log.ok(`Wrote src/data/oralPhrases.js (${phrases.length} entries)`);
}

// ── Generate src/data/devPhrases.js (进阶 — whitelist-only) ──────────────────
// `words` here is the final image-filtered vocab list, so any cover pick is
// guaranteed to have an image on disk.
function writeDevPhrasesJs(devPhrases, devCats, words) {
  // Covers: each category → a vocab word's hashed image. Prefer the curated
  // DEFAULT_DEV_COVERS word; fall back to a stable seeded pick for new tabs.
  const wordEns = words.map(w => w.en);
  const wordEnSet = new Set(wordEns);
  const seededPick = (seed) => {
    if (wordEns.length === 0) return null;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return wordEns[h % wordEns.length];
  };
  const covers = {};
  for (const cat of devCats) {
    let cw = DEFAULT_DEV_COVERS[cat];
    if (!cw || !wordEnSet.has(cw)) cw = seededPick(`dev-${cat}`);
    if (cw) covers[cat] = imgName(cw);
  }

  // Order phrases by category (sheet order)
  const catIndex = Object.fromEntries(devCats.map((c, i) => [c, i]));
  const ordered = [...devPhrases].sort((a, b) => (catIndex[a.category] ?? 999) - (catIndex[b.category] ?? 999));

  let out = '';
  out += `// AUTO-GENERATED by scripts/sync-data.mjs — do not edit by hand\n`;
  out += `// Source: word-data/dev-单词.xlsx (进阶 — personal study list, whitelist-only)\n`;
  out += `// Each Excel tab = one category (key + label = the tab name). Ships on\n`;
  out += `// 英语词组 + 中文翻译 alone; 英语例句 / 中文例句翻译 optional; no audio/phonetics/word images.\n`;
  out += `// Format: [english, chinese, category, sentence, sentenceZh]\n\n`;

  out += `const raw = [\n`;
  let lastCat = null;
  for (const p of ordered) {
    if (p.category !== lastCat) {
      if (lastCat !== null) out += `\n`;
      out += `  // ===== ${p.category} =====\n`;
      lastCat = p.category;
    }
    out += `  [${[jsStr(p.en), jsStr(p.zh), jsStr(p.category), jsStr(p.sentence || ''), jsStr(p.sentenceZh || '')].join(', ')}],\n`;
  }
  out += `];\n\n`;

  out += `function makeId(en) {\n`;
  out += `  return 'dev-' + en.toLowerCase().replace(/['\\u2019]+/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n`;
  out += `}\n\n`;
  out += `export const devPhrases = raw.map(([en, zh, category, sentence, sentenceZh]) => ({\n`;
  out += `  id: makeId(en),\n`;
  out += `  en, zh, category,\n`;
  out += `  img: null,\n`;
  out += `  level: 'dev',\n`;
  out += `  sentence: sentence || '', sentenceZh: sentenceZh || '',\n`;
  out += `  ja: null, jaSentence: null,\n`;
  out += `  ipa: '', pinyin: '', jaReading: null,\n`;
  out += `}));\n\n`;
  out += `function shuffleArray(arr) {\n`;
  out += `  const a = [...arr];\n`;
  out += `  for (let i = a.length - 1; i > 0; i--) {\n`;
  out += `    const j = Math.floor(Math.random() * (i + 1));\n`;
  out += `    [a[i], a[j]] = [a[j], a[i]];\n`;
  out += `  }\n`;
  out += `  return a;\n`;
  out += `}\n\n`;
  out += `export const devPhrasesShuffled = shuffleArray(devPhrases);\n`;
  out += `export const devCategories = [${['all', ...devCats].map(jsStr).join(', ')}];\n\n`;

  out += `// Labels: the tab name shown verbatim in every language (进阶 is zh→en only).\n`;
  out += `export const DEV_CATEGORY_LABELS = {\n`;
  for (const lang of ['zh', 'en', 'ja']) {
    const allLabel = lang === 'zh' ? '全部' : lang === 'en' ? 'All' : '全て';
    const pairs = [`all: ${jsStr(allLabel)}`, ...devCats.map(c => `${jsStr(c)}: ${jsStr(c)}`)];
    out += `  ${lang}: { ${pairs.join(', ')} },\n`;
  }
  out += `};\n\n`;

  out += `// Category cover images (reuse a vocab word's picture) for the 进阶 tab.\n`;
  out += `export const devCategoryCovers = {\n`;
  for (const [k, v] of Object.entries(covers)) out += `  ${jsStr(k)}: ${jsStr(v)},\n`;
  out += `};\n`;

  writeFileSync(join(SRC_DATA, 'devPhrases.js'), out);
  log.ok(`Wrote src/data/devPhrases.js (${devPhrases.length} entries, ${devCats.length} categories)`);
}

// ── Generate src/data/categoryLabels.js ─────────────────────────────────────
function writeCategoryLabelsJs(words, catOrder) {
  const cats = ['all'];
  const seen = new Set(['all']);
  for (const c of (catOrder || [])) {
    if (words.some(w => w.category === c) && !seen.has(c)) { cats.push(c); seen.add(c); }
  }
  for (const w of words) if (!seen.has(w.category)) { cats.push(w.category); seen.add(w.category); }

  // Warn about categories without translations
  const untranslated = cats.filter(c => !CATEGORY_LABELS_DICT[c]);
  if (untranslated.length > 0) {
    log.warn(`Categories without translations (using Title Case English fallback):`);
    untranslated.forEach(c => console.log(`     · ${c} → "${titleCase(c)}"`));
    log.warn(`To add proper translations: edit CATEGORY_LABELS_DICT in scripts/sync-data.mjs`);
  }

  let out = '';
  out += `// AUTO-GENERATED by scripts/sync-data.mjs — do not edit by hand\n`;
  out += `// Source: category list from WordList.xlsx + translations from sync-data.mjs\n`;
  out += `// To add translations for new categories: edit CATEGORY_LABELS_DICT in scripts/sync-data.mjs\n\n`;
  out += `export const CATEGORY_LABELS = {\n`;
  for (const lang of ['zh', 'en', 'ja']) {
    out += `  ${lang}: {`;
    const pairs = cats.map(c => `${c}: ${jsStr(labelFor(c, lang))}`);
    out += ' ' + pairs.join(', ') + ' ';
    out += `},\n`;
  }
  out += `};\n`;

  writeFileSync(join(SRC_DATA, 'categoryLabels.js'), out);
  log.ok(`Wrote src/data/categoryLabels.js (${cats.length} categories × 3 langs)`);
}

// ── Generate src/data/categoryCovers.js ─────────────────────────────────────
function writeCategoryCoversJs(covers) {
  let out = '';
  out += `// AUTO-GENERATED by scripts/sync-data.mjs — do not edit by hand\n`;
  out += `// Source: data_prep/category.xlsx\n`;
  out += `// To change a cover: edit "Cover Image Word" in the Categories or Phrase Categories sheet\n\n`;

  out += `// Representative image for each vocab category (detail tab in category modal)\n`;
  out += `export const vocabCategoryCovers = {\n`;
  for (const [k, v] of Object.entries(covers.vocab)) {
    if (v) out += `  ${k}: ${jsStr(v)},\n`;
  }
  out += `};\n\n`;

  out += `// Representative image for each oral category (uses a vocab word's image)\n`;
  out += `export const oralCategoryCovers = {\n`;
  for (const [k, v] of Object.entries(covers.oral)) {
    if (v) out += `  ${k}: ${jsStr(v)},\n`;
  }
  out += `};\n`;

  writeFileSync(join(SRC_DATA, 'categoryCovers.js'), out);
  log.ok(`Wrote src/data/categoryCovers.js`);
}

// ── Generate src/data/pinyin.js ─────────────────────────────────────────────
function writePinyinJs(words) {
  let out = '';
  out += `// AUTO-GENERATED by scripts/sync-data.mjs — do not edit by hand\n`;
  out += `// Source: data_prep/WordList.xlsx\n`;
  out += `// Pinyin for all Chinese vocabulary words — keyed by word.zh\n`;
  out += `export const pinyinMap = {\n`;

  let count = 0;
  for (const w of words) {
    if (!w.pinyin || !w.zh) continue;
    out += `  ${jsStr(w.zh)}: ${jsStr(w.pinyin)},\n`;
    count++;
  }
  out += `};\n`;

  writeFileSync(join(SRC_DATA, 'pinyin.js'), out);
  log.ok(`Wrote src/data/pinyin.js (${count} entries)`);
}

// ── Generate src/data/phonetics.js ──────────────────────────────────────────
function writePhoneticsJs(words) {
  let out = '';
  out += `// AUTO-GENERATED by scripts/sync-data.mjs — do not edit by hand\n`;
  out += `// Source: data_prep/WordList.xlsx\n`;
  out += `// IPA phonetics for all vocab words — used as primary source before falling back to API\n`;
  out += `export const phoneticMap = {\n`;

  let count = 0;
  for (const w of words) {
    if (!w.ipa) continue;
    out += `  ${jsStr(w.en)}: ${jsStr(w.ipa)},\n`;
    count++;
  }
  out += `};\n`;

  writeFileSync(join(SRC_DATA, 'phonetics.js'), out);
  log.ok(`Wrote src/data/phonetics.js (${count} entries)`);
}

// ── Process images ──────────────────────────────────────────────────────────
async function processImages(words) {
  log.section('Processing images');

  // Phase 3：从工厂「已确认」桶收图(Confirmed + 新_Confirmed)。
  const jobs = []; // { dir, file }
  for (const dir of IMG_IN_DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.')) continue;
      if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extname(f).toLowerCase())) continue;
      jobs.push({ dir, file: f });
    }
  }

  if (jobs.length === 0) {
    log.info('No new images to process (工厂 Confirmed/新_Confirmed 为空)');
    return { processed: 0, unmatched: 0 };
  }

  const wordByEn = new Map(words.map(w => [w.en.toLowerCase(), w]));

  // 新结构：原版图平铺进 eagle-inbox/图/（不再按批次时间戳分；app+marketing 混一堆）。
  const archiveDir = join(PROCESSED_DIR, '图');

  let processed = 0;
  const unmatchedList = [];

  for (const { dir, file } of jobs) {
    const ext = extname(file);
    const base = basename(file, ext);
    // Strip macOS " copy" / " copy 2" suffix, then trailing "-<digits>"
    // Examples: "grandmother-1 copy" → "grandmother", "apple-3" → "apple"
    const cleanName = base
      .replace(/\s+copy(\s+\d+)?$/i, '')
      .replace(/-\d+$/, '')
      .trim()
      .toLowerCase();
    const word = wordByEn.get(cleanName);

    if (!word) {
      unmatchedList.push(file);
      continue;
    }

    const inputPath = join(dir, file);
    const outputPath = join(IMG_OUT, word.img); // hashed filename (Phase 5)

    try {
      ensureDir(IMG_OUT);
      await sharp(inputPath)
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(outputPath);

      // 原版图挪进工厂 eagle-inbox(待用户整批拖进 Eagle 存档)
      ensureDir(archiveDir);
      renameSync(inputPath, join(archiveDir, file));
      processed++;
      log.ok(`${file.padEnd(32)} → ${word.en} (${word.img})`);
    } catch (e) {
      log.err(`Failed to process ${file}: ${e.message}`);
    }
  }

  if (unmatchedList.length > 0) {
    log.warn(`${unmatchedList.length} image(s) did not match any word (left in place):`);
    unmatchedList.forEach(f => console.log(`     · ${f}`));
  }

  return { processed, unmatched: unmatchedList.length };
}

// ── Migrate legacy en-named images → hashed names (Phase 5) ─────────────────
// Self-healing: on every run, any image still stored under its old English
// filename (apple.jpg, "ice cream.jpg") is renamed to its hashed name. Runs
// once for real at rollout, then is a no-op (targets already exist). Keeps the
// pipeline correct forever without a separate one-shot script.
function migrateImageNames(words) {
  if (!existsSync(IMG_OUT)) return { renamed: 0 };
  let renamed = 0;
  for (const w of words) {
    const target = join(IMG_OUT, w.img);
    if (existsSync(target)) continue; // already hashed
    const legacy = join(IMG_OUT, `${w.en.toLowerCase()}.jpg`);
    if (!existsSync(legacy)) continue; // no image (filtered out later)
    try {
      renameSync(legacy, target);
      renamed++;
    } catch (e) {
      log.err(`Failed to rename ${w.en.toLowerCase()}.jpg → ${w.img}: ${e.message}`);
    }
  }
  if (renamed > 0) {
    log.section('Migrating image filenames → hashed (Phase 5)');
    log.ok(`Renamed ${renamed} legacy image(s) to hashed names`);
  }
  return { renamed };
}

// ── Archive orphan images (words deleted from Excel) ───────────────────────
// Any .jpg in public/images/ whose stem no longer matches a word in the Excel
// is moved to _deleted-images/<timestamp>/ (gitignored) so it can be
// recovered locally. Git will record the deletion from public/images/.
function archiveDeletedImages(words) {
  log.section('Checking for deleted words');

  if (!existsSync(IMG_OUT)) {
    log.info('public/images/ does not exist — nothing to check');
    return { archived: 0 };
  }

  // Safety: if the words list is suspiciously empty, bail out so we don't
  // nuke every image because of an Excel parse error.
  if (!words || words.length === 0) {
    log.warn('Word list is empty — skipping deletion check as a safety measure');
    return { archived: 0 };
  }

  // Phase 5: filenames are hashed, so match by full filename (w.img), not by
  // English stem. Anything in public/images/ that isn't a current word's hashed
  // image is an orphan — a deleted word, or a stale legacy en-named file.
  const validFiles = new Set(words.map(w => w.img));
  const files = readdirSync(IMG_OUT).filter(f =>
    !f.startsWith('.') && extname(f).toLowerCase() === '.jpg'
  );

  const orphans = files.filter(f => !validFiles.has(f));

  if (orphans.length === 0) {
    log.ok('No orphan images — everything in public/images/ is still in Excel');
    return { archived: 0 };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archiveDir = join(DELETED_DIR, stamp);
  ensureDir(archiveDir);

  let archived = 0;
  for (const file of orphans) {
    const src = join(IMG_OUT, file);
    const dst = join(archiveDir, file);
    try {
      renameSync(src, dst);
      archived++;
      log.ok(`Archived ${file.padEnd(32)} → deleted_image/${stamp}/${file}`);
    } catch (e) {
      // Fallback: cross-device rename can fail — copy + unlink would be
      // needed, but DELETED_DIR is on the same filesystem, so just log.
      log.err(`Failed to archive ${file}: ${e.message}`);
    }
  }

  log.ok(`Archived ${archived} deleted image(s) to deleted_image/${stamp}/`);
  return { archived };
}

// ── Git commit & push ───────────────────────────────────────────────────────
function gitCommitAndPush(summary) {
  log.section('Git commit & push');
  try {
    // Stage EVERYTHING (data files, code changes, assets, etc.) so a single
    // click of update.command pushes all local work to GitHub → Vercel.
    // Anything that shouldn't be pushed must be listed in .gitignore.
    execSync('git add -A', { cwd: ROOT, stdio: 'pipe' });
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    if (!status.trim()) {
      log.info('Nothing to commit — everything up to date');
      return;
    }
    execSync(`git commit -m "Data sync: ${summary}"`, { cwd: ROOT, stdio: 'pipe' });
    log.ok('Committed');
    execSync('git push', { cwd: ROOT, stdio: 'pipe' });
    log.ok('Pushed to remote — Vercel will redeploy in ~30s');
  } catch (e) {
    log.err(`Git operation failed:\n${e.stderr?.toString() || e.message}`);
    throw e;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n\x1b[1m🔄 VocabWorkspace Data Sync\x1b[0m');

  // Phase 5: hashed image names need the secret salt before any word is read.
  IMAGE_HASH_SALT = loadImageHashSalt();
  if (!IMAGE_HASH_SALT) {
    log.err('IMAGE_HASH_SALT not found — required for hashed image filenames (anti-scraping Phase 5).');
    log.info(`Store it in the macOS Keychain:  security add-generic-password -a "$USER" -s ${KEYCHAIN_SALT_SERVICE} -w <random hex> -U`);
    log.info('(or set IMAGE_HASH_SALT in .env.local). It must never change once set.');
    process.exit(1);
  }

  // Interactive dedup pass: catches duplicate entries in the source xlsx files
  // before they're parsed. Same key → same generated id → React rendering chaos.
  await dedupCheck(VOCAB_XLSX, 'English', 'WordList.xlsx');
  await dedupCheck(ORAL_XLSX, 'English', 'PhraseList.xlsx');

  const { words: allWords, allRows } = readVocab();
  const allPhrases = readOral();
  const { phrases: devPhrases, categories: devCats } = readDevPhrases();
  const phrases = filterPhrasesWithAudio(allPhrases);
  const phraseAudioSkipped = allPhrases.length - phrases.length;
  if (phraseAudioSkipped > 0) {
    log.info(`Filtered out ${phraseAudioSkipped} phrase(s) without complete audio (${phrases.length} remain)`);
  }

  // Process images first so new images are available for the filter below
  const { processed, unmatched } = await processImages(allWords);

  // Rename any legacy en-named images to their hashed names (no-op after rollout)
  migrateImageNames(allWords);

  // Only include words that have an image in public/images/
  const words = allWords.filter(w => existsSync(join(IMG_OUT, w.img)));
  const skipped = allWords.length - words.length;
  if (skipped > 0) {
    log.info(`Filtered out ${skipped} word(s) without images (${words.length} remain)`);
  }

  // Read covers + display order from category.xlsx; writes back if new categories appear
  const covers = ensureCategoryXlsx(words, phrases);

  log.section('Generating JS files');
  writeWordsJs(words, covers.vocabOrder);
  reportConceptMerges(words);
  writeJaDataJs(words);
  writePinyinJs(allRows);
  writePhoneticsJs(allRows);
  writeOralPhrasesJs(phrases, covers.oralOrder);
  writeDevPhrasesJs(devPhrases, devCats, words);
  writeCategoryLabelsJs(words, covers.vocabOrder);
  writeCategoryCoversJs(covers);

  const { archived } = archiveDeletedImages(words);

  const parts = [
    `${words.length} words`,
    `${phrases.length} phrases`,
    `${devPhrases.length} 进阶`,
    `${processed} new images`,
  ];
  if (archived > 0) parts.push(`${archived} deleted`);
  const summary = parts.join(' · ');

  if (AUTO_PUSH) {
    gitCommitAndPush(summary);
  } else {
    log.section('Summary');
    log.info(summary);
    log.info('(dry run — no git operations. Use --auto to push.)');
  }

  console.log('\n\x1b[32m✓ Done!\x1b[0m\n');
}

// Exported for unit tests (scripts/test-phase4.mjs). Importing this module does
// NOT run the sync — main() only fires when the file is executed directly.
export { assignWordIds, buildWordsJs, wordLangs, MIN_LIVE_LANGS };

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error('\n\x1b[31m✗ Sync failed:\x1b[0m', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  });
}
