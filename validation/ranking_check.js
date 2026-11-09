#!/usr/bin/env node
/* Validates the deterministic recursive activity ranking.
 *
 * The harness builds a true order, perturbs consecutive blocks of 3 or 4
 * activities, simulates the grouping and leaf answers from the perturbed
 * order, then checks that the model returns the perturbed order exactly. The
 * displacement from the true order must stay inside the perturbation block.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(ROOT, 'web', 'js', 'rank.js'), 'utf8');
const context = { self: {} };
vm.createContext(context);
vm.runInContext(source, context);
const Rank = context.self.AIExposureRank;

function mulberry32(seed) {
  let state = seed >>> 0;
  return function () {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const temporary = out[i];
    out[i] = out[j];
    out[j] = temporary;
  }
  return out;
}

/* Shuffle each consecutive block of 3 or 4 activities. This models a user who
 * is unsure inside a small group but knows the order between groups. */
function perturb(order, random) {
  const out = [];
  let index = 0;
  while (index < order.length) {
    const remaining = order.length - index;
    const size = remaining <= 4 ? remaining : random() < 0.5 ? 3 : 4;
    out.push(...shuffle(order.slice(index, index + size), random));
    index += size;
  }
  return out;
}

function simulate(model, perceived) {
  const position = new Map(perceived.map((item, index) => [item, index]));
  let guard = 0;
  while (!Rank.isDone(model) && guard < 10000) {
    guard += 1;
    const question = Rank.nextQuestion(model);
    if (!question) {
      break;
    }
    const sorted = question.items.slice().sort((a, b) => position.get(a) - position.get(b));
    if (question.type === 'group') {
      const m = sorted.length;
      const cut1 = Math.ceil(m / 3);
      const cut2 = Math.ceil((2 * m) / 3);
      const ok = Rank.answerGroup(model, {
        high: sorted.slice(0, cut1),
        normal: sorted.slice(cut1, cut2),
        low: sorted.slice(cut2)
      });
      if (!ok) {
        throw new Error('answerGroup rejected a valid partition');
      }
    } else {
      const ok = Rank.answerOrder(model, sorted);
      if (!ok) {
        throw new Error('answerOrder rejected a valid order');
      }
    }
  }
  if (!Rank.isDone(model)) {
    throw new Error('the questionnaire did not finish');
  }
  return Rank.order(model);
}

function maxDisplacement(result, truth) {
  const position = new Map(truth.map((item, index) => [item, index]));
  let max = 0;
  for (let i = 0; i < result.length; i += 1) {
    max = Math.max(max, Math.abs(i - position.get(result[i])));
  }
  return max;
}

function kendall(result, truth) {
  const position = new Map(truth.map((item, index) => [item, index]));
  let inversions = 0;
  for (let i = 0; i < result.length; i += 1) {
    for (let j = i + 1; j < result.length; j += 1) {
      if (position.get(result[i]) > position.get(result[j])) {
        inversions += 1;
      }
    }
  }
  return inversions;
}

const sizes = [12, 20, 40, 60];
const trials = 50;
const failures = [];
for (const n of sizes) {
  let maxObserved = 0;
  let maxInversions = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    const random = mulberry32(1000 + n * 97 + trial);
    const trueOrder = shuffle(Array.from({ length: n }, (_, i) => i), random);
    const perceived = perturb(trueOrder, random);
    const result = simulate(Rank.create(trueOrder), perceived);
    if (result.length !== n || new Set(result).size !== n) {
      failures.push(`n=${n} trial=${trial}: output is not a permutation`);
      continue;
    }
    if (result.some((item, index) => item !== perceived[index])) {
      failures.push(`n=${n} trial=${trial}: output differs from the perturbed order`);
    }
    const displacement = maxDisplacement(result, trueOrder);
    const inversions = kendall(result, trueOrder);
    maxObserved = Math.max(maxObserved, displacement);
    maxInversions = Math.max(maxInversions, inversions);
    if (displacement > 3) {
      failures.push(`n=${n} trial=${trial}: displacement ${displacement} exceeds 3`);
    }
  }
  console.log(
    `n=${n}: ${trials} trials, max displacement ${maxObserved}, max Kendall inversions ${maxInversions}`
  );
}
if (failures.length > 0) {
  for (const failure of failures.slice(0, 20)) {
    console.log('FAIL ' + failure);
  }
  if (failures.length > 20) {
    console.log(`FAIL ... ${failures.length - 20} more`);
  }
  process.exit(1);
}
console.log('PASS deterministic ranking: perturbations in blocks of 3-4 stay local');
