#!/usr/bin/env node
/*
 * Guards the fuzzy title similarity, the ranking fusion, and the title prior.
 *
 * The check uses one occupation's full activity set with another occupation's
 * title. The activity evidence alone selects the true occupation. The title
 * prior must lower that occupation's weight, raise the title-matching
 * occupation, and move the gap estimate.
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
const MIN_SELF_WEIGHT = 0.3;
const MIN_GAP_DROP = 0.5;

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

function weightOf(fit, occupation) {
  const at = fit.support.indexOf(occupation);
  return at < 0 ? 0 : fit.weights[at];
}

function main() {
  const { bundle, fuzzy, model } = loadContext();
  const index = model.buildIndex(bundle);
  const selfIndex = findTitle(bundle, 'General Internal Medicine Physicians');
  const otherIndex = findTitle(bundle, 'Obstetricians and Gynecologists');
  if (selfIndex < 0 || otherIndex < 0) {
    throw new Error('title check could not find the reference occupations');
  }

  const reference = bundle.occupations[selfIndex];
  const evidenceOccupation = bundle.occupations[otherIndex];
  const evidence = {
    performed: Int32Array.from(evidenceOccupation.dwa),
    denied: new Int32Array(0),
    priority: Int32Array.from(evidenceOccupation.dwa),
    priorityImportance: bundle.priorityImportance
  };
  const titleSimilarity = new Float64Array(bundle.occupations.length);
  for (let o = 0; o < bundle.occupations.length; o += 1) {
    titleSimilarity[o] = fuzzy.similarity(reference.t, bundle.occupations[o].t);
  }

  const parameters = {
    maxSupport: 6,
    learningRate: 1,
    titleWeight: model.DEFAULTS.titleWeight,
    titlePrior: model.DEFAULTS.titlePrior
  };
  const plain = model.fitBlendWeighted(index, evidence, parameters);
  const titled = model.fitBlendWeighted(
    index,
    { ...evidence, titleSimilarity },
    parameters
  );

  const unrelated = fuzzy.similarity('Recercatore in informatica', 'Sociologo');
  const typo = fuzzy.similarity('Recercatore in informatica', 'Ricercatore in informatica');
  const symmetric = fuzzy.similarity(reference.t, evidenceOccupation.t);
  const reverse = fuzzy.similarity(evidenceOccupation.t, reference.t);
  const weight = model.DEFAULTS.titleWeight;
  const expected =
    (1 - weight) * plain.similarity[otherIndex] + weight * titleSimilarity[otherIndex];
  const drop = weightOf(plain, otherIndex) - weightOf(titled, otherIndex);
  const gapDrop = plain.gap - titled.gap;

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
    failures.push(`title weight drop ${drop.toFixed(3)} below ${MIN_DROP}`);
  }
  if (weightOf(titled, selfIndex) < MIN_SELF_WEIGHT) {
    failures.push(`title-matching weight ${weightOf(titled, selfIndex).toFixed(3)} below ${MIN_SELF_WEIGHT}`);
  }
  if (gapDrop < MIN_GAP_DROP) {
    failures.push(`gap drop ${gapDrop.toFixed(3)} below ${MIN_GAP_DROP}`);
  }
  if (Math.abs(titled.similarity[otherIndex] - expected) > 1e-12) {
    failures.push('combined similarity does not match the fusion formula');
  }
  if (titled.activitySimilarity[otherIndex] !== plain.similarity[otherIndex]) {
    failures.push('title similarity changed the activity similarity');
  }

  console.log(
    `unrelated ${unrelated.toFixed(3)}, typo ${typo.toFixed(3)}, ` +
      `title ${symmetric.toFixed(3)}, weight drop ${drop.toFixed(3)}`
  );
  console.log(
    `plain gap ${plain.gap.toFixed(4)}, titled gap ${titled.gap.toFixed(4)}, ` +
      `title-matching weight ${weightOf(titled, selfIndex).toFixed(3)}`
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.log(`FAIL ${failure}`);
    }
    process.exit(1);
  }
  console.log('PASS title similarity, ranking fusion, and title prior');
}

main();
