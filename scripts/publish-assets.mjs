#!/usr/bin/env node
// 一键发图流程:缩放 -> 压缩 -> 传 R2 -> 提交 -> (可选)push 上线。
//
// 用法:把新图(任意尺寸)覆盖到 public/assets/figma/ 里(保持原文件名),
// 然后双击 scripts/更新图片.command,或在终端跑 `node scripts/publish-assets.mjs`。
//
// 缩放尺寸不用你操心:脚本自动从源码里找该图的显示宽度(width: N / w-[Npx]),
// 乘 3 当目标(Figma 3x 政策)。找不到宽度的当作背景图,最长边封顶 1179px。
// 只缩小、绝不放大。

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import readline from 'node:readline';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIGMA_DIR = path.join(ROOT, 'public/assets/figma');
const INSTALL_DIR = path.join(ROOT, 'public/assets/install');
const SCALE = 3;            // Figma 3x 导出政策
const BG_MAX_LONG_SIDE = 1179; // 全屏背景封顶(393*3)
const IMG_RE = /\.(png|jpe?g|webp)$/i;

const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' });

// 1) 找出 git 里有改动 / 新增的图片(figma + install)
function changedImages() {
  const out = sh('git status --porcelain -- public/assets/figma public/assets/install');
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    if (status === 'D ' || status === ' D') continue; // 删除的跳过
    let p = line.slice(3).trim();
    if (p.startsWith('"') && p.endsWith('"')) p = JSON.parse(p); // git 对非 ASCII 名加引号
    if (IMG_RE.test(p)) files.push(path.join(ROOT, p));
  }
  return files;
}

// 2) 从源码推导某图的目标像素宽度(显示宽度 x3)。找不到返回 null(=背景图)。
let SRC_CACHE = null;
function srcFiles() {
  if (SRC_CACHE) return SRC_CACHE;
  const acc = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(fp); }
      else if (/\.(jsx?|tsx?|css|html|svg)$/.test(e.name)) acc.push(fp);
    }
  };
  walk(path.join(ROOT, 'src'));
  const idx = path.join(ROOT, 'index.html');
  try { statSync(idx); acc.push(idx); } catch {}
  SRC_CACHE = acc.map((f) => ({ f, lines: readFileSync(f, 'utf8').split('\n') }));
  return SRC_CACHE;
}

function deriveDisplayWidth(filename) {
  const widths = [];
  for (const { lines } of srcFiles()) {
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(filename)) continue;
      const lo = Math.max(0, i - 4);
      const hi = Math.min(lines.length, i + 5);
      const win = lines.slice(lo, hi).join('\n');
      // 数字像素:width: 37 / width:37
      for (const m of win.matchAll(/width:\s*(\d+)(?!\d*%)/g)) widths.push(+m[1]);
      // Tailwind 任意值: w-[30px]
      for (const m of win.matchAll(/\bw-\[(\d+)px\]/g)) widths.push(+m[1]);
    }
  }
  if (!widths.length) return null;
  return Math.max(...widths);
}

// 3) 缩放(只缩小)
async function resizeOne(file) {
  const name = path.basename(file);
  const meta = await sharp(file).metadata();
  const dispW = deriveDisplayWidth(name);
  let targetW;
  let mode;
  if (dispW != null) {
    targetW = dispW * SCALE;
    mode = `显示${dispW}px x${SCALE}`;
  } else {
    // 背景图:按最长边封顶
    const longSide = Math.max(meta.width, meta.height);
    if (longSide <= BG_MAX_LONG_SIDE) {
      return { name, action: `跳过(背景图,${meta.width}x${meta.height} 已 <= ${BG_MAX_LONG_SIDE})` };
    }
    const ratio = BG_MAX_LONG_SIDE / longSide;
    targetW = Math.round(meta.width * ratio);
    mode = `背景封顶${BG_MAX_LONG_SIDE}`;
  }
  if (meta.width <= targetW) {
    return { name, action: `跳过(${meta.width}px 已 <= 目标 ${targetW}px,不放大)` };
  }
  const buf = await sharp(file).resize({ width: targetW }).toBuffer();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, buf);
  const after = await sharp(file).metadata();
  return { name, action: `${meta.width}x${meta.height} -> ${after.width}x${after.height}  [${mode}]` };
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (r.status !== 0) { console.error(`\n✗ 失败: ${cmd} ${args.join(' ')}`); process.exit(r.status || 1); }
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function main() {
  console.log('\n=== 一键发图 ===\n');
  const imgs = changedImages();
  if (!imgs.length) {
    console.log('public/assets/figma|install 里没有改动的图片。把新图覆盖进去再跑我。');
    return;
  }
  console.log(`检测到 ${imgs.length} 张改动图片:\n`);

  // 缩放
  console.log('① 缩放:');
  for (const f of imgs) {
    const r = await resizeOne(f);
    console.log(`   ${r.name.padEnd(28)} ${r.action}`);
  }

  // 压缩
  console.log('\n② 压缩 (compress:figma):');
  run('npm', ['run', 'compress:figma']);

  // 传 R2 + 刷新 manifest
  console.log('\n③ 上传 R2 + 刷新哈希 (upload:assets):');
  run('npm', ['run', 'upload:assets']);

  // 提交
  console.log('\n④ 提交:');
  sh('git add public/assets/figma public/assets/install src/utils/asset-manifest.json');
  const staged = sh('git diff --cached --name-only').trim();
  if (!staged) {
    console.log('   没有需要提交的改动(可能图片内容没变)。结束。');
    return;
  }
  const names = imgs.map((f) => path.basename(f)).join(', ');
  sh(`git commit -m ${JSON.stringify(`Assets: update ${names} (resize+compress+R2)`)}`);
  console.log('   已提交。');

  // push 上线(确认)
  const ahead = sh('git log --oneline origin/main..HEAD').trim();
  console.log('\n⑤ 即将 push 上线的提交:\n');
  console.log(ahead.split('\n').map((l) => '   ' + l).join('\n'));
  const yn = (await ask('\n确认 push origin main 上线? [y/N] ')).toLowerCase();
  if (yn === 'y' || yn === 'yes') {
    run('git', ['push', 'origin', 'main']);
    console.log('\n✅ 已上线。Vercel 正在自动构建。');
  } else {
    console.log('\n已提交但未 push。想上线时手动 `git push origin main`。');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
