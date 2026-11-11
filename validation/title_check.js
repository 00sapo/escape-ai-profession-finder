#!/usr/bin/env node
/* Behavioral regressions for semantic profession weighting and ranking fusion.
 * Fuzzy title matching remains a separate search-only concern. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadContext() {
  const bundle = JSON.parse(zlib.gunzipSync(
    fs.readFileSync(path.join(ROOT, 'data', 'dist', 'dataset.json.gz'))
  ).toString('utf8'));
  const context = { performance, console };
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);
  for (const script of ['web/js/fuzzy.js', 'web/js/model.js', 'web/data/semantic.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, script), 'utf8'), context);
  }
  return {
    bundle,
    fuzzy: context.AIExposureFuzzy,
    model: context.AIExposureModel,
    semantic: context.__AI_EXPOSURE_SEMANTIC__
  };
}

function close(actual, expected, label, tolerance = 1e-12) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual}`);
}

function checkOverlapWeighting(model) {
  const bundle = {
    dwas: Array.from({ length: 6 }, (_, i) => ({ i })),
    occupations: [
      { c: 'A', t: 'First selection', dwa: [0, 1, 2], e: 0, g: 0 },
      { c: 'B', t: 'Second selection', dwa: [2, 3], e: 0, g: 0 },
      { c: 'C', t: 'Shared candidate', dwa: [0, 1, 3], e: 0, g: 0 },
      { c: 'D', t: 'No overlap', dwa: [4], e: 0, g: 0 },
      { c: 'E', t: 'Second-only overlap', dwa: [3, 5], e: 0, g: 0 }
    ]
  };
  const semantic = {
    codes: bundle.occupations.map((entry) => entry.c),
    model: 'synthetic cosine fixture',
    similarities: [
      [1, 0.4, 0.2, 0.9, 0.8],
      [0.4, 1, 0.8, 0.7, 0.6],
      [0.2, 0.8, 1, 0.5, 0.3],
      [0.9, 0.7, 0.5, 1, 0.2],
      [0.8, 0.6, 0.3, 0.2, 1]
    ]
  };
  const index = model.buildIndex(bundle);
  const scores = model.semanticSimilarity(index, [0, 1], semantic);
  assert.equal(Object.prototype.toString.call(scores), '[object Float64Array]');
  assert.equal(scores.length, bundle.occupations.length);
  // C overlaps A twice and B once: normalize by overlap, not selections,
  // candidate set size, or the number of activities the user happened to pick.
  close(scores[2], (2 * 0.2 + 0.8) / 3, 'unequal full-profession overlaps');
  close(scores[0], (3 * 1 + 0.4) / 4, 'selected candidate includes its self overlap');
  close(scores[3], 0, 'zero overlap despite high semantic similarity');
  close(scores[4], 0.6, 'only overlapping selection contributes');
  const single = model.semanticSimilarity(index, [0], semantic);
  close(single[2], 0.2, 'single selection with overlap is not overlap-attenuated');
  close(single[0], 1, 'single selected profession self similarity');
  close(single[3], 0, 'single selection without overlap');
  const duplicate = model.semanticSimilarity(index, [0, 1, 0], semantic);
  const reversed = model.semanticSimilarity(index, [1, 0], semantic);
  for (let i = 0; i < scores.length; i += 1) {
    close(duplicate[i], scores[i], `duplicate selection ${i}`);
    close(reversed[i], scores[i], `selection order ${i}`);
  }
  assert.equal(model.semanticSimilarity(index, [], semantic), null,
    'empty selections must disable semantic evidence');
}

function checkArtifact(bundle, semantic) {
  assert.ok(semantic && typeof semantic.model === 'string' && semantic.model.length > 0,
    'semantic artifact must identify its embedding model');
  assert.deepEqual(Array.from(semantic.codes), bundle.occupations.map((entry) => entry.c),
    'semantic matrix codes must follow dataset order');
  const n = bundle.occupations.length;
  assert.equal(semantic.similarities.length, n);
  for (let i = 0; i < n; i += 1) {
    const row = semantic.similarities[i];
    assert.equal(row.length, n, `semantic row ${i} length`);
    close(row[i], 1, `semantic diagonal ${i}`);
    for (let j = 0; j < n; j += 1) {
      assert.ok(Number.isFinite(row[j]) && row[j] >= 0 && row[j] <= 1,
        `semantic entry ${i},${j} must be a clamped cosine`);
      close(row[j], semantic.similarities[j][i], `semantic symmetry ${i},${j}`);
    }
  }
  const occupation = (title) => {
    const i = bundle.occupations.findIndex((entry) => entry.t === title);
    assert.ok(i >= 0, `missing reference occupation: ${title}`);
    return i;
  };
  const physician = occupation('General Internal Medicine Physicians');
  const medical = occupation('Obstetricians and Gynecologists');
  const unrelated = occupation('Carpenters');
  assert.ok(semantic.similarities[physician][medical] > semantic.similarities[physician][unrelated],
    'physicians must be semantically nearer a related medical profession than carpenters');
  return { physician, medical };
}

function checkFusion(model, index, bundle, semantic, physician, medical) {
  const activities = bundle.occupations[medical].dwa;
  const evidence = {
    performed: Int32Array.from(activities),
    denied: new Int32Array(0),
    priority: Int32Array.from(activities),
    priorityImportance: bundle.priorityImportance
  };
  const titleSimilarity = model.semanticSimilarity(index, [physician, medical], semantic);
  close(model.DEFAULTS.titleWeight, 0.75, 'default semantic fusion weight');
  const options = { maxSupport: 6, learningRate: 1 };
  const plain = model.fitBlendWeighted(index, evidence, options);
  const titled = model.fitBlendWeighted(index, { ...evidence, titleSimilarity }, options);
  const empty = model.fitBlendWeighted(index, {
    ...evidence, titleSimilarity: model.semanticSimilarity(index, [], semantic)
  }, options);
  let distinguishesWeights = false;
  for (let i = 0; i < bundle.occupations.length; i += 1) {
    close(titled.activitySimilarity[i], plain.similarity[i], `unchanged activity score ${i}`);
    close(titled.similarity[i], 0.25 * plain.similarity[i] + 0.75 * titleSimilarity[i],
      `semantic/activity fusion ${i}`);
    close(empty.similarity[i], plain.similarity[i], `empty-selection activity fallback ${i}`);
    if (Math.abs(plain.similarity[i] - titleSimilarity[i]) > 0.01) distinguishesWeights = true;
  }
  assert.ok(distinguishesWeights, 'fusion fixture must distinguish semantic and activity weights');
}

function main() {
  const { bundle, fuzzy, model, semantic } = loadContext();
  assert.ok(fuzzy.similarity('Recercatore in informatica', 'Ricercatore in informatica') >= 0.8,
    'fuzzy search must still tolerate title typos');
  checkOverlapWeighting(model);
  const { physician, medical } = checkArtifact(bundle, semantic);
  checkFusion(model, model.buildIndex(bundle), bundle, semantic, physician, medical);
  console.log('PASS semantic overlap weighting, cosine artifact, 0.75/0.25 fusion, and fuzzy search');
}

main();
