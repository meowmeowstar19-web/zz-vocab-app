#!/usr/bin/env node
// 进阶(dev)内容 —— 发布前排重 + 机械检查。双击 `排重检查.command` 跑我。
//
// 为什么单独一个命令：L1 精确重复是对错题，已经在 check-data.mjs 里跟着 prebuild
// 硬 fail；但 L2 骨架 / L3 语义是**判断题**，不能自动 fail，得人看一眼。所以给它
// 一个能随时双击的入口，发布前跑。
//
// ⭐ slug() 直接从 check-data.mjs import —— 排重口径和 app 的 id 规则同源，
//    永远不会漂。改了那边，这边自动跟着变。
//
// 只看**新增**的近重复：审过的组存进 .dupes-acked.json，下次不再刷屏。
//   node scripts/check-dupes.mjs           只报新增
//   node scripts/check-dupes.mjs --all     全报
//   node scripts/check-dupes.mjs --accept  把当前所有组标记为「已审」
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import { slug } from './check-data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRAFT = join(process.env.HOME, 'Desktop', 'data_prep', 'dev-单词.xlsx');
const SNAPSHOT = join(ROOT, 'word-data', 'dev-单词.xlsx');
// 发布前要查的是**草稿**（工厂里刚加完内容的那份），不是已发布快照。
const XLSX_PATH = process.env.DEV_XLSX ?? (existsSync(DRAFT) ? DRAFT : SNAPSHOT);  // DEV_XLSX 用于测试
const ACKED = join(process.env.HOME, 'Desktop', 'data_prep', '.dupes-acked.json');

const C = { r:(s)=>`\x1b[31m${s}\x1b[0m`, g:(s)=>`\x1b[32m${s}\x1b[0m`,
            y:(s)=>`\x1b[33m${s}\x1b[0m`, c:(s)=>`\x1b[36m${s}\x1b[0m`, b:(s)=>`\x1b[1m${s}\x1b[0m` };

const STOP = new Set(('a an the my your his her their our its to of in on at for with and or is are '
  + 'was were be been it that this i you he she we they me him them us so up out off down over into as').split(' '));
const skel = (s) => [...new Set(String(s).toLowerCase().replace(/[^a-z\s']/g,' ').split(/\s+/)
  .filter(w => w && !STOP.has(w)).map(w => w.replace(/(ing|ed|es|s)$/,'')))].sort().join(' ');

// ── 读草稿 ────────────────────────────────────────────────────────────────
const wb = XLSX.readFile(XLSX_PATH);
const rows = [];
for (const tab of wb.SheetNames) {
  for (const r of XLSX.utils.sheet_to_json(wb.Sheets[tab], { defval: '' })) {
    const en = String(r['英语词组'] ?? '').trim();
    if (!en) continue;
    rows.push({ tab, en,
      zh:   String(r['中文词组翻译'] ?? r['中文翻译'] ?? '').trim(),
      sent: String(r['英语例句'] ?? '').trim(),
      sub:  String(r['子类'] ?? '').trim() });
  }
}
console.log(C.c(`→ ${XLSX_PATH.replace(process.env.HOME,'~')}`));
console.log(C.c(`→ ${rows.length} 条 / ${wb.SheetNames.length} 个 tab\n`));

// ── 分组 ──────────────────────────────────────────────────────────────────
const group = (keyfn) => {
  const m = new Map();
  for (const r of rows) { const k = keyfn(r); if (!k) continue; (m.get(k) ?? m.set(k,[]).get(k)).push(r); }
  return [...m.values()].filter(v => v.length > 1);
};
const L1 = group(r => slug(r.en));
const L2 = group(r => skel(r.en));
const L3 = group(r => r.zh);

const sig  = (g) => g.map(r => r.en.toLowerCase()).sort().join('|');
const acked = new Set(existsSync(ACKED) ? JSON.parse(readFileSync(ACKED,'utf8')) : []);
const ALL = process.argv.includes('--all');
const QUIET = process.argv.includes('--quiet');   // publish-all 里用：只出摘要 + 红线

const show = (title, groups, tone) => {
  const fresh = ALL ? groups : groups.filter(g => !acked.has(sig(g)));
  const old = groups.length - fresh.length;
  console.log(tone(C.b(`${title} — ${groups.length} 组${old ? `（${old} 组已审过，隐藏）` : ''}`)));
  if (QUIET && fresh.length) { console.log(C.y(`   ${fresh.length} 组新增，跑 npm run check:dupes 看详情`)); console.log(''); return fresh.length; }
  for (const g of fresh) console.log('   ' + g.map(r => `[${r.tab}>${r.sub}] ${r.en} — ${r.zh}`).join('  ｜  '));
  if (!fresh.length && groups.length) console.log(C.g('   ✓ 没有新增'));
  if (!groups.length) console.log(C.g('   ✓ 无'));
  console.log('');
  return fresh.length;
};

let fail = 0;
console.log(C.b('══ 排重 ══\n'));
if (L1.length) { fail++; show('❌ L1 精确重复（撞 id，进度会互相污染，必须清）', L1, C.r); }
else console.log(C.g(C.b('✅ L1 精确重复 — 0 组\n')));
show('⚠️  L2 骨架近重复（判断题，逐组裁决）', L2, C.y);
show('⚠️  L3 语义重复 · 同中文释义（一个意思最多留 2 个说法）', L3, C.y);

// ── 机械检查（红线，硬 fail）─────────────────────────────────────────────
console.log(C.b('══ 机械检查 ══\n'));
const bad = (label, hits) => {
  if (!hits.length) { console.log(C.g(`✅ ${label}`)); return 0; }
  console.log(C.r(C.b(`❌ ${label} — ${hits.length} 条`)));
  hits.slice(0,15).forEach(r => console.log(C.r(`   [${r.tab}] ${r.en}`)));
  if (hits.length > 15) console.log(C.r(`   …还有 ${hits.length-15} 条`));
  return 1;
};
fail += bad('例句必填',            rows.filter(r => !r.sent));
fail += bad('子类必填（第 5 列）', rows.filter(r => !r.sub));
fail += bad('中文单一翻译（不许「A / B」）', rows.filter(r => r.zh.includes(' / ')));

const BRIT = /\b(colour|favourite|whilst|realise|organis|centre|behaviour|travelling)\b/i;
const warn = (label, hits) => {
  if (!hits.length) { console.log(C.g(`✅ ${label}`)); return; }
  console.log(C.y(`⚠️  ${label} — ${hits.length} 条`));
  hits.slice(0,10).forEach(r => console.log(C.y(`   [${r.tab}] ${r.en}`)));
};
warn('英式拼写', rows.filter(r => BRIT.test(r.en) || BRIT.test(r.sent)));
warn('超 8 词（硬上限）', rows.filter(r => r.en.split(/\s+/).length > 8));

if (!QUIET) console.log('\n' + C.b('══ tab 规模（200–500）══\n'));
for (const tab of QUIET ? [] : wb.SheetNames) {
  const n = rows.filter(r => r.tab === tab).length;
  const mark = n > 500 ? C.y(`${n}  ← 超 500，该拆了`) : n < 200 ? C.c(`${n}  （<200，先当子类养着）`) : C.g(`${n}`);
  console.log(`   ${tab.padEnd(10,'　')} ${mark}`);
}

if (process.argv.includes('--accept')) {
  writeFileSync(ACKED, JSON.stringify([...L1,...L2,...L3].map(sig), null, 0));
  console.log(C.g(`\n✓ 已把当前 ${L1.length+L2.length+L3.length} 组标记为「已审」，下次只报新增`));
}

console.log('');
if (fail) { console.log(C.r(C.b('❌ 有红线问题，先修完再发布'))); process.exit(1); }
console.log(C.g(C.b('✅ 机械检查全过。L2/L3 报告自己过一遍眼，没问题就可以双击 update.command 发布')));
