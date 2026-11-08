#!/usr/bin/env node
/*
 * Does the declared priority order approximate O*NET's own activity importance?
 *
 * For every occupation with at least five activities:
 *   - read the O*NET importance of each activity (bundle imp, scale 1 to 5);
 *   - order the activities by that importance and simulate a user who follows
 *     it, then fit the model and read the resulting evidence weight per
 *     activity;
 *   - compare those weights with the true importances (Spearman, Kendall tau,
 *     mean absolute difference on the normalized 0 to 1 scale).
 * The control repeats the same computation with a random priority order.
 *
 * Thresholds live in one place below: median Spearman at least 0.6, and at
 * least 0.2 above the random control.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const THRESHOLDS = {
  medianSpearman: 0.6,
  marginOverRandom: 0.2,
  mergedMedianGapDelta: 0.02,
  mergedTopChangeShare: 0.1
};

function loadModel() {
  const context = { performance, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'js', 'model.js'), 'utf8'), context);
  return context.AIExposureModel;
}

function ranks(values) {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array(values.length);
  let position = 0;
  while (position < order.length) {
    let end = position;
    while (end + 1 < order.length && order[end + 1].value === order[position].value) {
      end += 1;
    }
    const rank = (position + end) / 2 + 1;
    for (let i = position; i <= end; i += 1) {
      result[order[i].index] = rank;
    }
    position = end + 1;
  }
  return result;
}

function spearman(a, b) {
  const ra = ranks(a);
  const rb = ranks(b);
  const n = a.length;
  const mean = (n + 1) / 2;
  let numerator = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (ra[i] - mean) * (rb[i] - mean);
    da += (ra[i] - mean) * (ra[i] - mean);
    db += (rb[i] - mean) * (rb[i] - mean);
  }
  return da === 0 || db === 0 ? 0 : numerator / Math.sqrt(da * db);
}

function kendall(a, b) {
  const n = a.length;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const sign = (a[i] - a[j]) * (b[i] - b[j]);
      if (sign > 0) concordant += 1;
      else if (sign < 0) discordant += 1;
    }
  }
  const total = (n * (n - 1)) / 2;
  return total === 0 ? 0 : (concordant - discordant) / total;
}

function normalized(values) {
  return values.map((value) => (value - 1) / 4);
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compare(trueImportance, weights) {
  const expected = normalized(trueImportance);
  const actual = normalized(weights);
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) {
    difference += Math.abs(expected[i] - actual[i]);
  }
  return {
    spearman: spearman(trueImportance, weights),
    kendall: kendall(trueImportance, weights),
    mad: difference / expected.length
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shuffled(items, random) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = copy[i];
    copy[i] = copy[j];
    copy[j] = swap;
  }
  return copy;
}

function fitFor(model, index, table, options, performed, priority) {
  return model.fitBlendWeighted(
    index,
    {
      performed: Int32Array.from(performed),
      denied: new Int32Array(0),
      priority: Int32Array.from(priority),
      priorityImportance: table
    },
    options
  );
}

function topOf(fit) {
  let best = 0;
  for (let i = 1; i < fit.weights.length; i += 1) {
    if (fit.weights[i] > fit.weights[best]) best = i;
  }
  return { occupation: fit.support[best], weight: fit.weights[best] };
}

function evaluateOrder(model, index, table, options, entry, positions) {
  const orderDwa = positions.map((position) => entry.dwa[position]);
  const priority = Int32Array.from(orderDwa);
  const fit = model.fitBlendWeighted(
    index,
    {
      performed: priority,
      denied: new Int32Array(0),
      priority,
      priorityImportance: table
    },
    options
  );
  const byDwa = new Map();
  for (const item of fit.evidenceOrder) {
    if (item.performed) byDwa.set(item.dwa, item.weight);
  }
  const weights = orderDwa.map((dwa) => byDwa.get(dwa));
  return {
    fit,
    comparison: compare(positions.map((position) => entry.imp[position]), weights)
  };
}

function main() {
  const model = loadModel();
  const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data', 'dist', 'dataset.json.gz'))));
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'dist', 'validation_report.json'), 'utf8'));
  const index = model.buildIndex(bundle);
  const options = Object.assign({}, report.parameters);
  const table = bundle.priorityImportance;
  const random = seededRandom(20261108);

  const following = [];
  const control = [];
  let occupations = 0;

  for (const entry of bundle.occupations) {
    if (entry.imp.length < 5) {
      continue;
    }
    occupations += 1;
    const positions = entry.imp.map((value, index) => index);
    const ordered = positions.slice().sort((a, b) => {
      if (entry.imp[b] !== entry.imp[a]) return entry.imp[b] - entry.imp[a];
      return a - b;
    });
    following.push(evaluateOrder(model, index, table, options, entry, ordered).comparison);
    control.push(evaluateOrder(model, index, table, options, entry, shuffled(ordered, random)).comparison);
  }

  // Case 1: one occupation, all activities, O*NET order versus reversed.
  const singleGapDeltas = [];
  const singleWeightDeltas = [];
  for (const entry of bundle.occupations) {
    if (entry.imp.length < 5) continue;
    const order = entry.imp
      .map((value, index) => index)
      .sort((a, b) => (entry.imp[b] !== entry.imp[a] ? entry.imp[b] - entry.imp[a] : a - b));
    const reversed = order.slice().reverse();
    const forward = evaluateOrder(model, index, table, options, entry, order).fit;
    const backward = evaluateOrder(model, index, table, options, entry, reversed).fit;
    singleGapDeltas.push(Math.abs(forward.gap - backward.gap));
    singleWeightDeltas.push(Math.abs(topOf(forward).weight - topOf(backward).weight));
  }

  // Case 2: two occupations merged, O*NET order versus reversed.
  const mergedGapDeltas = [];
  const mergedWeightDeltas = [];
  let mergedPairs = 0;
  let mergedTopChanges = 0;
  for (let first = 0; first + 1 < bundle.occupations.length; first += 2) {
    const a = bundle.occupations[first];
    const b = bundle.occupations[first + 1];
    const importance = new Map();
    for (let position = 0; position < a.dwa.length; position += 1) {
      importance.set(a.dwa[position], Math.max(importance.get(a.dwa[position]) || 0, a.imp[position]));
    }
    for (let position = 0; position < b.dwa.length; position += 1) {
      importance.set(b.dwa[position], Math.max(importance.get(b.dwa[position]) || 0, b.imp[position]));
    }
    const union = Array.from(importance.keys());
    if (union.length < 5) continue;
    const order = union.slice().sort((x, y) => {
      const diff = importance.get(y) - importance.get(x);
      return diff !== 0 ? diff : x - y;
    });
    const reversed = order.slice().reverse();
    const forward = fitFor(model, index, table, options, union, order);
    const backward = fitFor(model, index, table, options, union, reversed);
    mergedPairs += 1;
    mergedGapDeltas.push(Math.abs(forward.gap - backward.gap));
    mergedWeightDeltas.push(Math.abs(topOf(forward).weight - topOf(backward).weight));
    if (topOf(forward).occupation !== topOf(backward).occupation) mergedTopChanges += 1;
  }

  const singleGapMedian = median(singleGapDeltas);
  const singleGapMax = Math.max(...singleGapDeltas);
  const singleWeightMedian = median(singleWeightDeltas);
  const mergedGapMedian = median(mergedGapDeltas);
  const mergedGapMax = Math.max(...mergedGapDeltas);
  const mergedWeightMedian = median(mergedWeightDeltas);
  const mergedChangeShare = mergedPairs ? mergedTopChanges / mergedPairs : 0;

  const followingSpearman = median(following.map((row) => row.spearman));
  const followingKendall = median(following.map((row) => row.kendall));
  const followingMad = mean(following.map((row) => row.mad));
  const controlSpearman = median(control.map((row) => row.spearman));
  const controlKendall = median(control.map((row) => row.kendall));
  const controlMad = mean(control.map((row) => row.mad));

  console.log(`occupations ${occupations}`);
  console.log(
    `O*NET-following: median Spearman ${followingSpearman.toFixed(3)}, ` +
      `median Kendall ${followingKendall.toFixed(3)}, mean MAD ${followingMad.toFixed(3)}`
  );
  console.log(
    `random control:  median Spearman ${controlSpearman.toFixed(3)}, ` +
      `median Kendall ${controlKendall.toFixed(3)}, mean MAD ${controlMad.toFixed(3)}`
  );

  console.log(
    `single occupation, O*NET order vs reversed: median |gap delta| ${singleGapMedian.toFixed(6)}, ` +
      `max ${singleGapMax.toFixed(6)}, median |top weight delta| ${singleWeightMedian.toFixed(6)}`
  );
  console.log(
    `two occupations merged, O*NET order vs reversed: median |gap delta| ${mergedGapMedian.toFixed(6)}, ` +
      `max ${mergedGapMax.toFixed(6)}, median |top weight delta| ${mergedWeightMedian.toFixed(6)}, ` +
      `top occupation changed ${(mergedChangeShare * 100).toFixed(1)}% of ${mergedPairs} pairs`
  );

  const failures = [];
  if (followingSpearman < THRESHOLDS.medianSpearman) {
    failures.push(`median Spearman ${followingSpearman.toFixed(3)} below ${THRESHOLDS.medianSpearman}`);
  }
  if (followingSpearman - controlSpearman < THRESHOLDS.marginOverRandom) {
    failures.push(
      `margin over random ${(followingSpearman - controlSpearman).toFixed(3)} below ${THRESHOLDS.marginOverRandom}`
    );
  }
  if (singleGapMedian > 1e-4) {
    failures.push(`single occupation order should not move the gap, median ${singleGapMedian.toFixed(6)}`);
  }
  if (mergedGapMedian < THRESHOLDS.mergedMedianGapDelta && mergedChangeShare < THRESHOLDS.mergedTopChangeShare) {
    failures.push(
      `merged evidence barely reacts to order: median gap delta ${mergedGapMedian.toFixed(6)}, ` +
        `top change share ${(mergedChangeShare * 100).toFixed(1)}%`
    );
  }
  for (const failure of failures) {
    console.log(`FAIL ${failure}`);
  }
  if (failures.length === 0) {
    console.log('PASS priority order approximates O*NET importance');
  }
  return failures.length ? 1 : 0;
}

process.exit(main());
