#!/usr/bin/env node
/*
 * Validation harness.
 *
 * Takes every O*NET occupation with an OECD score as a known profile, samples a
 * number of its activities, runs the same blending code the page runs, and
 * measures how well the estimate recovers the occupation and its exposure.
 *
 * The occupations are split by a stable hash of the O*NET-SOC code: 60 percent
 * tune the blend parameters, 40 percent are held out and only used for the
 * final numbers. Exit code is non-zero when a held-out threshold is missed.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const DATASET = path.join(ROOT, 'data', 'dist', 'dataset.json.gz');
const MODEL = path.join(ROOT, 'web', 'js', 'model.js');
const SEMANTIC_DATA = path.join(ROOT, 'web', 'data', 'semantic.js');
const SEMANTIC = process.argv.includes('--semantic');
const IGNORE_DENIED = process.argv.includes('--ignore-denied');
const MODE = [SEMANTIC ? 'semantic' : '', IGNORE_DENIED ? 'ignore_denied' : '']
  .filter(Boolean)
  .join('_');
const REPORT = path.join(
  ROOT,
  'data',
  'dist',
  MODE ? `validation_report_${MODE}.json` : 'validation_report.json'
);

const THRESHOLDS = { mae: 0.05, within: 0.65, tolerance: 0.05 };
const SAMPLE_SIZES = [4, 5, 6, 8, 10, 12, 15, 20, 25];
const NOISE_SHARE = 0.15;
const GRID = [];
for (const maxSupport of [4, 6, 8, 10]) {
  for (const learningRate of [0.4, 0.7, 1.0]) {
    GRID.push({ maxSupport, learningRate });
  }
}

function loadModel() {
  new Function(fs.readFileSync(MODEL, 'utf8')).call(globalThis);
  if (!globalThis.AIExposureModel) {
    throw new Error('model.js did not publish its API');
  }
  let semantic = null;
  if (SEMANTIC) {
    const publish = new Function('self', fs.readFileSync(SEMANTIC_DATA, 'utf8'));
    const scope = {};
    publish(scope);
    semantic = scope.__AI_EXPOSURE_SEMANTIC__;
  }
  return { model: globalThis.AIExposureModel, semantic };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function sampleActivities(list, count, random) {
  const pool = Array.from(list);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = pool[i];
    pool[i] = pool[j];
    pool[j] = swap;
  }
  return Int32Array.from(pool.slice(0, Math.min(count, pool.length)));
}

/* Shuffle consecutive blocks of 3 or 4 activities. This simulates a user who
 * knows the order between small groups but not inside them. */
function perturbBlocks(values, random) {
  const out = [];
  let index = 0;
  while (index < values.length) {
    const remaining = values.length - index;
    const size = remaining <= 4 ? remaining : random() < 0.5 ? 3 : 4;
    const block = Array.from(values.slice(index, index + size));
    for (let i = block.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const swap = block[i];
      block[i] = block[j];
      block[j] = swap;
    }
    out.push(...block);
    index += size;
  }
  return Int32Array.from(out);
}

/* Draw activities that the occupation does not contain and that the performed
 * set does not contain, so a denied activity never contradicts a performed one. */
function sampleDenied(index, occupation, performed, count, random) {
  const used = new Set(index.occDwa[occupation]);
  for (let i = 0; i < performed.length; i += 1) {
    used.add(performed[i]);
  }
  const picked = [];
  const seen = new Set();
  let guard = 0;
  while (picked.length < count && guard < 10000) {
    guard += 1;
    const dwa = Math.floor(random() * index.nDwa);
    if (used.has(dwa) || seen.has(dwa)) {
      continue;
    }
    seen.add(dwa);
    picked.push(dwa);
  }
  return Int32Array.from(picked);
}

function evaluate(index, model, occupations, options) {
  const random = mulberry32(options.seed);
  const rows = [];
  for (const occupation of occupations) {
    const list = index.occDwa[occupation];
    const titleSimilarity = options.titleSimilarity
      ? options.titleSimilarity(occupation)
      : null;
    let previous = null;
    for (const size of SAMPLE_SIZES) {
      if (list.length < size) {
        continue;
      }
      const performed = sampleActivities(list, size, random);
      if (options.noise > 0) {
        const used = new Set(list);
        const injected = Math.max(1, Math.round(size * options.noise));
        for (let i = 0; i < injected; i += 1) {
          let dwa = Math.floor(random() * index.nDwa);
          let guard = 0;
          while (used.has(dwa) && guard < 10000) {
            guard += 1;
            dwa = Math.floor(random() * index.nDwa);
          }
          used.add(dwa);
          performed[i] = dwa;
        }
      }
      const deniedCount = 7 + Math.floor(random() * 2);
      const denied = sampleDenied(index, occupation, performed, deniedCount, random);
      const priority = perturbBlocks(performed, random);
      const evidence = {
        performed,
        denied: options.ignoreDenied ? new Int32Array(0) : denied,
        priority,
        priorityImportance: index.dataset.priorityImportance,
        exclude: [occupation]
      };
      if (titleSimilarity) {
        evidence.titleSimilarity = titleSimilarity;
      }
      const fit = model.fitBlend(index, evidence, options.parameters);
      const estimate = fit.exposure;
      const truth = index.exposure[occupation];
      rows.push({
        code: index.dataset.occupations[occupation].c,
        size,
        error: Math.abs(estimate - truth),
        truth,
        estimate,
        support: fit.effectiveSupport,
        stability: previous === null ? null : model.stability(previous, fit)
      });
      previous = fit;
    }
  }
  return rows;
}

function summarize(rows) {
  const bySize = new Map();
  for (const row of rows) {
    if (!bySize.has(row.size)) {
      bySize.set(row.size, []);
    }
    bySize.get(row.size).push(row);
  }
  const table = [];
  for (const size of [...bySize.keys()].sort((a, b) => a - b)) {
    const bucket = bySize.get(size);
    const mae = bucket.reduce((sum, row) => sum + row.error, 0) / bucket.length;
    const within =
      bucket.filter((row) => row.error <= THRESHOLDS.tolerance).length / bucket.length;
    const meanSupport = bucket.reduce((sum, row) => sum + row.support, 0) / bucket.length;
    const stable = bucket.filter((row) => row.stability !== null);
    const stability =
      stable.length === 0
        ? 0
        : stable.reduce((sum, row) => sum + row.stability, 0) / stable.length;
    table.push({ size, count: bucket.length, mae, within, meanSupport, stability });
  }
  return table;
}

function minimumSize(table, thresholds) {
  for (const row of table) {
    if (row.mae <= thresholds.mae && row.within >= thresholds.within) {
      return row.size;
    }
  }
  return null;
}

function stabilityThreshold(table, floor) {
  const usable = table.filter((row) => row.size >= floor && row.stability > 0);
  if (usable.length === 0) {
    return 0.05;
  }
  const values = usable.map((row) => row.stability).sort((a, b) => a - b);
  const index = Math.floor(values.length * 0.9);
  return Math.round(values[Math.min(index, values.length - 1)] * 1000) / 1000;
}

function tune(index, model, tuning, seed, ignoreDenied, titleSimilarity) {
  const results = [];
  for (const parameters of GRID) {
    const rows = evaluate(index, model, tuning, {
      seed,
      noise: 0,
      parameters,
      ignoreDenied,
      titleSimilarity
    });
    const table = summarize(rows);
    const target = table.filter((row) => row.size === 15 || row.size === 20);
    const mae = target.reduce((sum, row) => sum + row.mae, 0) / target.length;
    const within = target.reduce((sum, row) => sum + row.within, 0) / target.length;
    results.push({ parameters, mae, within });
  }
  results.sort((a, b) => {
    if (b.within !== a.within) {
      return b.within - a.within;
    }
    return a.mae - b.mae;
  });
  return results;
}

function main() {
  const { model, semantic } = loadModel();
  const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(DATASET)).toString('utf8'));
  const index = model.buildIndex(bundle);

  const titleCache = new Map();
  function titleSimilarityFor(occupation) {
    if (titleCache.has(occupation)) {
      return titleCache.get(occupation);
    }
    const values = model.semanticSimilarity(index, [occupation], semantic);
    titleCache.set(occupation, values);
    return values;
  }
  const titleOption = SEMANTIC ? titleSimilarityFor : null;

  const tuning = [];
  const heldout = [];
  for (let occupation = 0; occupation < index.nOcc; occupation += 1) {
    const code = bundle.occupations[occupation].c;
    if (fnv1a(code) % 5 < 3) {
      tuning.push(occupation);
    } else {
      heldout.push(occupation);
    }
  }

  console.log(`occupations ${index.nOcc}, activities ${index.nDwa}`);
  console.log(`split: tuning ${tuning.length}, held out ${heldout.length}`);
  console.log(
    `mode: ${SEMANTIC ? 'semantic candidate selection and blend prior' : 'activities only'}, ` +
      `${IGNORE_DENIED ? 'ignore denied activities' : 'use denied activities'}`
  );

  const grid = SEMANTIC ? [] : tune(index, model, tuning, 1234, IGNORE_DENIED, titleOption);
  const best = SEMANTIC
    ? { maxSupport: 6, learningRate: 0.4, titleWeight: 0.75, titlePrior: 20 }
    : grid[0].parameters;
  console.log(`${SEMANTIC ? 'application' : 'tuned'} parameters: ${JSON.stringify(best)}`);
  for (const entry of grid.slice(0, 4)) {
    console.log(
      `  ${JSON.stringify(entry.parameters)} mae ${entry.mae.toFixed(4)} within ${entry.within.toFixed(3)}`
    );
  }

  const tuningRows = evaluate(index, model, tuning, {
    seed: 99,
    noise: 0,
    parameters: best,
    ignoreDenied: IGNORE_DENIED,
    titleSimilarity: titleOption
  });
  const heldoutRows = evaluate(index, model, heldout, {
    seed: 2024,
    noise: 0,
    parameters: best,
    ignoreDenied: IGNORE_DENIED,
    titleSimilarity: titleOption
  });
  const tuningTable = summarize(tuningRows);
  const heldoutTable = summarize(heldoutRows);

  const noisyRows = evaluate(index, model, heldout, {
    seed: 7,
    noise: NOISE_SHARE,
    parameters: best,
    ignoreDenied: IGNORE_DENIED,
    titleSimilarity: titleOption
  });
  const noisyTable = summarize(noisyRows);

  const minimum = minimumSize(tuningTable, THRESHOLDS);
  const productFloor = bundle.meta.min_dwa_initial;
  const operatingFloor = Math.max(productFloor, minimum === null ? productFloor : minimum);
  const stopThreshold = stabilityThreshold(tuningTable, operatingFloor);

  const format = (table) =>
    table
      .map(
        (row) =>
          `  n=${String(row.size).padStart(2)} mae ${row.mae.toFixed(4)} ` +
          `within ${row.within.toFixed(3)} support ${row.meanSupport.toFixed(2)} ` +
          `stability ${row.stability > 0 ? row.stability.toFixed(3) : '  n/a'} (${row.count} runs)`
      )
      .join('\n');

  console.log('\ntuning set');
  console.log(format(tuningTable));
  console.log('\nheld-out set');
  console.log(format(heldoutTable));
  console.log(`\nheld-out set with ${Math.round(NOISE_SHARE * 100)}% foreign activities`);
  console.log(format(noisyTable));

  const heldoutFinal = heldoutTable.find((row) => row.size === 20);
  const noisyFinal = noisyTable.find((row) => row.size === 20);
  const failures = [];
  if (!heldoutFinal) {
    failures.push('held-out set produced no n=20 bucket');
  } else {
    if (heldoutFinal.mae > THRESHOLDS.mae) {
      failures.push(`held-out mae ${heldoutFinal.mae.toFixed(4)} above ${THRESHOLDS.mae}`);
    }
    if (heldoutFinal.within < THRESHOLDS.within) {
      failures.push(`held-out within ${heldoutFinal.within.toFixed(3)} below ${THRESHOLDS.within}`);
    }
  }
  if (minimum === null) {
    failures.push('no sample size met the thresholds on the tuning set');
  }

  const report = {
    generated: bundle.meta.generated,
    thresholds: THRESHOLDS,
    semantic: SEMANTIC ? {
      model: semantic.model,
      provider: semantic.provider,
      dimensions: semantic.dimensions,
      reference: 'target profession, excluded from candidates',
      weighting: 'full-profession shared activities, normalized per candidate'
    } : false,
    ignoreDenied: IGNORE_DENIED,
    split: { tuning: tuning.length, heldout: heldout.length },
    parameters: best,
    grid,
    tuning: tuningTable,
    heldout: heldoutTable,
    heldoutNoisy: { noise: NOISE_SHARE, table: noisyTable },
    derived: {
      empiricalMinimum: minimum,
      productFloor,
      operatingFloor,
      stopStability: stopThreshold,
      stopRule: `stop when at least ${operatingFloor} activities are declared and the blend moves less than ${stopThreshold} in total variation for two consecutive answers`
    },
    heldoutAt20: heldoutFinal,
    noisyAt20: noisyFinal,
    pass: failures.length === 0
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\nempirical minimum activities: ${minimum}`);
  console.log(`product floor from the DWA median: ${productFloor}`);
  console.log(`stop stability threshold: ${stopThreshold}`);
  console.log(`report written to ${path.relative(ROOT, REPORT)}`);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.log(`FAIL ${failure}`);
    }
    process.exit(1);
  }
  console.log('PASS held-out thresholds met');
}

main();
