import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Use the installed Sharp package or the entry module supplied on the command line.
const sharpModule = process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : 'sharp';
const { default: sharp } = await import(sharpModule);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'docs/assets/phoenix-key-master.png'));
const { width, height } = await sharp(source).metadata();
assert.ok(width && width === height, 'The source icon must be square');

const radius = width / 4;
const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="${radius}" fill="white"/></svg>`);
const rounded = await sharp(source).ensureAlpha()
  .composite([{ input: mask, blend: 'dest-in' }])
  .png({ compressionLevel: 9 }).toBuffer();
const before = await sharp(source).ensureAlpha().raw().toBuffer();
const after = await sharp(rounded).ensureAlpha().raw().toBuffer();
let preserved = 0;
for (let offset = 0; offset < after.length; offset += 4) {
  if (after[offset + 3] !== 255) continue;
  assert.ok(before.subarray(offset, offset + 4).equals(after.subarray(offset, offset + 4)), 'The mask must preserve opaque artwork pixels');
  preserved++;
}
assert.ok(preserved > width * height * 0.9, 'Only the outer corners may be removed');

const outputs = [['docs/assets/phoenix-key-rounded.png', rounded, width]];
for (const size of [16, 32, 48, 128]) {
  const png = await sharp(rounded).resize(size, size, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9 }).toBuffer();
  outputs.push([`extension/icons/icon-${size}.png`, png, size]);
}

// Validate all output buffers before writing any assets.
for (const [file, png, size] of outputs) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, size, `Incorrect width: ${file}`);
  assert.equal(info.height, size, `Incorrect height: ${file}`);
  assert.equal(info.channels, 4, `Missing alpha channel: ${file}`);
  const alpha = (x, y) => data[(y * size + x) * 4 + 3];
  for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
    assert.equal(alpha(x, y), 0, `Corner must be fully transparent: ${file}`);
  }
  const middle = Math.floor(size / 2);
  for (const [x, y] of [[middle, middle], [middle, 0], [middle, size - 1], [0, middle], [size - 1, middle]]) {
    assert.equal(alpha(x, y), 255, `Interior and straight edges must stay opaque: ${file}`);
  }
  assert.ok(data.some((value, offset) => offset % 4 === 3 && value > 0 && value < 255), `Rounded edges must be antialiased: ${file}`);
}
for (const [file, png] of outputs) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), png);
}
console.log(`Exported ${outputs.length} rounded PNGs with transparent corners. Preserved ${preserved} opaque source pixels; the original master is unchanged.`);
