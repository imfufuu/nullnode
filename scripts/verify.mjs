#!/usr/bin/env node
/**
 * NullNode static audit — multi-file layout.
 *   node scripts/verify.mjs
 * Checks: every JS asset parses, every DOM id used by a script exists on the
 * page that loads it, every lucide icon has a fallback, assets referenced in
 * html exist, no emoji / stray entities / placeholders / localhost, meta intact.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

let fail = 0;
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);
const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1);

const PAGES = {
  'index.html': ['assets/js/core.js', 'assets/js/landing.js'],
  'app.html': ['assets/js/core.js', 'assets/js/rtc.js', 'assets/js/chat.js', 'assets/js/board.js', 'assets/js/app.js']
};
const CONSTRAINTS = ['assets/js/rtc.js', 'assets/js/chat.js', 'assets/js/board.js', 'assets/js/app.js', 'assets/js/core.js'];

const html = {};
for (const page of Object.keys(PAGES)) html[page] = read(page);

/* ---------- 1. every script parses ---------- */
console.log('\nscripts');
const jsFiles = fs.readdirSync(path.join(root, 'assets/js')).filter((f) => f.endsWith('.js'));
for (const f of jsFiles) {
  const code = read('assets/js/' + f);
  try { new vm.Script(code, { filename: f }); ok(`${f} parses (${kb(code)} kB)`); }
  catch (e) { bad(`${f} does not parse: ${e.message}`); }
}
for (const page of Object.keys(PAGES)) {
  const inline = [...html[page].matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  inline.forEach((code, i) => {
    try { new vm.Script(code, { filename: `${page}-inline-${i}.js` }); }
    catch (e) { bad(`${page} inline script #${i} does not parse: ${e.message}`); }
  });
  ok(`${page}: ${inline.length} inline script(s) parse`);
}

/* ---------- 2. ids per page ---------- */
console.log('\nDOM ids');
const ID_PATTERNS = [
  /(?:\bNN\.)?\$\('#([A-Za-z0-9_-]+)'/g,
  /getElementById\('([A-Za-z0-9_-]+)'\)/g
];
for (const [page, scripts] of Object.entries(PAGES)) {
  const ids = new Set([...html[page].matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const missing = new Set();
  for (const s of new Set(scripts)) {
    if (!exists(s)) { bad(`${page} loads ${s}, which does not exist`); continue; }
    const code = read(s);
    for (const re of ID_PATTERNS) {
      for (const m of code.matchAll(re)) if (!ids.has(m[1])) missing.add(`${s} → #${m[1]}`);
    }
  }
  if (missing.size) bad(`${page} references missing ids:\n      ${[...missing].join('\n      ')}`);
  else ok(`${page}: every scripted id exists (${ids.size} ids)`);
}

/* ---------- 3. icons ---------- */
console.log('\nicons');
const core = read('assets/js/core.js');
const declared = new Set([...core.matchAll(/^\s{4}'?([a-z0-9-]+)'?:\s*'</gm)].map((m) => m[1]));
const used = new Map();
for (const page of Object.keys(PAGES)) {
  for (const m of html[page].matchAll(/data-lucide="([a-z0-9-]+)"/g)) used.set(m[1], page);
}
for (const m of core.matchAll(/NN\.icon\('([a-z0-9-]+)'\)/g)) used.set(m[1], 'core.js');
for (const s of CONSTRAINTS) for (const m of read(s).matchAll(/NN\.icon\('([a-z0-9-]+)'\)/g)) used.set(m[1], s);
const noFallback = [...used.keys()].filter((n) => !declared.has(n));
if (used.size < 20) bad(`only ${used.size} icon names found — expected the full set`);
if (noFallback.length) bad('icons without an inline fallback: ' + noFallback.join(', '));
else ok(`${used.size} icon names, all with inline fallbacks`);

/* ---------- 4. local assets exist ---------- */
console.log('\nassets');
for (const [page, source] of Object.entries(html)) {
  const refs = [...source.matchAll(/(?:src|href)="((?!#|https?:|data:|mailto:)[^"]+)"/g)].map((m) => m[1]);
  const dead = refs.filter((r) => !exists(r.split('?')[0]));
  if (dead.length) bad(`${page} points at missing files: ${dead.join(', ')}`);
  else ok(`${page}: ${refs.length} local references resolve`);
}
for (const [page, scripts] of Object.entries(PAGES)) {
  for (const s of scripts) if (s === 'assets/js/core.js' && !html[page].includes('core.js')) bad(`${page} does not load core.js`);
}

/* ---------- 5. page relationship ---------- */
console.log('\npages');
if (!html['index.html'].includes('href="app.html"')) bad('index.html has no link into app.html');
else ok('index.html links to app.html');
if (!html['app.html'].includes('href="index.html"')) bad('app.html has no way back to index.html');
else ok('app.html links back to index.html');
if (!/name="robots" content="noindex"/.test(html['app.html'])) bad('app.html should be noindex');
else ok('app.html is noindex');

/* ---------- 6. relay meta ---------- */
console.log('\nrelay');
for (const [page, source] of Object.entries(html)) {
  const m = source.match(/<meta name="nullnode-relay" content="([^"]*)">/);
  if (!m) bad(`${page} has no nullnode-relay meta`);
  else if (!/^https:\/\/[^\s]+$/.test(m[1])) bad(`${page} relay meta is not an https origin ("${m[1]}")`);
  else ok(`${page}: relay ${m[1]}`);
}

/* ---------- 7. hygiene across html + js ---------- */
console.log('\nhygiene');
const all = Object.values(html).join('\n') + '\n' + jsFiles.map((f) => read('assets/js/' + f)).join('\n');
const emoji = all.match(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}]/gu);
if (emoji) bad('emoji characters found: ' + [...new Set(emoji)].join(' '));
else ok('no emoji');
const entities = all.match(/&(?:[a-zA-Z]{2,8}|#\d{2,6});/g) || [];
const stray = entities.filter((e) => !['&nbsp;', '&amp;', '&lt;', '&gt;', '&#39;', '&quot;'].includes(e));
if (stray.length) bad('escaped entities that should be literal: ' + [...new Set(stray)].join(' '));
else ok('no stray entities');
if (/lorem ipsum/i.test(all)) bad('lorem ipsum found');
for (const w of ['TODO', 'FIXME', 'XXX']) if (all.includes(w)) bad(`${w} left in a shipped file`);
ok('no placeholders');
if (/localhost|127\.0\.0\.1/.test(all)) bad('localhost reference in shipped files');
else ok('no localhost references');
if (/console\.log\(/.test(jsFiles.map((f) => read('assets/js/' + f)).join('\n'))) bad('console.log left in a shipped script');
else ok('no console.log in shipped scripts');

/* ---------- 8. css balance ---------- */
console.log('\ncss');
const cssFiles = fs.readdirSync(path.join(root, 'assets/css')).filter((f) => f.endsWith('.css'));
for (const f of cssFiles) {
  const css = read('assets/css/' + f);
  const open = (css.match(/{/g) || []).length, close = (css.match(/}/g) || []).length;
  if (open !== close) bad(`${f}: ${open} { vs ${close} }`);
  else ok(`${f}: balanced (${kb(css)} kB)`);
}

/* ---------- 9. meta ---------- */
console.log('\nmeta');
for (const needle of ['<title>', 'name="description"', 'property="og:title"', 'name="viewport"', 'rel="canonical"']) {
  if (!html['index.html'].includes(needle)) bad('index.html missing ' + needle);
}
if (!/<title>/.test(html['app.html'])) bad('app.html missing a title');
ok('seo meta present');

console.log('');
for (const [page, source] of Object.entries(html)) console.log(`${page.padEnd(11)} ${kb(source)} kB · ${source.split('\n').length} lines`);
console.log(`assets/js    ${jsFiles.length} files · ${(jsFiles.reduce((n, f) => n + Buffer.byteLength(read('assets/js/' + f)), 0) / 1024).toFixed(1)} kB`);
console.log(fail === 0 ? '\nPASS' : `\nFAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
