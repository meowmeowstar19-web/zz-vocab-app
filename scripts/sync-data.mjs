#!/usr/bin/env node
// ============================================================================
// VocabWorkspace Data Sync
// ----------------------------------------------------------------------------
// Reads update_data_folder/{WordList,PhraseList}.xlsx,
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
import readline from 'node:readline';

// ── Paths ────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = join(ROOT, 'update_data_folder');
const VOCAB_XLSX = join(DATA_DIR, 'WordList.xlsx');
const ORAL_XLSX = join(DATA_DIR, 'PhraseList.xlsx');
const CATEGORY_XLSX = join(DATA_DIR, 'category.xlsx');
const IMG_IN = join(DATA_DIR, 'updated_image');
const IMG_OUT = join(ROOT, 'public', 'images');
const PROCESSED_DIR = join(DATA_DIR, '_processed_images');
const DELETED_DIR = join(DATA_DIR, 'deleted_image');
const SRC_DATA = join(ROOT, 'src', 'data');

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
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const words = [];
  const allRows = []; // all rows including those without sentences (for pinyin/phonetics)
  const unknownCats = new Set();

  for (const row of rows) {
    const en = String(row['English'] || '').trim();
    if (!en) continue;

    const rawCat = String(row['Category'] || '').trim();
    const cat = VOCAB_CATEGORY_MAP[rawCat] || rawCat.toLowerCase();
    if (!VOCAB_CATEGORY_MAP[rawCat] && rawCat) unknownCats.add(rawCat);

    const lvlNum = Number(row['Level']) || 1;
    const lvl = LEVEL_MAP[lvlNum] || 'beginner';

    const sentence = String(row['Example'] || '').trim();

    const entry = {
      en,
      zh:          String(row['Chinese (中文)'] || '').trim(),
      category:    cat,
      level:       lvl,
      sentence,
      sentenceZh:  String(row['Example CN (例句中文)'] || '').trim(),
      img:         `${en.toLowerCase()}.jpg`,
      ja:          String(row['Japanese (日本語)'] || '').trim(),
      jaReading:   String(row['Japanese Reading (日语音标)'] || '').trim(),
      jaSentence:  String(row['Example JP (例句日語)'] || '').trim(),
      pinyin:      String(row['Chinese Pinyin (拼音)'] || '').trim(),
      ipa:         String(row['English IPA (音标)'] || '').trim(),
    };

    allRows.push(entry);

    // Only include words that have an example sentence for the main word list
    if (sentence) {
      words.push(entry);
    }
  }

  if (unknownCats.size > 0) {
    log.warn(`Unmapped vocab categories (add to VOCAB_CATEGORY_MAP in sync-data.mjs):`);
    unknownCats.forEach(c => console.log(`     · ${c}`));
  }

  log.ok(`Parsed ${words.length} vocab entries with sentences (${allRows.length} total rows)`);
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
    const lockFile = join(DATA_DIR, `~$${basename(CATEGORY_XLSX)}`);
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
    covers.vocab[cat] = word ? `${word}.jpg` : null;
    covers.vocabOrder.push(cat);
  }
  for (const { cat, word } of oralOut) {
    covers.oral[cat] = word ? `${word}.jpg` : null;
    covers.oralOrder.push(cat);
  }
  return covers;
}

// ── Read PhraseList.xlsx ─────────────────────────────────────────────────────
function readOral() {
  log.section('Reading PhraseList.xlsx');
  if (!existsSync(ORAL_XLSX)) throw new Error(`Missing file: ${ORAL_XLSX}`);

  const wb = XLSX.readFile(ORAL_XLSX);
  // Prefer a sheet named 口语 if present; otherwise first sheet.
  const sheetName = wb.SheetNames.includes('口语') ? '口语' : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const phrases = [];
  const missingCatRows = [];     // rows with empty/blank Category
  const unknownCats = new Map(); // rawCat → [english]

  // Japanese sentence column header is "例句r日语翻译" (typo in source); fall back
  // to "例句日语翻译" if ever fixed.
  const pickJaSentence = (row) =>
    String(row['例句r日语翻译'] || row['例句日语翻译'] || '').trim();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const en = String(row['English'] || '').trim();
    if (!en) continue;

    const rawCat = String(row['Category'] || '').trim();
    if (!rawCat) {
      missingCatRows.push({ rowNum: i + 2, en });
      continue;
    }
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
    });
  }

  if (missingCatRows.length > 0) {
    log.warn(`${missingCatRows.length} phrase(s) have empty Category — SKIPPED:`);
    missingCatRows.forEach(({ rowNum, en }) => console.log(`     · Row ${rowNum}: "${en}"`));
    log.warn(`Please fill the Category column in PhraseList.xlsx and re-run.`);
  }
  if (unknownCats.size > 0) {
    log.warn(`Unmapped phrase categories (add to PHRASE_CATEGORY_MAP in sync-data.mjs):`);
    for (const [cat, ens] of unknownCats) {
      console.log(`     · "${cat}" (${ens.length} phrase${ens.length > 1 ? 's' : ''}, e.g. "${ens[0]}")`);
    }
  }

  log.ok(`Parsed ${phrases.length} phrases`);
  return phrases;
}

// ── Generate src/data/words.js ──────────────────────────────────────────────
function writeWordsJs(words, catOrder) {
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
  out += `// Source: update_data_folder/WordList.xlsx\n`;
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
  out += `// Source: update_data_folder/WordList.xlsx\n`;
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
  out += `// Source: update_data_folder/PhraseList.xlsx\n`;
  out += `// Format: [english, chinese, category, sentence, sentenceZh, ja, jaSentence]\n\n`;

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
    ].join(', ')}],\n`;
  }
  out += `];\n\n`;

  out += `// Process into objects with stable IDs\n`;
  out += `function makeId(en) {\n`;
  out += `  return 'oral-' + en.toLowerCase().replace(/['\\u2019]+/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n`;
  out += `}\n\n`;
  out += `export const oralPhrases = raw.map(([en, zh, category, sentence, sentenceZh, ja, jaSentence]) => ({\n`;
  out += `  id: makeId(en),\n`;
  out += `  en, zh, category,\n`;
  out += `  img: null,\n`;
  out += `  level: 'oral',\n`;
  out += `  sentence, sentenceZh,\n`;
  out += `  ja, jaSentence,\n`;
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
  out += `// Source: update_data_folder/category.xlsx\n`;
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
  out += `// Source: update_data_folder/WordList.xlsx\n`;
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
  out += `// Source: update_data_folder/WordList.xlsx\n`;
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
    const outputPath = join(IMG_OUT, `${word.en.toLowerCase()}.jpg`);

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

  // Interactive dedup pass: catches duplicate entries in the source xlsx files
  // before they're parsed. Same key → same generated id → React rendering chaos.
  await dedupCheck(VOCAB_XLSX, 'English', 'WordList.xlsx');
  await dedupCheck(ORAL_XLSX, 'English', 'PhraseList.xlsx');

  const { words: allWords, allRows } = readVocab();
  const phrases = readOral();

  // Process images first so new images are available for the filter below
  const { processed, unmatched } = await processImages(allWords);

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
  writeJaDataJs(words);
  writePinyinJs(allRows);
  writePhoneticsJs(allRows);
  writeOralPhrasesJs(phrases, covers.oralOrder);
  writeCategoryLabelsJs(words, covers.vocabOrder);
  writeCategoryCoversJs(covers);

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
