#!/usr/bin/env node
/*
 * Guards the numbers the page hardcodes against the validation report.
 *
 * The page must not fetch the report at runtime: it has to work from a single
 * folder with no network. So the tuning values live in web/js/app.js and this
 * check fails when they drift from data/dist/validation_report.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const REPORT = path.join(ROOT, 'data', 'dist', 'validation_report.json');
const DATASET = path.join(ROOT, 'data', 'dist', 'dataset.json.gz');
const APP = path.join(ROOT, 'web', 'js', 'app.js');

function fail(message) {
  console.log(`FAIL ${message}`);
  process.exitCode = 1;
}

const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(DATASET)).toString('utf8'));
const source = fs.readFileSync(APP, 'utf8');

const block = /var TUNING = \{([\s\S]*?)\};/.exec(source);
if (!block) {
  fail('web/js/app.js has no TUNING block');
  process.exit();
}

const values = {};
for (const match of block[1].matchAll(/(\w+):\s*([\d.]+)/g)) {
  values[match[1]] = Number(match[2]);
}

const expected = {
  maxSupport: report.parameters.maxSupport,
  learningRate: report.parameters.learningRate,
  stopStability: report.derived.stopStability
};

for (const [key, value] of Object.entries(expected)) {
  if (values[key] !== value) {
    fail(`app.js ${key} is ${values[key]}, report says ${value}`);
  }
}

const floor = bundle.meta.min_dwa_initial;
if (values.floor !== undefined && values.floor !== floor) {
  fail(`app.js floor is ${values.floor}, dataset says ${floor}`);
}

if (report.derived.operatingFloor !== floor && report.derived.operatingFloor < floor) {
  fail('operating floor is below the dataset minimum');
}

console.log(`app tuning matches the report: ${JSON.stringify(values)}`);
if (process.exitCode) {
  process.exit();
}
console.log('PASS tuning values are in sync');
