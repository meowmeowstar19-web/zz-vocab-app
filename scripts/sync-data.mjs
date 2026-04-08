#!/usr/bin/env node
// ============================================================================
// VocabWorkspace Data Sync
// ----------------------------------------------------------------------------
// Reads update_data_folder/{Vocab_Confirmed,Daily_Expressions}.xlsx,
// regenerates src/data/{words,jaData,oralPhrases,categoryCovers}.js,
// compresses and moves images from updated_image/ to public/images/,
// archives processed originals, and (with --auto) git commits + pushes.
// ============================================================================

import XLSX from 'xlsx';
import sharp from 'sharp';
import {
  readdirSync, writeFileSync, mkdirSync, renameSync,
  existsSync,
} from 'node:fs';
import { join, dirname, basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// ── Paths ────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = join(ROOT, 'update_data_folder');
const VOCAB_XLSX = join(DATA_DIR, 'Vocab_Confirmed.xlsx');
const ORAL_XLSX = join(DATA_DIR, 'Daily_Expressions.xlsx');
const IMG_IN = join(DATA_DIR, 'updated_image');
const IMG_OUT = join(ROOT, 'public', 'images');
const PROCESSED_DIR = join(DATA_DIR, '_processed_images');
const DELETED_DIR = join(DATA_DIR, 'deleted_image');
const SRC_DATA = join(ROOT, 'src', 'data');

const AUTO_PUSH = process.argv.includes('--auto');

// ── Mappings (Excel → code) ──────────────────────────────────────────────────
const VOCAB_CATEGORY_MAP = {
  'Adjectives': 'adjective',
  'Animals':    'animal',
  'Body':       'body',
  'Clothes':    'clothes',
  'Food':       'food',
  'Numbers':    'numbers',
  'People':     'people',
  'Places':     'places',
};

const LEVEL_MAP = { 1: 'beginner', 2: 'intermediate', 3: 'advanced' };

// Oral category prefix (A/B/D/F) → slug
const ORAL_CATEGORY_PREFIX = {
  'A': 'everyday',   // 生活场景
  'B': 'food',       // 饮食烹饪
  'D': 'emotions',   // 情绪感受
  'F': 'opinions',   // 观点反应
};

// Multi-language category label dictionary.
// Known categories get proper translations; unknown ones fall back to Title Case English.
// To add translations for new categories: add an entry here and re-run sync.
const CATEGORY_LABELS_DICT = {
  all:       { zh: '全部',   en: 'All',        ja: '全て' },
  adjective: { zh: '形容词', en: 'Adjectives', ja: '形容詞' },
  animal:    { zh: '动物',   en: 'Animals',    ja: '動物' },
  body:      { zh: '身体',   en: 'Body',       ja: '体' },
  clothes:   { zh: '服饰',   en: 'Clothes',    ja: '服' },
  food:      { zh: '食物',   en: 'Food',       ja: '食べ物' },
  numbers:   { zh: '数字',   en: 'Numbers',    ja: '数字' },
  people:    { zh: '人物',   en: 'People',     ja: '人物' },
  places:    { zh: '地点',   en: 'Places',     ja: '場所' },
  weather:   { zh: '天气',   en: 'Weather',    ja: '天気' },
  actions:   { zh: '动作',   en: 'Actions',    ja: '動作' },
  colors:    { zh: '颜色',   en: 'Colors',     ja: '色' },
  nature:    { zh: '自然',   en: 'Nature',     ja: '自然' },
  transport: { zh: '交通',   en: 'Transport',  ja: '乗り物' },
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
  everyday: 'orange.jpg',
  food:     'hungry.jpg',
  emotions: 'durian.jpg',
  opinions: 'cherry.jpg',
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

// ── Read Vocab_Confirmed.xlsx ────────────────────────────────────────────────
function readVocab() {
  log.section('Reading Vocab_Confirmed.xlsx');
  if (!existsSync(VOCAB_XLSX)) throw new Error(`Missing file: ${VOCAB_XLSX}`);

  const wb = XLSX.readFile(VOCAB_XLSX);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const words = [];
  const unknownCats = new Set();

  for (const row of rows) {
    const en = String(row['English'] || '').trim();
    if (!en) continue;

    const rawCat = String(row['Category'] || '').trim();
    const cat = VOCAB_CATEGORY_MAP[rawCat] || rawCat.toLowerCase();
    if (!VOCAB_CATEGORY_MAP[rawCat] && rawCat) unknownCats.add(rawCat);

    const lvlNum = Number(row['Level']) || 1;
    const lvl = LEVEL_MAP[lvlNum] || 'beginner';

    words.push({
      en,
      zh:          String(row['Chinese (中文)'] || '').trim(),
      category:    cat,
      level:       lvl,
      sentence:    String(row['Example Sentence'] || '').trim(),
      sentenceZh:  String(row['Example CN (例句中文)'] || '').trim(),
      img:         `${en}.jpg`,
      ja:          String(row['Japanese (日本語)'] || '').trim(),
      jaReading:   String(row['Japanese Reading (日语音标)'] || '').trim(),
      jaSentence:  String(row['Example JP (例句日語)'] || '').trim(),
    });
  }

  if (unknownCats.size > 0) {
    log.warn(`Unmapped vocab categories (add to VOCAB_CATEGORY_MAP in sync-data.mjs):`);
    unknownCats.forEach(c => console.log(`     · ${c}`));
  }

  log.ok(`Parsed ${words.length} vocab entries`);
  return { wb, words };
}

// ── Ensure "Covers" sheet exists + is in sync with current categories ────────
// Reads existing Covers sheet, fills in defaults/random for new categories,
// validates stale entries, writes the sheet back to xlsx.
function ensureCoversSheet(wb, words, phrases) {
  log.section('Syncing "Covers" sheet');

  // Build lookup: category → list of word en
  const wordsByCat = {};
  for (const w of words) {
    if (!wordsByCat[w.category]) wordsByCat[w.category] = [];
    wordsByCat[w.category].push(w.en);
  }
  const allWordEns = new Set(words.map(w => w.en));

  // Category order from data (not alphabetical)
  const vocabCats = [];
  const vseen = new Set();
  for (const w of words) if (!vseen.has(w.category)) { vocabCats.push(w.category); vseen.add(w.category); }

  const oralCats = [];
  const oseen = new Set();
  for (const p of phrases) if (!oseen.has(p.category)) { oralCats.push(p.category); oseen.add(p.category); }

  // Read existing Covers sheet (if any)
  const existing = {}; // { 'vocab-adjective': 'good', ... }
  if (wb.Sheets['Covers']) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Covers'], { defval: '' });
    for (const row of rows) {
      const target = String(row['Target'] || '').trim();
      const word   = String(row['Cover Word'] || '').trim();
      if (target && word) existing[target] = word;
    }
  }

  // Stable pseudo-random pick by category name (so same cat → same random word across runs)
  function seededPick(arr, seed) {
    if (!arr || arr.length === 0) return null;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return arr[h % arr.length];
  }

  const covers = { vocab: {}, oral: {} };
  const newRows = [];
  let changed = !wb.Sheets['Covers'];
  const warnings = [];

  // Vocab
  for (const cat of vocabCats) {
    const key = `vocab-${cat}`;
    let word = existing[key];

    if (word && !wordsByCat[cat]?.includes(word)) {
      warnings.push(`"${word}" not in vocab category "${cat}" — re-picking`);
      word = null;
    }
    if (!word) {
      const defFile = DEFAULT_VOCAB_COVERS[cat];
      word = defFile ? defFile.replace(/\.jpg$/, '') : seededPick(wordsByCat[cat], cat);
      changed = true;
    }
    if (word) {
      covers.vocab[cat] = `${word}.jpg`;
      newRows.push({ Target: key, 'Cover Word': word });
    }
  }

  // Oral — cover image is drawn from the vocab pool (oral phrases have no images)
  for (const cat of oralCats) {
    const key = `oral-${cat}`;
    let word = existing[key];

    if (word && !allWordEns.has(word)) {
      warnings.push(`"${word}" not in vocab words (oral cover "${cat}") — re-picking`);
      word = null;
    }
    if (!word) {
      const defFile = DEFAULT_ORAL_COVERS[cat];
      word = defFile ? defFile.replace(/\.jpg$/, '') : seededPick([...allWordEns], `oral-${cat}`);
      changed = true;
    }
    if (word) {
      covers.oral[cat] = `${word}.jpg`;
      newRows.push({ Target: key, 'Cover Word': word });
    }
  }

  warnings.forEach(w => log.warn(w));

  // Detect stale entries (targets that no longer exist)
  const validKeys = new Set(newRows.map(r => r.Target));
  const stale = Object.keys(existing).filter(k => !validKeys.has(k));
  if (stale.length > 0) {
    log.warn(`Removing stale Covers entries: ${stale.join(', ')}`);
    changed = true;
  }

  // Write sheet back if anything changed
  if (changed) {
    // Guard: refuse to write if Excel has the file open (lock file present).
    // Excel's in-memory version would overwrite our changes on its next save.
    const lockFile = join(DATA_DIR, `~$${basename(VOCAB_XLSX)}`);
    if (existsSync(lockFile)) {
      log.err(`Vocab_Confirmed.xlsx is open in Excel (lock file: ${basename(lockFile)})`);
      log.err(`Close the file in Excel completely, then re-run the sync.`);
      log.err(`Refusing to write "Covers" sheet — otherwise Excel would overwrite it.`);
      throw new Error('Excel has Vocab_Confirmed.xlsx open — close it and re-run');
    }
    const newSheet = XLSX.utils.json_to_sheet(newRows, { header: ['Target', 'Cover Word'] });
    newSheet['!cols'] = [{ wch: 22 }, { wch: 18 }];
    wb.Sheets['Covers'] = newSheet;
    if (!wb.SheetNames.includes('Covers')) wb.SheetNames.push('Covers');
    XLSX.writeFile(wb, VOCAB_XLSX);
    log.ok(`Wrote "Covers" sheet (${newRows.length} entries) to Vocab_Confirmed.xlsx`);
  } else {
    log.ok(`"Covers" sheet up to date (${newRows.length} entries)`);
  }

  return covers;
}

// ── Read Daily_Expressions.xlsx ──────────────────────────────────────────────
function readOral() {
  log.section('Reading Daily_Expressions.xlsx');
  if (!existsSync(ORAL_XLSX)) throw new Error(`Missing file: ${ORAL_XLSX}`);

  const wb = XLSX.readFile(ORAL_XLSX);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const phrases = [];
  const missingCatRows = [];   // rows with empty/blank Category
  const unknownCats = new Map(); // rawCat → [english words]

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const en = String(row['Word / Expression'] || '').trim();
    if (!en) continue;

    const rawCat = String(row['Category'] || '').trim();
    if (!rawCat) {
      missingCatRows.push({ rowNum: i + 2, en }); // +2: header row + 1-indexed
      continue;
    }
    const prefix = rawCat.match(/^[A-Z]/)?.[0] || '';
    const cat = ORAL_CATEGORY_PREFIX[prefix];
    if (!cat) {
      if (!unknownCats.has(rawCat)) unknownCats.set(rawCat, []);
      unknownCats.get(rawCat).push(en);
      continue;
    }

    phrases.push({
      en,
      zh:         String(row['Translation'] || '').trim(),
      category:   cat,
      sentence:   String(row['Example'] || '').trim(),
      sentenceZh: String(row['Chinese Translation'] || '').trim(),
    });
  }

  if (missingCatRows.length > 0) {
    log.warn(`${missingCatRows.length} oral phrase(s) have empty Category — SKIPPED:`);
    missingCatRows.forEach(({ rowNum, en }) => console.log(`     · Row ${rowNum}: "${en}"`));
    log.warn(`Please fill the Category column in Daily_Expressions.xlsx and re-run.`);
  }
  if (unknownCats.size > 0) {
    log.warn(`Unmapped oral categories (add prefix to ORAL_CATEGORY_PREFIX in sync-data.mjs):`);
    for (const [cat, ens] of unknownCats) {
      console.log(`     · "${cat}" (${ens.length} phrase${ens.length > 1 ? 's' : ''}, e.g. "${ens[0]}")`);
    }
  }

  log.ok(`Parsed ${phrases.length} oral phrases`);
  return phrases;
}

// ── Generate src/data/words.js ──────────────────────────────────────────────
function writeWordsJs(words) {
  const catsInOrder = [];
  const seen = new Set();
  for (const w of words) if (!seen.has(w.category)) { catsInOrder.push(w.category); seen.add(w.category); }

  // Category labels (Chinese, for words.js default display)
  const labels = { all: labelFor('all', 'zh') };
  for (const k of catsInOrder) labels[k] = labelFor(k, 'zh');

  let out = '';
  out += `// AUTO-GENERATED by scripts/sync-data.mjs — do not edit by hand\n`;
  out += `// Source: update_data_folder/Vocab_Confirmed.xlsx\n`;
  out += `// Last synced: ${new Date().toISOString()}\n\n`;

  out += `// Category labels for UI\n`;
  out += `export const categoryLabels = {\n`;
  for (const [k, v] of Object.entries(labels)) out += `  ${k}: ${jsStr(v)},\n`;
  out += `};\n\n`;

  out += `export const levelLabels = {\n`;
  for (const [k, v] of Object.entries(LEVEL_LABELS_ZH)) out += `  ${k}: ${jsStr(v)},\n`;
  out += `};\n\n`;

  out += `// Format: [img, en, zh, category, level, sentence, sentenceZh]\n`;
  out += `const raw = [\n`;
  let lastCat = null;
  for (const w of words) {
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
    ].join(', ')}],\n`;
  }
  out += `];\n\n`;

  out += `// Process raw data into word objects\n`;
  out += `const wordsOrdered = raw.map(([img, en, zh, category, level, sentence, sentenceZh]) => ({\n`;
  out += `  id: img.replace(/\\.jpg$/i, '').toLowerCase().replace(/[\\s']+/g, '-').replace(/[^a-z0-9-]/g, ''),\n`;
  out += `  en, zh, category, level, sentence, sentenceZh, img,\n`;
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

  out += `export const wordsShuffled = shuffleArray(wordsOrdered);\n`;
  out += `export const words = wordsOrdered;\n`;
  out += `export const categories = ['all', ...Object.keys(categoryLabels).filter(k => k !== 'all')];\n`;

  writeFileSync(join(SRC_DATA, 'words.js'), out);
  log.ok(`Wrote src/data/words.js (${words.length} entries)`);
}

// ── Generate src/data/jaData.js ─────────────────────────────────────────────
function writeJaDataJs(words) {
  let out = '';
  out += `// AUTO-GENERATED by scripts/sync-data.mjs — do not edit by hand\n`;
  out += `// Source: update_data_folder/Vocab_Confirmed.xlsx\n`;
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
function writeOralPhrasesJs(phrases) {
  let out = '';
  out += `// AUTO-GENERATED by scripts/sync-data.mjs — do not edit by hand\n`;
  out += `// Source: update_data_folder/Daily_Expressions.xlsx\n`;
  out += `// Format: [english, chinese, category, sentence, sentenceZh]\n\n`;

  out += `const raw = [\n`;
  for (const p of phrases) {
    out += `  [${[
      jsStr(p.en),
      jsStr(p.zh),
      jsStr(p.category),
      jsStr(p.sentence),
      jsStr(p.sentenceZh),
    ].join(', ')}],\n`;
  }
  out += `];\n\n`;

  out += `// Process into objects with stable IDs\n`;
  out += `function makeId(en) {\n`;
  out += `  return 'oral-' + en.toLowerCase().replace(/['\\u2019]+/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n`;
  out += `}\n\n`;
  out += `export const oralPhrases = raw.map(([en, zh, category, sentence, sentenceZh]) => ({\n`;
  out += `  id: makeId(en),\n`;
  out += `  en, zh, category,\n`;
  out += `  img: null,\n`;
  out += `  level: 'oral',\n`;
  out += `  sentence, sentenceZh,\n`;
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
  out += `export const oralCategories = ['all', ...new Set(raw.map(r => r[2]))];\n\n`;

  out += `// Category labels\n`;
  out += `export const ORAL_CATEGORY_LABELS = {\n`;
  out += `  zh: {\n`;
  out += `    all: '全部', everyday: '生活场景', food: '饮食烹饪', opinions: '观点反应', emotions: '情绪感受',\n`;
  out += `  },\n`;
  out += `  en: {\n`;
  out += `    all: 'All', everyday: 'Everyday Life', food: 'Food & Cooking', opinions: 'Opinions', emotions: 'Emotions',\n`;
  out += `  },\n`;
  out += `  ja: {\n`;
  out += `    all: '全て', everyday: '日常生活', food: '料理', opinions: '意見', emotions: '感情',\n`;
  out += `  },\n`;
  out += `};\n`;

  writeFileSync(join(SRC_DATA, 'oralPhrases.js'), out);
  log.ok(`Wrote src/data/oralPhrases.js (${phrases.length} entries)`);
}

// ── Generate src/data/categoryLabels.js ─────────────────────────────────────
function writeCategoryLabelsJs(words) {
  const cats = ['all'];
  const seen = new Set(['all']);
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
  out += `// Source: category list from Vocab_Confirmed.xlsx + translations from sync-data.mjs\n`;
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
  out += `// Source: "Covers" sheet in update_data_folder/Vocab_Confirmed.xlsx\n`;
  out += `// To change a cover: edit the "Cover Word" column in the Covers sheet\n\n`;

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

// ── Process images ──────────────────────────────────────────────────────────
async function processImages(words) {
  log.section('Processing images');

  if (!existsSync(IMG_IN)) {
    log.warn(`updated_image/ folder does not exist — skipping image processing`);
    return { processed: 0, unmatched: 0 };
  }

  const files = readdirSync(IMG_IN).filter(f => {
    if (f.startsWith('.')) return false;
    return ['.jpg', '.jpeg', '.png', '.webp'].includes(extname(f).toLowerCase());
  });

  if (files.length === 0) {
    log.info('No new images to process');
    return { processed: 0, unmatched: 0 };
  }

  const wordByEn = new Map(words.map(w => [w.en.toLowerCase(), w]));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archiveDir = join(PROCESSED_DIR, stamp);

  let processed = 0;
  const unmatchedList = [];

  for (const file of files) {
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

    const inputPath = join(IMG_IN, file);
    const outputPath = join(IMG_OUT, `${word.en}.jpg`);

    try {
      ensureDir(IMG_OUT);
      await sharp(inputPath)
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(outputPath);

      // Archive the original
      ensureDir(archiveDir);
      renameSync(inputPath, join(archiveDir, file));
      processed++;
      log.ok(`${file.padEnd(32)} → ${word.en}.jpg`);
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

// ── Archive orphan images (words deleted from Excel) ───────────────────────
// Any .jpg in public/images/ whose stem no longer matches a word in the Excel
// is moved to update_data_folder/deleted_image/<timestamp>/ so it can be
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

  const validStems = new Set(words.map(w => w.en.toLowerCase()));
  const files = readdirSync(IMG_OUT).filter(f =>
    !f.startsWith('.') && extname(f).toLowerCase() === '.jpg'
  );

  const orphans = files.filter(f => {
    const stem = basename(f, extname(f)).toLowerCase();
    return !validStems.has(stem);
  });

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

  const { wb, words } = readVocab();
  const phrases = readOral();

  // Ensure Covers sheet is populated/in sync; this also writes back to xlsx
  const covers = ensureCoversSheet(wb, words, phrases);

  log.section('Generating JS files');
  writeWordsJs(words);
  writeJaDataJs(words);
  writeOralPhrasesJs(phrases);
  writeCategoryLabelsJs(words);
  writeCategoryCoversJs(covers);

  const { processed, unmatched } = await processImages(words);
  const { archived } = archiveDeletedImages(words);

  const parts = [
    `${words.length} words`,
    `${phrases.length} phrases`,
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

main().catch(e => {
  console.error('\n\x1b[31m✗ Sync failed:\x1b[0m', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
