#!/usr/bin/env node
/* Fails when an interface string drifts:
 * - a data-i18n* key in web/index.html or a literal t('...') in web/js/*.js is
 *   missing from any of the seven tables;
 * - a table key is not used anywhere;
 * - the seven tables do not carry the same key set.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCALES = ['it', 'en', 'es', 'fr', 'zh', 'ar', 'hi'];
const i18nSource = fs.readFileSync(path.join(ROOT, 'web/js/i18n.js'), 'utf8');
const match = /var STRINGS = (\{[\s\S]*?\n  \});/.exec(i18nSource);
if (!match) {
  console.log('FAIL web/js/i18n.js has no STRINGS block');
  process.exit(1);
}
const STRINGS = eval('(' + match[1] + ')');

const used = new Set();
const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
for (const attr of html.matchAll(/data-i18n(?:-placeholder|-aria-label)?="([^"]+)"/g)) {
  used.add(attr[1]);
}
for (const file of fs.readdirSync(path.join(ROOT, 'web/js'))) {
  if (!file.endsWith('.js') || file === 'i18n.js') continue;
  const source = fs.readFileSync(path.join(ROOT, 'web/js', file), 'utf8');
  for (const call of source.matchAll(/\bt\(\s*'([^'\\]+)'/g)) used.add(call[1]);
  for (const call of source.matchAll(/\bt\(\s*"([^"\\]+)"/g)) used.add(call[1]);
}

const problems = [];
const base = Object.keys(STRINGS.it || {});
for (const locale of LOCALES) {
  if (!STRINGS[locale]) {
    problems.push(`missing locale ${locale}`);
    continue;
  }
  for (const key of base) {
    if (!(key in STRINGS[locale])) problems.push(`${locale} misses ${key}`);
  }
  for (const key of Object.keys(STRINGS[locale])) {
    if (!(key in STRINGS.it)) problems.push(`${locale} has extra ${key}`);
  }
}
for (const key of used) {
  for (const locale of LOCALES) {
    if (!STRINGS[locale] || !(key in STRINGS[locale])) {
      problems.push(`used key ${key} missing in ${locale}`);
    }
  }
}
for (const key of base) {
  if (!used.has(key)) problems.push(`unused key ${key}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.log('FAIL ' + problem);
  process.exit(1);
}
console.log(`PASS i18n: ${base.length} keys x ${LOCALES.length} locales, all used`);
