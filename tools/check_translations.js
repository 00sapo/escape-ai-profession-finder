#!/usr/bin/env node
/* Validates the machine translation tables:
 * - every locale has a JSON file and a manifest entry;
 * - no translated value is empty;
 * - no locale is more than 20 percent identical to the English source;
 * - reports coverage per locale.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(ROOT, 'web', 'data', 'translations');
const LOCALES = ['it', 'es', 'fr', 'zh', 'ar', 'hi'];
const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data', 'dist', 'dataset.json.gz'))));
const english = {
  occupations: new Map(bundle.occupations.map((entry) => [entry.c, entry.t])),
  activities: new Map(bundle.dwas.map((entry) => [entry.i, entry.n]))
};

const problems = [];
const manifestPath = path.join(DIR, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  problems.push('missing manifest.json');
}
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { locales: {} };

for (const locale of LOCALES) {
  if (!manifest.locales || !manifest.locales[locale]) {
    problems.push(`manifest misses ${locale}`);
  }
  const file = path.join(DIR, `${locale}.json`);
  if (!fs.existsSync(file)) {
    problems.push(`missing ${locale}.json`);
    continue;
  }
  const table = JSON.parse(fs.readFileSync(file, 'utf8'));
  let translated = 0;
  let identical = 0;
  for (const group of ['occupations', 'activities']) {
    const values = table[group] || {};
    for (const [id, value] of Object.entries(values)) {
      if (typeof value !== 'string' || value.trim() === '') {
        problems.push(`${locale} ${group} ${id} is empty`);
        continue;
      }
      translated += 1;
      if (value.trim() === (english[group].get(id) || '').trim()) {
        identical += 1;
      }
    }
  }
  const share = translated === 0 ? 0 : identical / translated;
  if (share > 0.2) {
    problems.push(`${locale} has ${Math.round(share * 100)}% identical strings`);
  }
  const occupancy = table.occupations || {};
  const activities = table.activities || {};
  console.log(
    `${locale}: occupations ${Object.keys(occupancy).length}/${english.occupations.size} ` +
      `(${((Object.keys(occupancy).length / english.occupations.size) * 100).toFixed(1)}%), ` +
      `activities ${Object.keys(activities).length}/${english.activities.size} ` +
      `(${((Object.keys(activities).length / english.activities.size) * 100).toFixed(1)}%), ` +
      `identical ${identical}/${translated}`
  );
}
if (problems.length > 0) {
  for (const problem of problems) console.log('FAIL ' + problem);
  process.exit(1);
}
console.log(`PASS translations: ${LOCALES.length} locales, endpoint ${manifest.endpoint || 'none'}, status ${manifest.status || 'unknown'}`);
