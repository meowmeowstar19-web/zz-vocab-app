// One-off: produce iOS/macOS-style PWA icons.
// - Reads SOURCE icons from public/icon-source-*.png (originals, no rounding)
// - Writes finished icons to public/{apple-touch-icon,icon-192,icon-512}.png
// - Each finished icon places the artwork inside ~78% of the canvas so that
//   the installed icon matches the size of other home-screen / Dock apps,
//   with iOS-style 22.37% rounded corners on the artwork itself.
// - If no source files are present, falls back to re-padding the current
//   public icons in place (idempotent — safe to re-run).
import sharp from 'sharp';
import path from 'path';
import { existsSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '..', 'public');

const RADIUS_RATIO = 0.2237;
const ARTWORK_RATIO = 0.78;

const TARGETS = [
  { out: 'apple-touch-icon.png', size: 180 },
  { out: 'icon-192.png',         size: 192 },
  { out: 'icon-512.png',         size: 512 },
];

async function process(srcBuf, size, outPath) {
  const innerSize = Math.round(size * ARTWORK_RATIO);
  const offset = Math.round((size - innerSize) / 2);
  const r = Math.round(innerSize * RADIUS_RATIO);

  const inner = await sharp(srcBuf)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(innerSize, innerSize, { fit: 'cover' })
    .toBuffer();

  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${innerSize}" height="${innerSize}">
       <rect x="0" y="0" width="${innerSize}" height="${innerSize}" rx="${r}" ry="${r}" fill="white"/>
     </svg>`
  );
  const rounded = await sharp(inner)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const tmp = outPath + '.tmp';
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: rounded, left: offset, top: offset }])
    .png({ compressionLevel: 9 })
    .toFile(tmp);

  await sharp(tmp).toFile(outPath);
  unlinkSync(tmp);
}

for (const { out, size } of TARGETS) {
  const dest = path.join(PUB, out);
  // Prefer a per-size source if present, otherwise fall back to the current
  // public icon. The current public icon already has padding/rounding from
  // a previous run — re-running compounds inset, so use a source if you can.
  const src = ['icon-source-' + size + '.png', out]
    .map((n) => path.join(PUB, n))
    .find((p) => existsSync(p));
  await process(src, size, dest);
  console.log('processed', out, '→', size + 'x' + size);
}
