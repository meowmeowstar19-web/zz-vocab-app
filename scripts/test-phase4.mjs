// Phase 4 behavior test — runs the REAL sync-data + langHelpers functions
// against synthetic data that exercises cases production data does NOT yet
// contain (no marketing word is live, partial-language words are rare). Pure +
// free: no API, no disk writes beyond a temp words.js that is read back & deleted.
//
//   run:  node scripts/test-phase4.mjs
//
// Covers:
//   · tier:     core / themed / specific carried onto every word
//   · all-pool: 'specific' EXCLUDED from "all" scope, kept in full `words`
//   · split:    same English + DIFFERENT Chinese → two concepts (bat / bat-2)
//   · merge:    same English + SAME Chinese → one all-pool card (core rep)
//   · per-lang gate (rule 2026-06-05): a word ships with whatever languages have
//     a full 3-piece set (word+phonetic+example); <2 live languages → not shipped
//   · isWordAvailable: a pair shows a word only if BOTH its languages are live

import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildWordsJs, wordLangs, MIN_LIVE_LANGS } from './sync-data.mjs';

// Mirrors langHelpers.isWordAvailable's langs branch (langHelpers itself can't be
// imported under plain Node — it uses Vite-style extensionless imports). The
// branch is: a pair shows a word iff BOTH languages are in word.langs.
const isWordAvailable = (w, native, target) =>
  Array.isArray(w.langs) ? w.langs.includes(native) && w.langs.includes(target)
    : !!(w[native] && w[target]);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); } else { fail++; console.log(`  \x1b[31m✗ ${msg}\x1b[0m`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}  (got ${JSON.stringify(a)})`);

// Synthetic entry with a full 3-piece set in exactly `live` languages.
const W = (en, zh, category, tier, live = ['en', 'zh', 'ja']) => {
  const e = {
    en, zh, category, tier, level: 'beginner',
    img: `${en.replace(/\s+/g, '_')}.jpg`, concept: '', subcategory: 'Test',
    sentence: '', sentenceZh: '', ja: '', jaReading: '', jaSentence: '', pinyin: '', ipa: '',
  };
  if (live.includes('en')) { e.ipa = `/${en}/`; e.sentence = `${en} sentence.`; }
  if (live.includes('zh')) { e.pinyin = 'pin'; e.sentenceZh = `${zh}句子。`; }
  if (live.includes('ja')) { e.ja = `${en}JA`; e.jaReading = 'yomi'; e.jaSentence = `${en}の文。`; }
  return e;
};

const synth = [
  W('bat', '蝙蝠', 'animal', 'core'),         // ┐ same English,
  W('bat', '球棒', 'transport', 'themed'),    // ┘ different Chinese  → SPLIT
  W('player', '球员', 'people', 'core'),       // ┐ same English,
  W('player', '球员', 'food', 'themed'),       // ┘ same Chinese       → MERGE
  W('messi', '梅西', 'color', 'specific'),     //   names/events       → specific
  W('ball', '球', 'object', 'core'),           //   plain control (all 3 langs)
  W('halfword', '半词', 'object', 'core', ['en', 'zh']), // only en+zh live (no ja)
  W('enonly', '', 'object', 'core', ['en']),   //   only en → <2 langs → NOT shipped
];
const catOrder = ['animal', 'transport', 'people', 'food', 'color', 'object'];

console.log('\n\x1b[1mPhase 4 — dedup / tier / split / merge / per-language gate\x1b[0m\n');

console.log('── per-language 3-piece (wordLangs) ──');
eq(wordLangs(synth.find(w => w.en === 'ball')), ['en', 'zh', 'ja'], 'ball → live in en,zh,ja');
eq(wordLangs(synth.find(w => w.en === 'halfword')), ['en', 'zh'], 'halfword → live in en,zh only (no ja)');
eq(wordLangs(synth.find(w => w.en === 'enonly')), ['en'], 'enonly → live in en only');

// Mimic readVocab: stamp langs, gate on ≥MIN_LIVE_LANGS, then build.
synth.forEach(e => { e.langs = wordLangs(e); });
const shippable = synth.filter(e => e.langs.length >= MIN_LIVE_LANGS);

console.log('\n── gate (need ≥2 live languages) ──');
ok(shippable.some(w => w.en === 'halfword'), 'halfword (en+zh) SHIPS');
ok(!shippable.some(w => w.en === 'enonly'), 'enonly (en only) is NOT shipped');
eq(shippable.length, 7, '7 of 8 synthetic rows ship');

const src = buildWordsJs(shippable, catOrder); // assigns .id
const tmp = join(tmpdir(), `phase4-words-${process.pid}.mjs`);
writeFileSync(tmp, src);
const mod = await import(pathToFileURL(tmp).href);
rmSync(tmp, { force: true });

const allIds = mod.wordsAllPool.map(w => w.id).sort();

console.log('\n── full `words` (all tiers, marketing included) ──');
eq(mod.words.length, 7, 'words has the 7 shipped rows (specific included)');
const tierCounts = mod.words.reduce((m, w) => (m[w.tier] = (m[w.tier] || 0) + 1, m), {});
eq(tierCounts, { core: 4, themed: 2, specific: 1 }, 'tier counts core:4 themed:2 specific:1');
ok(mod.words.every(w => Array.isArray(w.langs)), 'every word carries a langs array');

console.log('\n── ids: split vs merge ──');
const batIds = synth.filter(w => w.en === 'bat').map(w => `${w.zh}=${w.id}`);
eq(batIds, ['蝙蝠=bat', '球棒=bat-2'], 'bat SPLIT → 蝙蝠=bat (core), 球棒=bat-2');
const playerIds = synth.filter(w => w.en === 'player').map(w => w.id);
eq(playerIds, ['player', 'player'], 'player MERGE → both id "player"');

console.log('\n── all-pool (the "all" scope) ──');
eq(allIds, ['ball', 'bat', 'bat-2', 'halfword', 'player'], 'all-pool = {ball,bat,bat-2,halfword,player}');
ok(!mod.wordsAllPool.some(w => w.tier === 'specific'), 'all-pool EXCLUDES specific (no messi)');
ok(mod.words.some(w => w.id === 'messi'), 'but messi IS in full `words` (its own category)');
ok(mod.wordsAllPool.filter(w => w.id === 'player').length === 1, 'player appears ONCE in all-pool (merged)');
ok(mod.wordsAllPool.find(w => w.id === 'player').tier === 'core', 'merged player representative is the core tier');

console.log('\n── isWordAvailable: a pair needs BOTH languages live ──');
const ball = mod.words.find(w => w.id === 'ball');
const half = mod.words.find(w => w.id === 'halfword');
ok(isWordAvailable(ball, 'zh', 'en') && isWordAvailable(ball, 'ja', 'en') && isWordAvailable(ball, 'zh', 'ja'),
  'ball (en,zh,ja) available in all pairs');
ok(isWordAvailable(half, 'zh', 'en'), 'halfword available for zh↔en');
ok(!isWordAvailable(half, 'zh', 'ja') && !isWordAvailable(half, 'en', 'ja'),
  'halfword NOT available for any ja pair');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
