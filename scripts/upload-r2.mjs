#!/usr/bin/env node
// ============================================================================
// Upload Public Assets to Cloudflare R2
// ----------------------------------------------------------------------------
// Walks public/images, public/assets/figma, public/assets/install. Computes a
// content hash for each file, compares against src/utils/asset-manifest.json,
// and uploads only changed/new files via the S3-compatible R2 API. Updates the
// manifest after each successful upload and prunes entries whose local file no
// longer exists.
//
// Usage:
//   node scripts/upload-r2.mjs           # diff-only upload
//   node scripts/upload-r2.mjs --dry     # show plan, no network
//   node scripts/upload-r2.mjs --force   # re-upload everything
//
// Requires .env.local with:
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT
// ============================================================================

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import {
  readdirSync, readFileSync, writeFileSync, statSync, existsSync,
} from 'node:fs';
import { join, dirname, extname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');

const ASSET_ROOTS = [
  { abs: join(ROOT, 'public', 'images'),         keyPrefix: 'images' },
  { abs: join(ROOT, 'public', 'assets', 'figma'), keyPrefix: 'assets/figma' },
  { abs: join(ROOT, 'public', 'assets', 'install'), keyPrefix: 'assets/install' },
];

const MANIFEST_PATH = join(ROOT, 'src', 'utils', 'asset-manifest.json');

const CONTENT_TYPES = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
};

const ALLOWED_EXTS = new Set(Object.keys(CONTENT_TYPES));
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

function loadEnv() {
  const envPath = join(ROOT, '.env.local');
  if (!existsSync(envPath)) {
    console.error('✗ .env.local not found at', envPath);
    process.exit(1);
  }
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k] === undefined) {
      process.env[k] = v.replace(/^["']|["']$/g, '');
    }
  }
  const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('✗ missing env vars:', missing.join(', '));
    process.exit(1);
  }
}

function hashFile(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return {};
  try { return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')); }
  catch { return {}; }
}

function writeManifest(manifest) {
  const sorted = Object.keys(manifest).sort().reduce((acc, k) => {
    acc[k] = manifest[k];
    return acc;
  }, {});
  writeFileSync(MANIFEST_PATH, JSON.stringify(sorted, null, 2) + '\n');
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function collectFiles(root) {
  if (!existsSync(root.abs)) return [];
  const out = [];
  for (const name of readdirSync(root.abs).sort()) {
    if (name.startsWith('.')) continue;
    const full = join(root.abs, name);
    const st = statSync(full);
    if (!st.isFile()) continue;
    const ext = extname(name).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) continue;
    const key = posix.join(root.keyPrefix, name);
    out.push({ full, key, ext, size: st.size });
  }
  return out;
}

async function main() {
  loadEnv();

  const client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  const bucket = process.env.R2_BUCKET;

  const manifest = loadManifest();
  const nextManifest = FORCE ? {} : { ...manifest };

  let uploaded = 0;
  let skipped = 0;
  let totalBytes = 0;
  let failed = 0;
  const seenKeys = new Set();

  for (const root of ASSET_ROOTS) {
    const files = collectFiles(root);
    for (const f of files) {
      seenKeys.add(f.key);
      const buf = readFileSync(f.full);
      const hash = hashFile(buf);
      const previous = manifest[f.key];

      if (!FORCE && previous === hash) {
        skipped++;
        continue;
      }

      const contentType = CONTENT_TYPES[f.ext];
      const label = `${f.key.padEnd(44)} ${fmt(f.size).padStart(7)}`;

      if (DRY) {
        console.log(`[dry] ↑ ${label}  ${previous ? previous + '→' : ''}${hash}`);
        nextManifest[f.key] = hash;
        uploaded++;
        totalBytes += f.size;
        continue;
      }

      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: f.key,
          Body: buf,
          ContentType: contentType,
          CacheControl: CACHE_CONTROL,
        }));
        nextManifest[f.key] = hash;
        uploaded++;
        totalBytes += f.size;
        console.log(`↑ ${label}  ${previous ? previous + '→' : ''}${hash}`);
      } catch (err) {
        failed++;
        console.warn(`✗ ${label}  ${err.name}: ${err.message}`);
      }
    }
  }

  // Prune manifest entries whose local file is gone
  let pruned = 0;
  for (const key of Object.keys(nextManifest)) {
    if (!seenKeys.has(key)) {
      delete nextManifest[key];
      pruned++;
      console.log(`− ${key} (removed locally; pruned from manifest)`);
    }
  }

  if (!DRY && (uploaded > 0 || pruned > 0 || FORCE)) {
    writeManifest(nextManifest);
  }

  console.log(
    `\nDone${DRY ? ' (dry)' : ''}: ${uploaded} uploaded, ${skipped} unchanged, ${pruned} pruned, ${failed} failed. ` +
    `Total ${fmt(totalBytes)}.`
  );

  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
