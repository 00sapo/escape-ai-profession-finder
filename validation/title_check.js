#!/usr/bin/env node
/*
 * Guards the fuzzy title similarity and its effect on the ranking.
 *
 * The check uses two occupations with overlapping activities and different
 * titles. It fits the activity model, then the title-aware model. The title
 * term must lower the similarity of the other occupation, raise the selected
 * one, and leave the gap estimate unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const DATASET = path.join(ROOT, 'data', 'dist', 'dataset.json.gz');

const MIN_DROP = 0.1;
const MIN_TYPO = 0.8;
const MAX_UNRELATED = 0.05;

function loadContext() {
  const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(DATASET)).toString('utf8'));
  const context = { performance, console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'js', 'fuzzy.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'js', 'model.js'), 'utf8'), context);
  return { bundle, fuzzy: context.AIExposureFuzzy, model: context.AIExposureModel };
}

function findTitle(bundle, title) {
  return bundle.occupations.findIndex((entry) => entry.t === title);
}

function main() {
  const { bundle, fuzzy, model } = loadContext();
  const index = model.buildIndex(bundle);
  const selfIndex = findTitle(bundle, 'General Internal Medicine Physicians');
  const otherIndex = findTitle(bundle, 'Obstetricians and Gynecologists');
  if (selfIndex < 0 || otherIndex < 0) {
    throw new Error('title check could not find the reference occupations');
  }

  const occupation = bundle.occupations[selfIndex];
  const performed = Int32Array.from(occupation.dwa.slice(0, 10));
  const evidence = {
    performed,
    denied: new Int32Array(0),
    priority: Int32Array.from(occupation.dwa.slice(0, 10)),
    priorityImportance: bundle.priorityImportance
  };
  const titleSimilarity = new Float64Array(bundle.occupations.length);
  for (let o = 0; o < bundle.occupations.length; o += 1) {
    titleSimilarity[o] = fuzzy.similarity(occupation.t, bundle.occupations[o].t);
  }

  const parameters = {
    maxSupport: 6,
    learningRate: 1,
    titleWeight: model.DEFAULTS.titleWeight
  };
  const plain = model.fitBlendWeighted(index, evidence, parameters);
  const titled = model.fitBlendWeighted(
    index,
    { ...evidence, titleSimilarity },
    parameters
  );

  const unrelated = fuzzy.similarity('Recercatore in informatica', 'Sociologo');
  const typo = fuzzy.similarity('Recercatore in informatica', 'Ricercatore in informatica');
  const symmetric = fuzzy.similarity(occupation.t, bundle.occupations[otherIndex].t);
  const reverse = fuzzy.similarity(bundle.occupations[otherIndex].t, occupation.t);
  const weight = model.DEFAULTS.titleWeight;
  const expected =
    (1 - weight) * plain.similarity[otherIndex] + weight * titleSimilarity[otherIndex];
  const drop = plain.similarity[otherIndex] - titled.similarity[otherIndex];

  const failures = [];
  if (unrelated > MAX_UNRELATED) {
    failures.push(`unrelated titles score ${unrelated.toFixed(3)} above ${MAX_UNRELATED}`);
  }
  if (typo < MIN_TYPO) {
    failures.push(`typo titles score ${typo.toFixed(3)} below ${MIN_TYPO}`);
  }
  if (Math.abs(symmetric - reverse) > 1e-12) {
    failures.push('title similarity is not symmetric');
  }
  if (drop < MIN_DROP) {
    failures.push(`title drop ${drop.toFixed(3)} below ${MIN_DROP}`);
  }
  if (titled.similarity[selfIndex] < plain.similarity[selfIndex]) {
    failures.push('the selected title lowered the selected occupation');
  }
  if (Math.abs(titled.similarity[otherIndex] - expected) > 1e-12) {
    failures.push('combined similarity does not match the fusion formula');
  }
  if (Math.abs(titled.gap - plain.gap) > 1e-12) {
    failures.push('title similarity changed the gap estimate');
  }
  if (titled.activitySimilarity[otherIndex] !== plain.similarity[otherIndex]) {
    failures.push('title similarity changed the activity similarity');
  }

  console.log(
    `unrelated ${unrelated.toFixed(3)}, typo ${typo.toFixed(3)}, ` +
      `title ${symmetric.toFixed(3)}, drop ${drop.toFixed(3)}`
  );
  console.log(
    `plain similarity ${plain.similarity[otherIndex].toFixed(3)}, ` +
      `titled similarity ${titled.similarity[otherIndex].toFixed(3)}, ` +
      `gap ${plain.gap.toFixed(4)}`
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.log(`FAIL ${failure}`);
    }
    process.exit(1);
  }
  console.log('PASS title similarity and ranking effect');
}

main();
