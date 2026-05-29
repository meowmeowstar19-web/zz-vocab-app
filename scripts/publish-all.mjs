#!/usr/bin/env node
// ============================================================================
// 一键发布(图片 + 音频 + Excel 数据)—— 双击 update.command 跑这个。
// ----------------------------------------------------------------------------
// 自动判断你改了什么,只跑相关步骤,最后只提交「素材+数据」,不碰你手改的代码:
//
//   ① 新音频 (update_data_folder/updated_audio/)  → sync-updated-audio.mjs 压缩+归档
//   ② Excel 改了 / 有新单词图 / 有新音频          → sync-data.mjs 重新生成 src/data/*
//      · 单词图缩到 800x800 (quality 82)
//   ③ 非单词图 (public/assets/figma|install)      → 缩到「源码显示宽 x3」(背景图最长边封顶 1179)
//   ④ 压缩 figma/install                          → compress:figma
//   ⑤ 传 R2 + 刷新 manifest(图片+音频)          → upload:assets
//   ⑥ 有静态资源变化                              → bump public/sw.js 的 CACHE_VERSION
//   ⑦ 提交「素材+数据」并(确认后)push 上线
//
// 尺寸规则集中在 SIZING 注释里(见下)。
// ============================================================================

import { execSync, spawnSync } from 'node:child_process';
import {
  readdirSync, readFileSync, writeFileSync, statSync, existsSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── SIZING 规则(唯一出处)────────────────────────────────────────────────
//   · 单词图        → 800x800 inside,不放大,jpeg q82  (在 sync-data.mjs 里)
//   · 非单词装饰图  → 源码里该图的显示宽度 x3 (Figma 3x 政策)
//   · 全屏背景图    → 源码里找不到显示宽度时,按背景处理,最长边封顶 1179 (=393 视口宽 x3)
//   · 只缩小,绝不放大
const SCALE = 3;
const BG_MAX_LONG_SIDE = 1179;
const IMG_RE = /\.(png|jpe?g|webp)$/i;

const ASSET_DIRS = ['public/assets/figma', 'public/assets/install'];
const AUDIO_DROP = path.join(ROOT, 'update_data_folder/updated_audio');
const IMG_DROP = path.join(ROOT, 'update_data_folder/updated_image');
const XLSX_FILES = ['WordList.xlsx', 'PhraseList.xlsx', 'category.xlsx']
  .map((f) => `update_data_folder/${f}`);
const SW_PATH = path.join(ROOT, 'public/sw.js');

// 提交范围:只有素材 + 生成数据,绝不卷入手改代码
const STAGE_PATHS = [
  'src/data',
  'src/utils/asset-manifest.json',
  'public/images',
  'public/assets/figma',
  'public/assets/install',
  'public/assets/audio',
  'public/sw.js',
  ...XLSX_FILES,
];

const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' });
const C = { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m` };

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (r.status !== 0) { console.error(`\n✗ 失败: ${cmd} ${args.join(' ')}`); process.exit(r.status || 1); }
}

// 非致命运行:失败只告警、不中断流程。用于 Supabase 推送——App 目前读打包的
// words.js(Phase 4 才翻转读 Supabase),所以即使数据库没更新也不该挡住内容上线。
// 返回 true=成功。
function runSoft(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  return r.status === 0;
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

// 只接受 y / n,其它输入(包括直接回车)一律重问,绝不放行
async function confirmYesNo(q) {
  for (;;) {
    const a = (await ask(q)).toLowerCase();
    if (a === 'y' || a === 'yes') return true;
    if (a === 'n' || a === 'no') return false;
    console.log(C.y('   ⚠ 请输入 y(上线)或 n(取消),不能直接按回车或别的键。'));
  }
}

// 递归找某目录下是否有匹配后缀的文件
function dirHasFiles(dir, re) {
  if (!existsSync(dir)) return false;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { if (dirHasFiles(fp, re)) return true; }
    else if (re.test(e.name)) return true;
  }
  return false;
}

// git 改动/新增(不含删除)的文件路径(相对仓库根)
function changedPaths(pathspecs) {
  const out = sh(`git status --porcelain -- ${pathspecs.map((p) => `'${p}'`).join(' ')}`);
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    if (status === 'D ' || status === ' D') continue;
    let p = line.slice(3).trim();
    if (p.startsWith('"') && p.endsWith('"')) p = JSON.parse(p);
    files.push(p);
  }
  return files;
}

// ── 非单词图:从源码推导显示宽度,缩到 x3(背景图封顶)────────────────────
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
  if (existsSync(idx)) acc.push(idx);
  SRC_CACHE = acc.map((f) => readFileSync(f, 'utf8').split('\n'));
  return SRC_CACHE;
}

function deriveDisplayWidth(filename) {
  const widths = [];
  for (const lines of srcFiles()) {
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(filename)) continue;
      const win = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 5)).join('\n');
      for (const m of win.matchAll(/width:\s*(\d+)(?!\d*%)/g)) widths.push(+m[1]);
      for (const m of win.matchAll(/\bw-\[(\d+)px\]/g)) widths.push(+m[1]);
    }
  }
  return widths.length ? Math.max(...widths) : null;
}

async function resizeDecorImage(file) {
  const name = path.basename(file);
  const meta = await sharp(file).metadata();
  const dispW = deriveDisplayWidth(name);
  let targetW, mode;
  if (dispW != null) {
    targetW = dispW * SCALE;
    mode = `显示${dispW}px x${SCALE}`;
  } else {
    const longSide = Math.max(meta.width, meta.height);
    if (longSide <= BG_MAX_LONG_SIDE) return `跳过(背景图 ${meta.width}x${meta.height} 已<=${BG_MAX_LONG_SIDE})`;
    targetW = Math.round(meta.width * (BG_MAX_LONG_SIDE / longSide));
    mode = `背景封顶${BG_MAX_LONG_SIDE}`;
  }
  if (meta.width <= targetW) return `跳过(${meta.width}px 已<=目标${targetW}px,不放大)`;
  const buf = await sharp(file).resize({ width: targetW }).toBuffer();
  writeFileSync(file, buf);
  const after = await sharp(file).metadata();
  return `${meta.width}x${meta.height} → ${after.width}x${after.height}  [${mode}]`;
}

function bumpSwVersion() {
  const txt = readFileSync(SW_PATH, 'utf8');
  const m = txt.match(/const CACHE_VERSION = 'v(\d+)';/);
  if (!m) { console.log(C.y('   ⚠ 没找到 CACHE_VERSION,跳过 bump')); return null; }
  const next = +m[1] + 1;
  writeFileSync(SW_PATH, txt.replace(m[0], `const CACHE_VERSION = 'v${next}';`));
  return `v${m[1]} → v${next}`;
}

async function main() {
  console.log('\n' + C.b('═══ 一键发布(图片 + 音频 + 数据)═══') + '\n');

  const audioDrop = dirHasFiles(AUDIO_DROP, /\.mp3$/i);
  const newWordImgs = dirHasFiles(IMG_DROP, IMG_RE);
  const xlsxChanged = changedPaths(XLSX_FILES).length > 0;
  const changedDecor = changedPaths(ASSET_DIRS).filter((p) => IMG_RE.test(p));

  const did = [];

  // ① 音频
  if (audioDrop) {
    console.log(C.b('① 新音频 → 压缩 + 归档'));
    run('node', ['scripts/sync-updated-audio.mjs']);
    did.push('audio');
  } else console.log(C.dim('① 没有新音频投放,跳过'));

  // ② Excel / 单词图 / 音频 → 重新生成数据
  if (xlsxChanged || newWordImgs || audioDrop) {
    console.log('\n' + C.b('② Excel/单词图/音频有变 → 重新生成 src/data/*(单词图缩 800x800)'));
    run('node', ['scripts/sync-data.mjs']); // 注意:不带 --auto,不让它 git
    did.push('data');

    // ②.5 数据有变 → 推 Supabase(反爬 Phase 1 的库,语言无关 schema)
    // 读刚生成的 src/data/*.js,upsert + prune(护栏:incoming <50% 时跳过删除)。
    // 非致命:失败只告警(需 .env.local 有 SUPABASE_SERVICE_ROLE_KEY);App 还读 bundle,不挡上线。
    console.log('\n' + C.b('②.5 数据有变 → 同步到 Supabase (push:supabase)'));
    if (runSoft('npm', ['run', 'push:supabase'])) {
      did.push('supabase');
    } else {
      console.log(C.y('   ⚠ Supabase 同步失败(检查 .env.local 的 SUPABASE_SERVICE_ROLE_KEY 或网络)。'));
      console.log(C.y('     内容仍会照常上线(App 现在读打包数据,不读 Supabase)。修好后手动:npm run push:supabase'));
    }
  } else console.log(C.dim('② Excel/单词图/音频无变化,跳过数据重建'));

  // ③ 非单词图缩放
  if (changedDecor.length) {
    console.log('\n' + C.b(`③ 非单词图缩放(${changedDecor.length} 张)`));
    for (const rel of changedDecor) {
      const r = await resizeDecorImage(path.join(ROOT, rel));
      console.log(`   ${path.basename(rel).padEnd(28)} ${r}`);
    }
    did.push('figma');
  } else console.log(C.dim('③ figma/install 没有改动图片,跳过缩放'));

  // ④ 压缩 figma/install
  console.log('\n' + C.b('④ 压缩 figma/install (compress:figma)'));
  run('npm', ['run', 'compress:figma']);

  // ⑤ 传 R2 + 刷新 manifest(图片 + 音频)
  console.log('\n' + C.b('⑤ 上传 R2 + 刷新 manifest (upload:assets)'));
  run('npm', ['run', 'upload:assets']);

  // ⑥ 静态资源有变 → bump sw 缓存版本
  const assetChanged = changedPaths([
    'public/images', 'public/assets/figma', 'public/assets/install', 'public/assets/audio',
  ]).length > 0;
  if (assetChanged) {
    console.log('\n' + C.b('⑥ 静态资源有变 → bump sw.js CACHE_VERSION'));
    const v = bumpSwVersion();
    if (v) console.log(`   ${v}`);
  } else console.log(C.dim('⑥ public 静态资源无变化,不 bump sw.js'));

  // ⑦ 提交(只素材+数据)+ push
  console.log('\n' + C.b('⑦ 提交(只素材+数据,不含手改代码)'));
  sh(`git add -- ${STAGE_PATHS.map((p) => `'${p}'`).join(' ')}`);
  const staged = sh('git diff --cached --name-only').trim();
  if (!staged) { console.log(C.g('   没有需要提交的改动,全部已最新。结束。')); return; }
  console.log('   将提交:\n' + staged.split('\n').map((l) => '     ' + l).join('\n'));
  const summary = did.length ? did.join(' + ') : 'assets';
  sh(`git commit -m ${JSON.stringify(`Assets/data: update (${summary})`)}`);
  console.log(C.g('   已提交。'));

  const ahead = sh('git log --oneline origin/main..HEAD').trim();
  console.log('\n' + C.b('即将 push 上线的提交:') + '\n' + ahead.split('\n').map((l) => '   ' + l).join('\n'));
  const ok = await confirmYesNo('\n确认 push origin main 上线?(必须输入 y 才会上线)[y/n] ');
  if (ok) {
    run('git', ['push', 'origin', 'main']);
    console.log('\n' + C.g('✅ 已上线,Vercel 正在自动构建。'));
  } else {
    console.log('\n' + C.y(C.b('⚠️  你选了 n —— 改动只在本地,【没有上线】!')));
    console.log(C.y('   线上还是旧的。想上线请重新双击 update.command 并输入 y,'));
    console.log(C.y('   或在终端手动跑:git push origin main'));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
