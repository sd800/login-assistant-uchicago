import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(root, 'web');
const documents = new Map();
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Website contains a symlink: ${path}`);
    assert.ok(!['.DS_Store', '.env', 'notes.md'].includes(entry.name), `Unexpected website file: ${path}`);
    if (entry.isDirectory()) await walk(path);
    else files.push(path);
  }
}
await walk(web);

for (const [name, language] of [['index.html', 'en-US'], ['zh.html', 'zh-CN']]) {
  const path = resolve(web, name);
  const source = await readFile(path, 'utf8');
  assert.ok(source.startsWith('<!doctype html>'), `Missing doctype: ${name}`);
  assert.ok(source.includes(`<html lang="${language}">`), `Incorrect language: ${name}`);
  assert.match(source, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(source, /<meta name="description" content="[^"]+">/);
  assert.match(source, /<link rel="canonical" href="https:\/\/uchi-login\.songming\.org\//);
  assert.equal([...source.matchAll(/<h1\b/g)].length, 1, `Expected one primary heading: ${name}`);
  assert.ok(!/type="module"|<base\b|\son\w+=|<script(?![^>]*\bsrc=)/i.test(source), `Use local classic scripts for file navigation: ${name}`);
  const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, `Duplicate IDs: ${name}`);
  documents.set(path, { source, ids: new Set(ids) });
}

for (const [path, { source }] of documents) {
  for (const match of source.matchAll(/<([\w-]+)\b[^>]*\b(src|href)="([^"]+)"[^>]*>/g)) {
    const [, tag, attribute, target] = match;
    const url = new URL(target, pathToFileURL(path));
    if (url.protocol !== 'file:') {
      assert.equal(url.protocol, 'https:', `Use HTTPS for outbound links: ${target}`);
      assert.notEqual(attribute, 'src', `Keep all page resources local: ${target}`);
      assert.notEqual(tag, 'use', `Keep icons local: ${target}`);
      assert.ok(['a', 'link'].includes(tag), `Unexpected external dependency: ${target}`);
      continue;
    }
    const local = fileURLToPath(url);
    assert.ok(local.startsWith(web + sep), `Reference escapes the web folder: ${target}`);
    assert.ok(!target.startsWith('/'), `Use relative paths for local browsing: ${target}`);
    await stat(local);
    if (url.hash) {
      const document = documents.get(local);
      assert.ok(document, `Fragment target is not a page: ${target}`);
      assert.ok(document.ids.has(decodeURIComponent(url.hash.slice(1))), `Missing fragment: ${target}`);
    }
  }
  for (const match of source.matchAll(/\b(?:aria-labelledby|aria-describedby)="([^"]+)"/g)) {
    for (const id of match[1].split(/\s+/)) assert.ok(documents.get(path).ids.has(id), `Missing accessibility target: ${id}`);
  }
}

const english = documents.get(resolve(web, 'index.html'));
const chinese = documents.get(resolve(web, 'zh.html'));
assert.deepEqual([...english.ids], [...chinese.ids], 'Both languages must keep equivalent page structure.');
const controls = source => [...source.matchAll(/data-(demo(?:-[\w-]+)?|copy(?:-[\w-]+)?)(?:="[^"]*")?/g)].map(match => match[1]);
assert.deepEqual(controls(english.source), controls(chinese.source), 'Both languages must expose the same interactions.');

for (const file of files.filter(path => extname(path) === '.js')) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  const source = await readFile(file, 'utf8');
  assert.ok(!/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bimport\s*\(/.test(source), 'Website interactions must run from local files.');
}
const css = await readFile(resolve(web, 'assets/site.css'), 'utf8');
assert.ok(!/@import\b|url\(\s*['"]?(?:https?:|\/\/)/.test(css), 'Website styling must work offline.');
assert.ok(!/letter-spacing\s*:\s*-/.test(css), 'Letter spacing must remain nonnegative.');
assert.match(css, /font-size:\s*15px/, 'Keep the body text at 15px.');
assert.match(css, /prefers-reduced-motion/, 'Respect reduced-motion preferences.');
assert.match(css, /prefers-color-scheme:\s*dark/, 'Follow the system appearance.');
const sitemap = await readFile(resolve(web, 'sitemap.xml'), 'utf8');
assert.match(sitemap, /https:\/\/uchi-login\.songming\.org\/zh\.html/);
const workflow = await readFile(resolve(root, '.github/workflows/pages.yml'), 'utf8');
assert.match(workflow, /path:\s*web\s*\n/, 'Deploy only the web directory.');
assert.match(workflow, /node scripts\/check-web\.mjs/, 'Validate the site before deployment.');
assert.match(workflow, /pages:\s*write/);
assert.match(workflow, /id-token:\s*write/);
assert.match(workflow, /github\.event_name != 'pull_request'/, 'Pull requests must run checks without deploying.');
console.log(`Website checks passed: ${documents.size} languages, ${files.length} files, local resources, links, interactions, and Pages workflow (${relative(root, web)}/).`);
