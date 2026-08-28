import { readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const available = (await readdir(resolve(root, 'test'))).filter(name => name.endsWith('.test.js')).sort();
const requested = process.argv.slice(2);
const all = requested.length === 1 && requested[0] === '--all';
const names = all ? available : (requested.length ? requested : ['ui', 'locale', 'theme'])
  .map(name => name.replace(/^test\//, '').replace(/\.test\.js$/, '') + '.test.js');
if (!names.length || names.some(name => !available.includes(name))) {
  console.error('Choose existing test suites by name, or use --all explicitly.');
  process.exit(1);
}
const files = [...new Set(names)].map(name => 'test/' + name);
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
});
if (result.error) throw result.error;
const total = result.stdout.match(/^# tests (\d+)$/m)?.[1];
const passed = result.stdout.match(/^# pass (\d+)$/m)?.[1];
if (result.status === 0 && total && passed) {
  console.log(`Tests: ${passed}/${total} passed (${files.length} suites).`);
} else {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status || 1;
}
