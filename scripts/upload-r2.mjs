#!/usr/bin/env node
// ============================================================================
// Upload Public Assets to Cloudflare R2
// ----------------------------------------------------------------------------
// Walks public/images, public/assets/figma, public/assets/install (images →
// shared src/utils/asset-manifest.json) and public/assets/audio/<lang>/ (audio →
// per-language src/data/audio-manifest/<lang>.json). Computes a content hash for
// each file, compares against the relevant manifest, and uploads only changed/new
// files via the S3-compatible R2 API using a bounded-concurrency pool. Updates
// each manifest after successful uploads and prunes entries whose local file no
// longer exists.
//
// Audio language directories are discovered dynamically (any new
// public/assets/audio/<lang>/ is picked up with zero code changes), and audio
// keys/URLs are kept out of the shared image manifest so the main bundle stays
// decoupled from the audio total (designed to scale to tens of thousands).
//
// Usage:
//   node scripts/upload-r2.mjs           # diff-only upload
//   node scripts/upload-r2.mjs --dry     # show plan, no network
//   node scripts/upload-r2.mjs --force   # re-upload everything
//
// Requires .env.local with:
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT
// ============================================================================

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import {
  readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync,
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

// Audio lives under public/assets/audio/<lang>/<audioKey>.mp3. Each language gets
// its own manifest so the runtime can lazy-load just the languages in use.
const AUDIO_ROOT = join(ROOT, 'public', 'assets', 'audio');
const AUDIO_MANIFEST_DIR = join(ROOT, 'src', 'data', 'audio-manifest');

// Parallel PUTs. Sequential awaits are fine for ~300 images but unworkable for
// the tens of thousands of audio files this is designed to scale to.
const UPLOAD_CONCURRENCY = 16;

const IMAGE_CONTENT_TYPES = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
};

const AUDIO_CONTENT_TYPE = 'audio/mpeg';

const ALLOWED_IMAGE_EXTS = new Set(Object.keys(IMAGE_CONTENT_TYPES));
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

function loadManifest(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return {}; }
}

function writeManifest(path, manifest) {
  const sorted = Object.keys(manifest).sort().reduce((acc, k) => {
    acc[k] = manifest[k];
    return acc;
  }, {});
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n');
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
    if (!ALLOWED_IMAGE_EXTS.has(ext)) continue;
    const key = posix.join(root.keyPrefix, name);
    out.push({ full, key, ext, size: st.size, contentType: IMAGE_CONTENT_TYPES[ext] });
  }
  return out;
}

// Discover audio language directories dynamically so adding a new language needs
// zero changes here.
function discoverAudioLangs() {
  if (!existsSync(AUDIO_ROOT)) return [];
  return readdirSync(AUDIO_ROOT)
    .filter((name) => !name.startsWith('.') && statSync(join(AUDIO_ROOT, name)).isDirectory())
    .sort();
}

function collectAudioFiles(lang) {
  const dir = join(AUDIO_ROOT, lang);
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    if (extname(name).toLowerCase() !== '.mp3') continue;
    // R2 key mirrors public/ layout; manifest key is the bare audioKey (basename).
    const key = posix.join('assets/audio', lang, name);
    const manifestKey = name.slice(0, -'.mp3'.length);
    out.push({ full, key, manifestKey, ext: '.mp3', size: statSync(full).size, contentType: AUDIO_CONTENT_TYPE });
  }
  return out;
}

// Bounded-concurrency runner: keeps `limit` workers pulling from the shared
// queue until exhausted.
async function runPool(items, limit, worker) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
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

  // A "group" is a set of files sharing one manifest: one for all images, plus
  // one per audio language. keyOf maps a file to its manifest key.
  const groups = [];

  const imageFiles = [];
  for (const root of ASSET_ROOTS) imageFiles.push(...collectFiles(root));
  groups.push({
    label: 'images',
    manifestPath: MANIFEST_PATH,
    files: imageFiles,
    keyOf: (f) => f.key,
    // For images the manifest key IS the R2 object key (images/<name>).
    r2KeyOf: (mk) => mk,
  });

  for (const lang of discoverAudioLangs()) {
    const files = collectAudioFiles(lang);
    if (!files.length) continue;
    groups.push({
      label: `audio/${lang}`,
      manifestPath: join(AUDIO_MANIFEST_DIR, `${lang}.json`),
      files,
      keyOf: (f) => f.manifestKey,
      // Audio manifest keys are bare audioKeys; the R2 object lives under
      // assets/audio/<lang>/<audioKey>.mp3.
      r2KeyOf: (mk) => posix.join('assets/audio', lang, `${mk}.mp3`),
    });
  }

  let uploaded = 0;
  let skipped = 0;
  let totalBytes = 0;
  let failed = 0;

  // Hash every file (local only) to decide what needs uploading. Buffers are not
  // retained — changed files are re-read at upload time so memory stays bounded
  // even with tens of thousands of audio files.
  const tasks = [];
  for (const g of groups) {
    g.current = loadManifest(g.manifestPath);
    g.next = FORCE ? {} : { ...g.current };
    g.seen = new Set();
    g.changed = FORCE && g.files.length > 0;
    for (const f of g.files) {
      const mk = g.keyOf(f);
      g.seen.add(mk);
      const previous = g.current[mk];
      const hash = hashFile(readFileSync(f.full));
      if (!FORCE && previous === hash) {
        skipped++;
        continue;
      }
      tasks.push({ group: g, file: f, manifestKey: mk, hash, previous });
    }
  }

  await runPool(tasks, UPLOAD_CONCURRENCY, async (t) => {
    const { file: f, group: g } = t;
    const label = `${f.key.padEnd(48)} ${fmt(f.size).padStart(7)}`;
    const tag = `${t.previous ? t.previous + '→' : ''}${t.hash}`;

    if (DRY) {
      console.log(`[dry] ↑ ${label}  ${tag}`);
      g.next[t.manifestKey] = t.hash;
      g.changed = true;
      uploaded++;
      totalBytes += f.size;
      return;
    }

    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: f.key,
        Body: readFileSync(f.full),
        ContentType: f.contentType,
        CacheControl: CACHE_CONTROL,
      }));
      g.next[t.manifestKey] = t.hash;
      g.changed = true;
      uploaded++;
      totalBytes += f.size;
      console.log(`↑ ${label}  ${tag}`);
    } catch (err) {
      failed++;
      console.warn(`✗ ${label}  ${err.name}: ${err.message}`);
    }
  });

  // Prune manifest entries whose local file is gone, then persist each manifest.
  // A pruned entry also means the object should be removed from R2 — otherwise a
  // renamed/deleted image (e.g. the old guessable apple.jpg, Phase 5) keeps
  // serving from the CDN and the side-door stays open.
  let pruned = 0;
  const deleteQueue = [];
  for (const g of groups) {
    for (const key of Object.keys(g.next)) {
      if (!g.seen.has(key)) {
        delete g.next[key];
        pruned++;
        g.changed = true;
        deleteQueue.push({ label: g.label, r2Key: g.r2KeyOf(key) });
        console.log(`− ${g.label}:${key} (removed locally; pruned from manifest)`);
      }
    }
    if (!DRY && g.changed) {
      mkdirSync(dirname(g.manifestPath), { recursive: true });
      writeManifest(g.manifestPath, g.next);
    }
  }

  // Delete the pruned objects from R2.
  let deleted = 0;
  let deleteFailed = 0;
  if (deleteQueue.length) {
    if (DRY) {
      for (const d of deleteQueue) console.log(`[dry] ✗ delete R2 ${d.r2Key}`);
      deleted = deleteQueue.length;
    } else {
      await runPool(deleteQueue, UPLOAD_CONCURRENCY, async (d) => {
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: d.r2Key }));
          deleted++;
          console.log(`✗ deleted R2 ${d.r2Key}`);
        } catch (err) {
          deleteFailed++;
          console.warn(`! could not delete R2 ${d.r2Key}  ${err.name}: ${err.message}`);
        }
      });
    }
  }

  console.log(
    `\nDone${DRY ? ' (dry)' : ''}: ${uploaded} uploaded, ${skipped} unchanged, ${pruned} pruned, ` +
    `${deleted} R2-deleted, ${failed} failed. Total ${fmt(totalBytes)}.`
  );

  if (deleteFailed > 0) {
    console.warn(
      `\n⚠ ${deleteFailed} object(s) could NOT be deleted from R2. The old (possibly guessable) ` +
      `URLs may still serve — check the R2 token has DeleteObject permission, then re-run.`
    );
  }

  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
