import { readFile, readdir, mkdir, copyFile, rename, writeFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, ['scripts/check.mjs'], { cwd: root, stdio: 'inherit' });
// Packaging validates source files; test suites run through the separate test command.
const { version } = JSON.parse(await readFile(join(root, 'extension/manifest.json'), 'utf8'));
const label = `uchicago-login-assistant-${version}`;
const dist = join(root, 'dist');
const staging = join(dist, label);
const packaged = [];
async function copyTree(relative) {
  for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
    if (item.name === '.DS_Store') continue;
    if (item.isSymbolicLink()) throw new Error('Package may not include symlinks');
    const path = join(relative, item.name);
    if (item.isDirectory()) await copyTree(path);
    else {
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await copyFile(join(root, path), join(staging, path));
      packaged.push(path);
    }
  }
}
await mkdir(staging, { recursive: true });
for (const folder of ['extension', 'docs', 'scripts', 'test']) await copyTree(folder);
const documents = ['README.md', 'README_zh.md', 'package.json', '.gitignore'];
for (const file of ['CHANGELOG.md', 'CHANGELOG_zh.md']) {
  try { await access(join(root, file)); documents.push(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
for (const file of documents) {
  await copyFile(join(root, file), join(staging, file));
  packaged.push(file);
}
const temporary = join(dist, `${label}-${process.pid}.zip`);
const output = join(dist, `${label}.zip`);
execFileSync('/usr/bin/zip', ['-q', '-X', temporary, ...packaged.sort().map(f => `${label}/${f}`)], { cwd: dist, stdio: 'inherit' });
await rename(temporary, output);
const digest = createHash('sha256').update(await readFile(output)).digest('hex');
await writeFile(`${output}.sha256`, `${digest}  ${label}.zip\n`);
console.log(`Package: ${output}\nSHA-256: ${digest}\nContents: extension, documentation, scripts, and tests.`);
