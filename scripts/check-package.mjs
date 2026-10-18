import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { listFiles, PackageManager } from '@vscode/vsce';
import { thirdPartyNoticeFragments } from './collect-third-party-notices.mjs';

// Use the same dependency-free file collection as scripts/package.mjs.
const files = await listFiles({ packageManager: PackageManager.None });
const required = new Set([
  'package.json', 'README.md', 'CHANGELOG.md', 'docs/quota-adapters.md', 'LICENSE',
  'THIRD-PARTY-NOTICES.txt',
  'package.nls.json', 'package.nls.zh-cn.json', 'package.nls.zh-tw.json',
  'media/icon-zcode-vscode.png',
  'dist/extension.js', 'dist/webview.js',
  'dist/node-sqlite3-wasm.js', 'dist/node-sqlite3-wasm.wasm',
  'dist/math/katex.min.css', 'dist/math/LICENSE',
]);
const fonts = /^dist\/math\/fonts\/[^/]+\.woff2$/;
for (const file of files) {
  assert.ok(required.has(file) || fonts.test(file), `Unexpected packaged file: ${file}`);
}
for (const file of required) assert.ok(files.includes(file), `Missing packaged file: ${file}`);
const css = await readFile('dist/math/katex.min.css', 'utf8');
for (const match of css.matchAll(/url\((?:["']?)(fonts\/[^)"']+\.woff2)(?:["']?)\)/g)) {
  assert.ok(files.includes(`dist/math/${match[1]}`), `Missing offline formula font: ${match[1]}`);
}
assert.ok(files.some(file => fonts.test(file)), 'Offline formula fonts are missing');
const notices = await readFile('THIRD-PARTY-NOTICES.txt', 'utf8');
for (const fragment of thirdPartyNoticeFragments().fragments) {
  const expected = fragment.replace(/\r\n/g, '\n').trim();
  assert.ok(expected.length > 0 && notices.includes(expected), `Third-party notices are missing installed license text: ${expected.slice(0, 80).replace(/\s+/g, ' ')}`);
}
const katexLicense = await readFile('node_modules/katex/LICENSE', 'utf8');
assert.equal(await readFile('dist/math/LICENSE', 'utf8'), katexLicense);
console.log(`Package file audit passed: ${files.length} files; runtime, user documentation, localization, icons, third-party notices, and offline formula assets only.`);
