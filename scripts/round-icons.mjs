// One-off: bake iOS-style rounded corners into the existing PWA icon PNGs.
// Android Chrome PWAs use the icon as-is (no auto-rounding), so we must
// pre-round to get the iOS app-icon look on the home screen.
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '..', 'public');

// iOS continuous-corner radius is ~22.37% of side length. A plain rounded
// rect at this radius is visually indistinguishable at icon sizes.
const RADIUS_RATIO = 0.2237;

const FILES = ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

for (const file of FILES) {
  const src = path.join(PUB, file);
  const meta = await sharp(src).metadata();
  const w = meta.width;
  const h = meta.height;
  const r = Math.round(Math.min(w, h) * RADIUS_RATIO);

  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
       <rect x="0" y="0" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="white"/>
     </svg>`
  );

  const out = await sharp(src)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  await sharp(out).toFile(src);
  console.log(`rounded ${file} (${w}x${h}, r=${r})`);
}
