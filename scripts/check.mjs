import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import chinese from '../extension/locales/zh-CN.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(root, 'extension');
async function walk(path) {
  const result = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    assert.ok(!item.isSymbolicLink(), `Symlinks are not packaged: ${item.name}`);
    if (item.isDirectory()) result.push(...await walk(join(path, item.name)));
    else result.push(join(path, item.name));
  }
  return result;
}
const files = await walk(extension);
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(packageInfo.version, manifest.version, 'Package and extension versions must agree.');
const releaseEntries = text => [...text.matchAll(/^## (\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})$/gm)].map(match => [match[1], match[2]]);
const changelogs = new Map();
for (const file of ['CHANGELOG.md', 'CHANGELOG_zh.md']) {
  let text;
  try { text = await readFile(join(root, file), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const entries = releaseEntries(text);
  assert.equal(entries[0]?.[0], manifest.version, `Changelog version does not match the manifest: ${file}`);
  changelogs.set(file, entries);
}
if (changelogs.size === 2) {
  assert.deepEqual(changelogs.get('CHANGELOG.md'), changelogs.get('CHANGELOG_zh.md'),
    'Changelog versions or dates differ between languages.');
}
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.host_permissions, ['https://uchicago.okta.com/*', 'https://*.duosecurity.com/*', 'https://portal.uchicago.edu/*', 'https://courses.uchicago.edu/*']);
assert.deepEqual(manifest.optional_host_permissions ?? [], []);
assert.ok(!manifest.permissions.some(x => ['debugger', 'cookies', 'nativeMessaging', 'management'].includes(x)));
assert.ok(!manifest.externally_connectable && !manifest.web_accessible_resources);
for (const file of [manifest.background.service_worker, manifest.options_page, manifest.action.default_popup, ...manifest.content_scripts.flatMap(s => s.js)]) {
  assert.ok(files.includes(join(extension, file)), `Missing manifest asset: ${file}`);
}
assert.deepEqual(Object.keys(manifest.icons ?? {}), ['16', '32', '48', '128']);
assert.deepEqual(Object.keys(manifest.action.default_icon ?? {}), ['16', '32', '48']);
for (const [size, file] of [...Object.entries(manifest.icons), ...Object.entries(manifest.action.default_icon)]) {
  assert.ok(files.includes(join(extension, file)), `Missing icon asset: ${file}`);
  const png = await readFile(join(extension, file));
  assert.ok(png.length >= 33, `Truncated PNG icon: ${file}`);
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), `Invalid PNG signature: ${file}`);
  assert.equal(png.readUInt32BE(8), 13, `Invalid PNG header length: ${file}`);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR', `Missing PNG header: ${file}`);
  assert.equal(png.readUInt32BE(16), Number(size), `Incorrect icon width: ${file}`);
  assert.equal(png.readUInt32BE(20), Number(size), `Incorrect icon height: ${file}`);
  assert.equal(png[24], 8, `Icons must use 8-bit channels: ${file}`);
  assert.equal(png[25], 6, `Icons must use RGBA to support transparent rounded corners: ${file}`);
}
let scripts = 0;
for (const file of files) {
  if (file.endsWith('.js')) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); scripts++;
    const source = await readFile(file, 'utf8');
    assert.ok(!/\beval\s*\(|\bnew Function\s*\(|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/.test(source), `Unexpected remote execution or network API: ${file}`);
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('./') || match[1].startsWith('../'), `Unexpected external import: ${file}`);
      await access(resolve(dirname(file), match[1]));
    }
  }
  if (file.endsWith('.html')) {
    const html = await readFile(file, 'utf8');
    assert.match(html, /<html lang="en-US">/, `Missing initial document language: ${file}`);
    for (const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bdata-i18n(?:="([^"]*)")?[^>]*>([^<>]*)<\/\1>/gi)) {
      const message = match[2] || match[3].trim().replaceAll('&amp;', '&');
      assert.ok(Object.hasOwn(chinese, message), `Missing Chinese translation: ${message}`);
    }
    for (const match of html.matchAll(/data-i18n-(?:aria-label|title)="([^"]+)"/g)) {
      assert.ok(Object.hasOwn(chinese, match[1]), 'Missing icon label translation: ' + match[1]);
    }
    assert.ok(!/\son[a-z]+\s*=|<script(?![^>]*\bsrc=)/i.test(html), `Inline JavaScript is incompatible with MV3: ${file}`);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, `Duplicate HTML IDs: ${file}`);
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.ok(!/^(?:https?:|\/\/)/.test(match[1]), `Unexpected external resource: ${file}`);
      if (!match[1].startsWith('#')) await access(resolve(dirname(file), match[1]));
    }
    const entry = file.replace(/\.html$/, '.js');
    const source = await readFile(entry, 'utf8');
    for (const match of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), `Missing UI element #${match[1]}: ${file}`);
  }
}
// Validate the English source files separately from the Chinese message catalog.
const englishFiles = [...files, ...await walk(join(root, 'docs')), ...await walk(join(root, 'test')), ...await walk(join(root, 'scripts')), join(root, 'README.md'), ...(changelogs.has('CHANGELOG.md') ? [join(root, 'CHANGELOG.md')] : []), join(root, 'package.json')];
for (const file of englishFiles) {
  if (!/\.(?:js|mjs|html|css|json|md)$/.test(file)) continue;
  const source = await readFile(file, 'utf8');
  if (file !== join(extension, 'locales/zh-CN.js')) assert.ok(!/\p{Script=Han}/u.test(source), `Translation copy outside the locale catalog: ${file}`);
  if (file.startsWith(`${extension}/`)) assert.ok(!/PingFang SC|Microsoft YaHei/.test(source), `Unexpected platform-specific font: ${file}`);
}
// Compare document structure while allowing each language its own prose and switch link.
function readmeStructure(text, languageTarget) {
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
  return {
    headingLevels: [...prose.matchAll(/^(#{1,6}) /gm)].map(match => match[1].length),
    tables: [...prose.matchAll(/(?:^\|.*\|\n)+/gm)].map(match =>
      match[0].trim().split('\n').map(row => row.split('|').length - 2)),
    code: [...prose.matchAll(/`([^`\n]+)`/g)].map(match => match[1]).sort(),
    links: [...prose.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)].map(match => match[1])
      .filter(target => !target.startsWith('#'))
      .map(target => target === languageTarget ? 'language-switch' : target).sort(),
    commands: [...text.matchAll(/^```sh\n([\s\S]*?)^```/gm)].flatMap(match =>
      match[1].split('\n').map(line => line.replace(/\s+#.*$/, '').trim()).filter(Boolean))
  };
}
const englishReadme = await readFile(join(root, 'README.md'), 'utf8');
const chineseReadme = await readFile(join(root, 'README_zh.md'), 'utf8');
assert.deepEqual(readmeStructure(chineseReadme, 'README.md'), readmeStructure(englishReadme, 'README_zh.md'),
  'README sections, tables, code examples, or links differ between languages.');
console.log(`Static checks passed: ${files.length} extension files and ${scripts} JavaScript modules; manifest, icons, imports, interface bindings, localization, and documentation.`);
