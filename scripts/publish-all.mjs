#!/usr/bin/env node
// ============================================================================
// 一键发布(工厂 → 线上)—— 双击 update.command 跑这个。内容工厂 Phase 3。
// ----------------------------------------------------------------------------
// 数据/音频/图片源都是「工厂」(~/Desktop/data_prep),不再有 update_data_folder 投放中转站。
// 最后只提交「素材+数据」,不碰你手改的代码:
//
//   ① Excel 快照:工厂 WordList/PhraseList/category.xlsx → update_data_folder/(git 存档)
//   ② 音频:工厂 audio/ 草稿 → 压缩进 public,压完删工厂草稿  → sync-audio.mjs --clean
//   ③ 数据:读工厂 xlsx(+ 工厂单词图)→ src/data/*(单词图缩 800x800)→ sync-data.mjs
//   ④ src/data 有变 → 同步 Supabase                          → push:supabase
//   ⑤ 非单词图 (public/assets/figma|install)                → 缩到「源码显示宽 x3」(背景图最长边封顶 1179)
//   ⑥ 压缩 figma/install                                     → compress:figma
//   ⑦ 传 R2 + 刷新 manifest(图片+音频)                     → upload:assets
//   ⑧ 有静态资源变化                                         → bump public/sw.js 的 CACHE_VERSION
//   ⑨ 提交「素材+数据」并(确认后)push 上线
//
// 尺寸规则集中在 SIZING 注释里(见下)。
// ============================================================================

import { execSync, spawnSync } from 'node:child_process';
import {
  readdirSync, readFileSync, writeFileSync, statSync, existsSync, copyFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import sharp from 'sharp';
// 内容工厂 Phase 3：数据/音频源是「工厂」(data_prep)。xlsx 走共享路径钥匙。
import { WORDLIST_FILE, PHRASELIST_FILE, CATEGORY_FILE } from '../../data_prep/scripts/paths.mjs';

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
// Phase 3：update_data_folder 不再是「投放中转站」(sync-data/sync-audio 直接读工厂)，
// 只留作 git 里的 Excel 存档镜像 —— publish 时从工厂复制过来 + 一起提交。
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

// git 改动/新增(不含删除)的文件路径(相对仓库根)
function changedPaths(pathspecs) {
  // -z:NUL 分隔 + 路径原样输出(不做八进制/引号转义)。
  // 旧版用 JSON.parse 解 git 的八进制转义,遇到中文/空格文件名(如 ja/zh 音频)会崩。
  const out = sh(`git status --porcelain -z -- ${pathspecs.map((p) => `'${p}'`).join(' ')}`);
  const files = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const status = rec.slice(0, 2);
    if (status === 'D ' || status === ' D') continue;
    const p = rec.slice(3);
    if (p) files.push(p);
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
  console.log('\n' + C.b('═══ 一键发布(工厂 → 线上)═══') + '\n');

  // ① Excel 快照:把工厂的 xlsx 复制进 git 存档(update_data_folder/)。
  //    sync-data/sync-audio 直接读工厂,这份快照只为 ① git 存档(用户怕改坏)
  //    ② 让 git diff 看得见数据变化。
  console.log(C.b('① Excel 快照(工厂 → git 存档 update_data_folder/)'));
  for (const [src, name] of [
    [WORDLIST_FILE, 'WordList.xlsx'],
    [PHRASELIST_FILE, 'PhraseList.xlsx'],
    [CATEGORY_FILE, 'category.xlsx'],
  ]) {
    if (existsSync(src)) {
      copyFileSync(src, path.join(ROOT, 'update_data_folder', name));
      console.log(`   ${name} ✓`);
    } else console.log(C.y(`   ⚠ 工厂缺 ${name}: ${src}`));
  }

  const did = [];

  // ② 音频:工厂音频草稿 → 压缩进 public,压完删工厂草稿(--clean)。工厂空则自动跳过。
  console.log('\n' + C.b('② 音频:工厂草稿 → public/assets/audio (sync-audio --clean)'));
  run('node', ['scripts/sync-audio.mjs', '--clean']);
  if (changedPaths(['public/assets/audio']).length > 0) did.push('audio');

  // ③ 数据:读工厂 xlsx(+ 工厂单词图)→ 重新生成 src/data/*(单词图缩 800x800)
  console.log('\n' + C.b('③ 数据:工厂 → src/data (sync-data)'));
  run('node', ['scripts/sync-data.mjs']); // 不带 --auto,不让它 git

  // ④ src/data 真有变化 → 推 Supabase(反爬 Phase 1 的库,语言无关 schema)。
  //    读刚生成的 src/data/*.js,upsert + prune(护栏:incoming <50% 时跳过删除)。
  //    致命步骤:Phase 4 后 App 读 Supabase 的 image_path,Phase 5 后图片是乱码名。
  //    若这步失败、却继续到 ⑦ upload:assets(会删 R2 旧图),线上图片会全 404。
  //    所以失败必须停在删图之前——run() 内部 status≠0 即 exit。
  if (changedPaths(['src/data']).length > 0) {
    did.push('data');
    console.log('\n' + C.b('④ src/data 有变 → 同步到 Supabase (push:supabase)'));
    run('npm', ['run', 'push:supabase']);
    did.push('supabase');
  } else console.log(C.dim('④ src/data 无变化,跳过数据重建/supabase'));

  // ⑤ 非单词图缩放(figma/install 改了的)
  const changedDecor = changedPaths(ASSET_DIRS).filter((p) => IMG_RE.test(p));
  if (changedDecor.length) {
    console.log('\n' + C.b(`⑤ 非单词图缩放(${changedDecor.length} 张)`));
    for (const rel of changedDecor) {
      const r = await resizeDecorImage(path.join(ROOT, rel));
      console.log(`   ${path.basename(rel).padEnd(28)} ${r}`);
    }
    did.push('figma');
  } else console.log(C.dim('⑤ figma/install 没有改动图片,跳过缩放'));

  // ⑥ 压缩 figma/install
  console.log('\n' + C.b('⑥ 压缩 figma/install (compress:figma)'));
  run('npm', ['run', 'compress:figma']);

  // ⑦ 传 R2 + 刷新 manifest(图片 + 音频)
  console.log('\n' + C.b('⑦ 上传 R2 + 刷新 manifest (upload:assets)'));
  run('npm', ['run', 'upload:assets']);

  // ⑧ 静态资源有变 → bump sw 缓存版本
  const assetChanged = changedPaths([
    'public/images', 'public/assets/figma', 'public/assets/install', 'public/assets/audio',
  ]).length > 0;
  if (assetChanged) {
    console.log('\n' + C.b('⑧ 静态资源有变 → bump sw.js CACHE_VERSION'));
    const v = bumpSwVersion();
    if (v) console.log(`   ${v}`);
  } else console.log(C.dim('⑧ public 静态资源无变化,不 bump sw.js'));

  // ⑨ 提交(只素材+数据)+ push —— 素材永远上线到 main,无论当前在哪个分支
  console.log('\n' + C.b('⑨ 提交(只素材+数据,不含手改代码)→ 推送到 main'));
  const summary = did.length ? did.join(' + ') : 'assets';
  const msg = `Assets/data: update (${summary})`;
  const branch = sh('git rev-parse --abbrev-ref HEAD').trim();

  if (branch === 'main') {
    // 在 main 上:照常 add + commit + push origin main
    sh(`git add -- ${STAGE_PATHS.map((p) => `'${p}'`).join(' ')}`);
    const staged = sh('git diff --cached --name-only').trim();
    if (!staged) { console.log(C.g('   没有需要提交的改动,全部已最新。结束。')); return; }
    console.log('   将提交:\n' + staged.split('\n').map((l) => '     ' + l).join('\n'));
    sh(`git commit -m ${JSON.stringify(msg)}`);
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
    return;
  }

  // 不在 main:把素材改动单独打包成一个 commit,直接叠到最新的 origin/main 上推送。
  // 这样既不污染当前分支,也绝不会把当前分支正在改的代码一起带上线。
  console.log(C.y(`   ⚠ 当前在「${branch}」分支(不是 main)。素材会单独打包推到 main,本分支代码不受影响。`));
  sh('git fetch origin main');
  const tmpIdx = path.join(ROOT, '.git', 'publish-tmp-index');
  const gitEnv = { ...process.env, GIT_INDEX_FILE: tmpIdx };
  const shEnv = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', env: gitEnv });
  try {
    // 以 origin/main 的内容为底,只把素材路径的工作区状态叠上去
    shEnv('git read-tree origin/main');
    shEnv(`git add -A -- ${STAGE_PATHS.map((p) => `'${p}'`).join(' ')}`);
    const tree = shEnv('git write-tree').trim();
    const baseTree = sh('git rev-parse origin/main^{tree}').trim();
    if (tree === baseTree) { console.log(C.g('   素材与 main 上已一致,无需上线。结束。')); return; }
    const commit = execSync(`git commit-tree ${tree} -p origin/main`, { cwd: ROOT, encoding: 'utf8', input: msg }).trim();
    const staged = sh(`git diff --name-only origin/main ${commit}`).trim();
    console.log('   将上线到 main:\n' + staged.split('\n').map((l) => '     ' + l).join('\n'));
    const ok = await confirmYesNo('\n确认 push 到 main 上线?(必须输入 y 才会上线)[y/n] ');
    if (ok) {
      run('git', ['push', 'origin', `${commit}:main`]);
      sh(`git update-ref refs/heads/main ${commit}`); // 同步本地 main(未被 checkout,安全)
      console.log('\n' + C.g('✅ 已上线到 main,Vercel 正在自动构建。'));
      console.log(C.dim(`   (素材改动仍留在「${branch}」工作区,已同样在 main 上;本分支代码未受影响)`));
    } else {
      console.log('\n' + C.y(C.b('⚠️  你选了 n —— 没有上线!素材改动还在本分支工作区。')));
    }
  } finally {
    try { execSync(`rm -f '${tmpIdx}'`, { cwd: ROOT }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
