import sharp from 'sharp';

const SRC = '/tmp/icon-source.png';
const OUT = '/Users/miaofang/Desktop/VocabWorkspace/public';

const targets = [
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
];

for (const { file, size } of targets) {
  await sharp(SRC)
    .resize(size, size, { fit: 'cover' })
    .png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 })
    .toFile(`${OUT}/${file}`);
  console.log(`${file} → ${size}x${size}`);
}
