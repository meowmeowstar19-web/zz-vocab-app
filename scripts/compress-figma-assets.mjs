#!/usr/bin/env node
// ============================================================================
// Compress Figma Assets
// ----------------------------------------------------------------------------
// Compresses PNG/JPG/WebP files in public/assets/figma/ in place using sharp.
// Tracks already-processed files via .compressed-manifest.json (fingerprint =
// post-compression size+mtime); if the user replaces a file, the fingerprint
// changes and it gets re-processed next run. SVGs are ignored.
//
// Usage: node scripts/compress-figma-assets.mjs [--dry] [--force]
//   --dry    show what would change without writing
//   --force  ignore manifest, recompress everything
// ============================================================================

import sharp from 'sharp';
import {
  readdirSync, readFileSync, writeFileSync, statSync, renameSync, unlinkSync,
  existsSync,
} from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ASSET_DIR = join(ROOT, 'public', 'assets', 'figma');
const MANIFEST = join(ASSET_DIR, '.compressed-manifest.json');

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

const EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function loadManifest() {
  if (!existsSync(MANIFEST)) return {};
  try { return JSON.parse(readFileSync(MANIFEST, 'utf8')); }
  catch { return {}; }
}

function fingerprint(filePath) {
  const s = statSync(filePath);
  return `${s.size}:${Math.floor(s.mtimeMs)}`;
}

async function compressOne(filePath) {
  const ext = extname(filePath).toLowerCase();
  const buf = readFileSync(filePath);
  const before = buf.length;
  let out;

  if (ext === '.png') {
    // palette + max effort gives best lossless-ish PNG compression
    out = await sharp(buf).png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 }).toBuffer();
  } else if (ext === '.jpg' || ext === '.jpeg') {
    out = await sharp(buf).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  } else if (ext === '.webp') {
    out = await sharp(buf).webp({ quality: 85, effort: 6 }).toBuffer();
  } else {
    return { skipped: true };
  }

  // Only keep result if it actually shrinks (>2% saving threshold to avoid churn)
  if (out.length >= before * 0.98) {
    return { before, after: before, kept: false };
  }
  if (!DRY) {
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, out);
    renameSync(tmp, filePath);
  }
  return { before, after: out.length, kept: true };
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

async function main() {
  if (!existsSync(ASSET_DIR)) {
    console.error(`asset dir not found: ${ASSET_DIR}`);
    process.exit(1);
  }
  const manifest = FORCE ? {} : loadManifest();
  const files = readdirSync(ASSET_DIR)
    .filter(f => !f.startsWith('.') && EXTS.has(extname(f).toLowerCase()))
    .sort();

  let processed = 0, skipped = 0, savedTotal = 0;
  const newManifest = { ...manifest };

  for (const file of files) {
    const full = join(ASSET_DIR, file);
    const fp = fingerprint(full);
    if (manifest[file] === fp) {
      skipped++;
      continue;
    }
    try {
      const r = await compressOne(full);
      if (r.skipped) continue;
      if (r.kept) {
        const saved = r.before - r.after;
        savedTotal += saved;
        const pct = ((saved / r.before) * 100).toFixed(0);
        console.log(`${DRY ? '[dry] ' : ''}✓ ${file.padEnd(36)} ${fmt(r.before)} → ${fmt(r.after)}  (-${pct}%)`);
        processed++;
        if (!DRY) newManifest[file] = fingerprint(full);
      } else {
        // No savings — record fingerprint anyway so we don't retry
        console.log(`· ${file.padEnd(36)} ${fmt(r.before)} (already optimal, skipping next run)`);
        if (!DRY) newManifest[file] = fp;
      }
    } catch (err) {
      console.warn(`! ${file}: ${err.message}`);
    }
  }

  // Drop manifest entries for files that no longer exist
  for (const k of Object.keys(newManifest)) {
    if (!existsSync(join(ASSET_DIR, k))) delete newManifest[k];
  }

  if (!DRY) writeFileSync(MANIFEST, JSON.stringify(newManifest, null, 2));

  console.log(`\nDone: ${processed} compressed, ${skipped} already done, total saved ${fmt(savedTotal)}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
