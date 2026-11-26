// tools/vendor-three.mjs — copies the pinned three.js build & the addons the city imports (plus everything they import
// by relative path) into vendor/three/, so the page loads without the CDN. usage: node tools/vendor-three.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = '1d3772857eb8970ce24b3757980c5e9d46c0d6ff';
const BASE = `https://raw.githubusercontent.com/mrdoob/three.js/${COMMIT}/`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'vendor/three');
const queue = ['build/three.webgpu.js', 'build/three.tsl.js'];
for (const f of fs.readdirSync(path.join(ROOT, 'js'))) {
  if (!f.endsWith('.js')) continue;
  for (const m of fs.readFileSync(path.join(ROOT, 'js', f), 'utf8').matchAll(/from 'three\/addons\/([^']+)'/g)) queue.push(`examples/jsm/${m[1]}`);
}
const seen = new Set();
while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);
  let text = null;
  for (let attempt = 0; attempt < 4 && text === null; attempt++) {
    const res = await fetch(BASE + rel).catch(() => null);
    if (res && res.ok) text = await res.text();
  }
  if (text === null) throw new Error(`failed: ${rel}`);
  fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
  fs.writeFileSync(path.join(OUT, rel), text);
  for (const m of text.matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
  console.log(`${(text.length / 1024).toFixed(0).padStart(6)} KB  ${rel}`);
}
console.log(`${seen.size} files -> ${path.relative(ROOT, OUT)}/`);
