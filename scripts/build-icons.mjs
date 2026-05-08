// Build PWA icons + favicons.
//
// Two source files in public/:
//   - icon-source.png  → app icon (apple-touch-icon, PWA 192/512)
//                        white background gets trimmed; corners rounded for PWA.
//   - favicon.png      → tiny browser-tab icon (favicon-16/32)
//                        already designed for small display (transparent bg);
//                        just resized + compressed.
//
// Replace either source file and re-run; this script is idempotent.
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '..', 'public');
const ICONS_DIR = path.join(PUB, 'icons');
const ICON_SRC = path.join(ICONS_DIR, 'icon-source.png');
const FAVI_SRC = path.join(ICONS_DIR, 'favicon.png');

const RADIUS_RATIO = 0.2237;
const INSET_RATIO = 0.04;
const TRIM_THRESHOLD = 12;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

// inset = breathing room as a fraction of the output size.
//   icon: 4% (rounded corners would clip subject if it touched edges)
//   favicon: 2% (favicons don't get rounded; fill aggressively for legibility at 16/32px)
const TARGETS = [
  { src: 'favicon', out: 'favicon-16.png',       size: 16,  round: false, inset: 0.02 },
  { src: 'favicon', out: 'favicon-32.png',       size: 32,  round: false, inset: 0.02 },
  { src: 'icon',    out: 'apple-touch-icon.png', size: 180, round: false, inset: INSET_RATIO },
  { src: 'icon',    out: 'icon-192.png',         size: 192, round: true,  inset: INSET_RATIO },
  { src: 'icon',    out: 'icon-512.png',         size: 512, round: true,  inset: INSET_RATIO },
];

// Pre-trim each source: icon-source.png trims white bg, favicon.png trims transparent bg.
const trimmedIcon = await sharp(ICON_SRC)
  .trim({ background: '#ffffff', threshold: TRIM_THRESHOLD })
  .toBuffer();
const trimmedFavi = await sharp(FAVI_SRC)
  .trim({ threshold: 1 })
  .toBuffer();

for (const { src, out, size, round, inset: insetRatio } of TARGETS) {
  const outPath = path.join(ICONS_DIR, out);
  const trimmed = src === 'favicon' ? trimmedFavi : trimmedIcon;
  const inset = Math.round(size * insetRatio);
  const inner = size - inset * 2;
  const inputBuf = await sharp(trimmed)
    .resize(inner, inner, { fit: 'contain', background: TRANSPARENT })
    .extend({
      top: inset, bottom: inset, left: inset, right: inset,
      background: TRANSPARENT,
    })
    .toBuffer();

  let pipeline = sharp(inputBuf);

  if (round) {
    const r = Math.round(size * RADIUS_RATIO);
    const mask = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
        `<rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="white"/>` +
      `</svg>`
    );
    pipeline = pipeline.composite([{ input: mask, blend: 'dest-in' }]);
  }

  await pipeline.png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 }).toFile(outPath);
  console.log(out, '→', size + 'x' + size, round ? 'rounded' : '');
}
