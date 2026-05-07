// Build PWA icons from a single source image: public/icon-source-192.png.
// - apple-touch-icon.png (180): plain copy, iOS rounds corners itself.
// - icon-192.png / icon-512.png: same artwork with iOS-style rounded corners
//   baked in, since Chrome's installed PWA does not round automatically.
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '..', 'public');
const SRC = path.join(PUB, 'icon-source-192.png');

const RADIUS_RATIO = 0.2237;

const TARGETS = [
  { out: 'apple-touch-icon.png', size: 180, round: false },
  { out: 'icon-192.png',         size: 192, round: true  },
  { out: 'icon-512.png',         size: 512, round: true  },
];

for (const { out, size, round } of TARGETS) {
  const outPath = path.join(PUB, out);
  const base = sharp(SRC).resize(size, size, { fit: 'cover' });

  if (!round) {
    await base.png({ compressionLevel: 9 }).toFile(outPath);
    console.log(out, '→', size + 'x' + size);
    continue;
  }

  const r = Math.round(size * RADIUS_RATIO);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="white"/>` +
    `</svg>`
  );
  await base
    .composite([{ input: mask, blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(out, '→', size + 'x' + size, 'rounded');
}
