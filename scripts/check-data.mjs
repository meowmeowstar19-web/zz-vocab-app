#!/usr/bin/env node
// Data integrity gate — runs on predev and prebuild, so broken content can
// never start a dev server or reach a Vercel deploy.
//
// The one rule worth failing a build over: **every shipped row needs its own
// id**. An id is not decoration — it is simultaneously the React list key in
// WordListPage and the storage key for progress. Two rows sharing one id and
// the 单词/短语/进阶 lists visibly corrupt each other: React can no longer tell
// the rows apart, stops unmounting them, and ghost rows stick to the top of
// every sub-tab (even inside the "还没有学过" empty state). Both rows also share
// a single learned/mastered flag.
//
// This bit once already — 进阶 shipped "Have a falling-out" (实用词组) and
// "have a falling out" (原声精讲), which normalize to the same id. makeId now
// suffixes collisions (-2/-3) at generation time; this gate is what proves it
// stayed true as content grows.
//
// Pools are DISCOVERED, not listed: every array-of-{id} exported from
// src/data/*.js is checked, so a new content line is covered the day it lands
// without anyone remembering to register it here.
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const SRC_DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');

const log = {
  info: (m) => console.log(`\x1b[36m→\x1b[0m ${m}`),
  ok:   (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`),
  warn: (m) => console.log(`\x1b[33m⚠\x1b[0m ${m}`),
  err:  (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`),
};

// Same normalization makeId uses — two rows landing on one slug are the
// near-duplicates worth reporting back to the Excel.
export function slug(en) {
  return String(en).toLowerCase()
    .replace(/['’]+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function isRowArray(v) {
  return Array.isArray(v) && v.length > 0 && v.every(x => x && typeof x === 'object' && 'id' in x);
}

// Pure core, so the vitest suite can feed it synthetic bad data.
// `pools` = [{ name, rows }]. Shuffled / filtered re-exports of the same rows
// are folded together by object identity, so `wordsShuffled` is not mistaken
// for 248 extra colliding rows.
export function collectIssues(pools) {
  const errors = [];
  const warnings = [];

  for (const { name, rows } of pools) {
    const byId = new Map();
    for (const r of rows) {
      if (!r.id || typeof r.id !== 'string') { errors.push(`${name}: 有一行 id 为空 (en=${JSON.stringify(r.en)})`); continue; }
      if (!byId.has(r.id)) byId.set(r.id, []);
      byId.get(r.id).push(r);
    }
    for (const [id, rs] of byId) {
      if (rs.length > 1) {
        errors.push(`${name}: id 撞车 "${id}" ×${rs.length} → ${rs.map(r => `${r.en} (${r.category})`).join('  |  ')}`);
      }
    }
  }

  // Cross-pool: the app merges words + oralPhrases + devPhrases into one list,
  // so an id only unique within its own file is still a collision on screen.
  const seen = new Map(); // id → { row, pool }
  const counted = new Set();
  for (const { name, rows } of pools) {
    for (const r of rows) {
      if (counted.has(r)) continue; // same object re-exported (shuffled copy)
      counted.add(r);
      if (!r.id) continue;
      const prev = seen.get(r.id);
      if (prev && prev.pool !== name) {
        errors.push(`跨表 id 撞车 "${r.id}": ${prev.pool} 的「${prev.row.en}」 vs ${name} 的「${r.en}」`);
      } else if (!prev) {
        seen.set(r.id, { row: r, pool: name });
      }
    }
  }

  // Non-blocking: same English text twice inside one pool. Different 中文 =
  // different sense, fine (ids already suffixed). Identical 中文 = redundant
  // content worth merging back in the Excel.
  for (const { name, rows } of pools) {
    const groups = new Map();
    for (const r of rows) {
      if (!r.en) continue;
      const k = slug(r.en);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    for (const [, rs] of groups) {
      if (rs.length < 2) continue;
      const zhs = new Set(rs.map(r => String(r.zh || '').trim()));
      if (zhs.size === 1) {
        warnings.push(`${name}: 完全重复(英文+中文都一样,建议在 Excel 合并) 「${rs[0].en}」→ ${rs.map(r => r.category).join(' / ')}`);
      } else {
        warnings.push(`${name}: 同英文不同释义(已自动加 -2 后缀,保留两条) 「${rs[0].en}」→ ${rs.map(r => `${r.category}:${r.zh}`).join('  |  ')}`);
      }
    }
  }

  return { errors, warnings };
}

// Load every array-of-rows exported from src/data/*.js. Folds the shuffled /
// filtered re-exports into their source file so each row is counted once.
export async function loadPools() {
  const pools = [];
  for (const file of readdirSync(SRC_DATA).filter(f => f.endsWith('.js')).sort()) {
    let mod;
    try {
      mod = await import(pathToFileURL(join(SRC_DATA, file)).href);
    } catch (e) {
      log.warn(`跳过 src/data/${file}(无法 import:${e.message})`);
      continue;
    }
    const rows = [];
    const seen = new Set();
    for (const v of Object.values(mod)) {
      if (!isRowArray(v)) continue;
      for (const r of v) { if (!seen.has(r)) { seen.add(r); rows.push(r); } }
    }
    if (rows.length) pools.push({ name: file, rows });
  }
  return pools;
}

async function main() {
  const pools = await loadPools();
  if (!pools.length) { log.err('src/data 里没找到任何数据表 — 检查脚本自己坏了'); process.exit(1); }

  const { errors, warnings } = collectIssues(pools);
  const total = pools.reduce((n, p) => n + p.rows.length, 0);

  for (const w of warnings) log.warn(w);
  if (errors.length) {
    for (const e of errors) log.err(e);
    log.err(`数据检查未通过:${errors.length} 处 id 问题。id 同时是 React key 和进度存储键,重复会让 单词/短语/进阶 三个列表串行。`);
    log.info('修法:改 word-data/*.xlsx 让两条英文不同,或直接跑 npm run sync 让 makeId 自动加 -2 后缀。');
    process.exit(1);
  }
  log.ok(`数据检查通过:${pools.length} 张表 / ${total} 行,id 全唯一${warnings.length ? `(${warnings.length} 条重复提醒见上)` : ''}`);
}

// CLI only — importing this file (tests) must not exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
