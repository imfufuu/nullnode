#!/usr/bin/env node
/**
 * NullNode static audit.
 *   node scripts/verify.mjs
 * Checks: inline JS parses, every #id referenced by JS exists, no emoji,
 * no stray HTML entities, required meta tags, no TODO / lorem, no localhost refs.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, 'index.html');
const html = fs.readFileSync(file, 'utf8');
let fail = 0;
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

/* ---------- inline scripts parse ---------- */
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
console.log(`inline scripts: ${scripts.length}`);
scripts.forEach((code, i) => {
  try { new vm.Script(code, { filename: `inline-${i}.js` }); }
  catch (e) { bad(`inline script #${i} does not parse: ${e.message}`); }
});
if (fail === 0) ok('all inline scripts parse');

/* ---------- ids referenced by JS ---------- */
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const refs = new Set([...html.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
const missing = [...refs].filter((r) => !ids.has(r));
if (missing.length) bad('JS references missing ids: ' + missing.join(', '));
else ok(`${refs.size} jquery-style id references resolve`);

/* ---------- lucide icon names ---------- */
const iconNames = new Set([...html.matchAll(/data-lucide="([a-z0-9-]+)"/g)].map((m) => m[1]));
const jsIcons = new Set([...html.matchAll(/nnIcon\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));
const declared = new Set([...html.matchAll(/'([a-z0-9-]+)':\s*'<path/g)].map((m) => m[1]));
const unknownJsIcons = [...jsIcons].filter((n) => !declared.has(n));
if (unknownJsIcons.length) bad('dynamic icons without fallback: ' + unknownJsIcons.join(', '));

/* ---------- emoji ---------- */
const emoji = html.match(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}]/gu);
if (emoji) bad('emoji characters found: ' + [...new Set(emoji)].join(' '));
else ok('no emoji');

/* ---------- HTML entities ---------- */
const entities = html.match(/&(?:[a-zA-Z]{2,8}|#\d{2,6});/g);
const allowed = new Set(['&nbsp;', '&amp;']);
const stray = entities ? entities.filter((e) => !allowed.has(e) && e !== '&amp;') : [];
if (stray.length) bad('escaped entities that should be literal: ' + [...new Set(stray)].join(' '));
else ok('no stray entities');

/* ---------- placeholder text ---------- */
if (/lorem ipsum/i.test(html)) bad('lorem ipsum found');
for (const w of ['TODO', 'FIXME', 'XXX']) if (html.includes(w)) bad(`${w} left in file`);
ok('no placeholders');

/* ---------- hardcoded localhost ---------- */
if (/localhost|127\.0\.0\.1/.test(html)) bad('localhost reference in shipped page');
else ok('no localhost references');

/* ---------- meta ---------- */
for (const needle of ['<title>', 'name="description"', 'property="og:title"', 'name="viewport"', 'rel="canonical"']) {
  if (!html.includes(needle)) bad('missing ' + needle);
}
ok('seo meta present');

/* ---------- size ---------- */
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`\nindex.html ${kb} kB · ${html.split('\n').length} lines`);
console.log(fail === 0 ? '\nPASS' : `\nFAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
