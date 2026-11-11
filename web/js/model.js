/*
 * Exposure model: sparse convex blending over O*NET occupations.
 *
 * Classic script on purpose. The page loads it from file:// with no network,
 * and validation/run_validation.js loads the same bytes with node:vm, so both
 * surfaces run identical code.
 *
 * Vocabulary
 *   evidence    what the user declared: performed DWA indices and denied ones.
 *               Every other DWA is missing data, never a zero.
 *   support     the occupations that carry non-zero blend weight.
 *   exposure    the OECD reversed normalised gap index, 0 to 1, higher is more
 *               exposed. The raw gap index moves the other way.
 */
(function (root) {
  'use strict';

  var EPS = 0.02;
  var DEFAULTS = {
    candidates: 60,
    maxSupport: 8,
    iterations: 320,
    refineIterations: 240,
    learningRate: 0.7,
    titleWeight: 0.75,
    titlePrior: 20,
    resamples: 24,
    bootstrapShare: 0.8
  };

  /* O*NET work context frequency scale. Scales Reference.txt lists CX as
   * "Context", 1 to 5; Work Context.txt rates its frequency elements on CX and
   * Work Context Categories.txt gives the five level labels. Frequency weights
   * the evidence: a task done every day counts more than one done once a year. */
  var FREQUENCY_MIN = 1;
  var FREQUENCY_MAX = 5;

  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function buildIndex(dataset) {
    var occupations = dataset.occupations;
    var nOcc = occupations.length;
    var nDwa = dataset.dwas.length;
    var occDwa = new Array(nOcc);
    var dwaOcc = new Array(nDwa);
    var exposure = new Float64Array(nOcc);
    var gap = new Float64Array(nOcc);
    var i;
    for (i = 0; i < nDwa; i += 1) {
      dwaOcc[i] = [];
    }
    for (i = 0; i < nOcc; i += 1) {
      var list = Int32Array.from(occupations[i].dwa);
      occDwa[i] = list;
      exposure[i] = occupations[i].e;
      gap[i] = occupations[i].g;
      for (var j = 0; j < list.length; j += 1) {
        dwaOcc[list[j]].push(i);
      }
    }
    return {
      dataset: dataset,
      nOcc: nOcc,
      nDwa: nDwa,
      occDwa: occDwa,
      dwaOcc: dwaOcc,
      exposure: exposure,
      gap: gap
    };
  }

  /* Each selected profession contributes in proportion to the activities
   * that it shares with the candidate. No shared activities means no term. */
  function semanticSimilarity(index, selected, semantic) {
    var references = Array.from(new Set(selected));
    if (references.length === 0) {
      return null;
    }
    if (!semantic || semantic.codes.length !== index.nOcc ||
        semantic.similarities.length !== index.nOcc) {
      throw new Error('Missing or stale profession similarity matrix. Rebuild the semantic data.');
    }
    for (var o = 0; o < index.nOcc; o += 1) {
      if (semantic.codes[o] !== index.dataset.occupations[o].c ||
          semantic.similarities[o].length !== index.nOcc) {
        throw new Error('Profession similarity matrix does not match the dataset. Rebuild the semantic data.');
      }
    }
    var similarity = new Float64Array(index.nOcc);
    var total = new Int32Array(index.nOcc);
    var shared = new Int32Array(index.nOcc);
    for (var r = 0; r < references.length; r += 1) {
      var reference = references[r];
      shared.fill(0);
      var activities = index.occDwa[reference];
      for (var d = 0; d < activities.length; d += 1) {
        var occupations = index.dwaOcc[activities[d]];
        for (var k = 0; k < occupations.length; k += 1) {
          shared[occupations[k]] += 1;
        }
      }
      var row = semantic.similarities[reference];
      for (o = 0; o < index.nOcc; o += 1) {
        similarity[o] += shared[o] * row[o];
        total[o] += shared[o];
      }
    }
    for (o = 0; o < index.nOcc; o += 1) {
      similarity[o] = total[o] > 0 ? similarity[o] / total[o] : 0;
    }
    return similarity;
  }

  function maskFromEvidence(index, evidence) {
    var mask = new Uint8Array(index.nDwa);
    var i;
    for (i = 0; i < evidence.performed.length; i += 1) {
      mask[evidence.performed[i]] = 1;
    }
    for (i = 0; i < evidence.denied.length; i += 1) {
      mask[evidence.denied[i]] = 2;
    }
    return mask;
  }

  /* Read the stated frequency for one activity. The page passes a Map from DWA
   * index to the number the user typed; anything missing or invalid falls back
   * to unit weight, which reproduces the unweighted model. */
  /* Position to O*NET importance. The build ships priorityImportance, the mean
   * O*NET importance at each relative rank in the user's order. A declared
   * activity takes the interpolated value for its position, so ordering by
   * O*NET importance produces weights on the O*NET scale. */
  function priorityImportanceWeight(evidence, dwa, fallback) {
    var table = evidence.priorityImportance;
    var priority = evidence.priority;
    if (!table || !priority || priority.length === 0) {
      return fallback;
    }
    var position = -1;
    for (var i = 0; i < priority.length; i += 1) {
      if (priority[i] === dwa) {
        position = i;
        break;
      }
    }
    if (position < 0) {
      return fallback;
    }
    var q = priority.length === 1 ? 0 : position / (priority.length - 1);
    var x = q * (table.length - 1);
    var low = Math.floor(x);
    var fraction = x - low;
    var a = table[low];
    var b = table[Math.min(table.length - 1, low + 1)];
    return a + (b - a) * fraction;
  }

  function frequencyOf(evidence, dwa, fallback) {
    var source = evidence.frequency;
    if (!source) {
      return fallback;
    }
    var value;
    if (typeof source === 'function') {
      value = source(dwa);
    } else if (typeof source.get === 'function') {
      value = source.get(dwa);
    } else {
      value = source[dwa];
    }
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    value = Number(value);
    if (!isFinite(value)) {
      return fallback;
    }
    if (value < FREQUENCY_MIN) {
      value = FREQUENCY_MIN;
    }
    if (value > FREQUENCY_MAX) {
      value = FREQUENCY_MAX;
    }
    return value;
  }

  /* Weighted evidence: each performed and denied activity carries its O*NET
   * frequency as a multiplicative weight, so a daily activity is stronger
   * evidence than a yearly one. Unit weights when no frequency is supplied, so
   * every pre-existing call keeps the unweighted behaviour.
   *
   * Priority rule: evidence order is priority. The frequency sets the
   * magnitude; the position only breaks ties (occupation ranking and candidate
   * selection prefer the occupation that matches more of the higher-priority
   * declared activities) and orders the declared activity list. */
  function weightedEvidence(evidence) {
    if (evidence.performedWeights && evidence.deniedWeights) {
      return evidence;
    }
    var performed = evidence.performed;
    var denied = evidence.denied;
    var performedWeights = new Float64Array(performed.length);
    var deniedWeights = new Float64Array(denied.length);
    var i;
    var hasFrequency = Boolean(evidence.frequency);
    for (i = 0; i < performed.length; i += 1) {
      performedWeights[i] = hasFrequency
        ? frequencyOf(evidence, performed[i], 1)
        : priorityImportanceWeight(evidence, performed[i], 1);
    }
    for (i = 0; i < denied.length; i += 1) {
      deniedWeights[i] = hasFrequency
        ? frequencyOf(evidence, denied[i], 1)
        : priorityImportanceWeight(evidence, denied[i], 1);
    }
    return {
      performed: performed,
      denied: denied,
      performedWeights: performedWeights,
      deniedWeights: deniedWeights,
      frequency: evidence.frequency,
      priority: evidence.priority ? Int32Array.from(evidence.priority) : null,
      priorityImportance: evidence.priorityImportance || null,
      titleSimilarity: evidence.titleSimilarity || null,
      exclude: evidence.exclude || null
    };
  }

  function flagEvidence(index, performed, denied) {
    var performedFlag = new Uint8Array(index.nDwa);
    var deniedFlag = new Uint8Array(index.nDwa);
    var i;
    for (i = 0; i < performed.length; i += 1) {
      performedFlag[performed[i]] = 1;
    }
    for (i = 0; i < denied.length; i += 1) {
      deniedFlag[denied[i]] = 1;
    }
    return { performed: performedFlag, denied: deniedFlag };
  }

  /* Priority tie-break score. Earlier declared activities weigh more, and a
   * denied activity subtracts, so an equal-similarity occupation that matches
   * the priority order wins. */
  function priorityScores(index, evidence) {
    var scores = new Float64Array(index.nOcc);
    var priority = evidence.priority;
    if (!priority || priority.length === 0) {
      return scores;
    }
    var flags = flagEvidence(index, evidence.performed, evidence.denied);
    for (var p = 0; p < priority.length; p += 1) {
      var dwa = priority[p];
      var sign = flags.performed[dwa] ? 1 : flags.denied[dwa] ? -1 : 0;
      if (sign === 0) {
        continue;
      }
      var share = sign / (p + 1);
      var occupations = index.dwaOcc[dwa];
      for (var m = 0; m < occupations.length; m += 1) {
        scores[occupations[m]] += share;
      }
    }
    return scores;
  }

  function weightSum(values) {
    var total = 0;
    for (var i = 0; i < values.length; i += 1) {
      total += values[i];
    }
    return total;
  }

  /* Declared activities in the caller's priority order, with the frequency
   * kept as the magnitude. */
  function declaredOrder(index, evidence) {
    var weighted = weightedEvidence(evidence);
    var priority = weighted.priority;
    var order = [];
    if (!priority || priority.length === 0) {
      return order;
    }
    var flags = flagEvidence(index, weighted.performed, weighted.denied);
    var weightsByDwa = new Float64Array(index.nDwa);
    var j;
    for (j = 0; j < weighted.performed.length; j += 1) {
      weightsByDwa[weighted.performed[j]] = weighted.performedWeights[j];
    }
    for (j = 0; j < weighted.denied.length; j += 1) {
      weightsByDwa[weighted.denied[j]] = weighted.deniedWeights[j];
    }
    for (var p = 0; p < priority.length; p += 1) {
      var dwa = priority[p];
      order.push({
        dwa: dwa,
        frequency: frequencyOf(evidence, dwa, 1),
        weight: weightsByDwa[dwa] || 0,
        performed: flags.performed[dwa] === 1,
        denied: flags.denied[dwa] === 1
      });
    }
    return order;
  }

  /* Per-occupation agreement with the evidence, in closed form.
   * With smoothing, a match scores log(1-EPS) and a mismatch log(EPS). A
   * declared activity carries its frequency weight on that log score, so the
   * weighted average log score depends only on how many declared and denied
   * activities the occupation contains. */
  function scoreOccupations(index, evidence) {
    var weighted = weightedEvidence(evidence);
    var performed = weighted.performed;
    var denied = weighted.denied;
    var performedWeights = weighted.performedWeights;
    var deniedWeights = weighted.deniedWeights;
    var nPerformed = performed.length;
    var totalPerformed = weightSum(performedWeights);
    var totalDenied = weightSum(deniedWeights);
    var totalWeight = totalPerformed + totalDenied;
    var performedLookup = new Float64Array(index.nDwa);
    var deniedLookup = new Float64Array(index.nDwa);
    var i;
    for (i = 0; i < nPerformed; i += 1) {
      performedLookup[performed[i]] = performedWeights[i];
    }
    for (i = 0; i < denied.length; i += 1) {
      deniedLookup[denied[i]] = deniedWeights[i];
    }
    var logHit = Math.log(1 - EPS);
    var logMiss = Math.log(EPS);
    var scores = new Float64Array(index.nOcc);
    var similarity = new Float64Array(index.nOcc);
    var shared = new Int32Array(index.nOcc);
    for (var o = 0; o < index.nOcc; o += 1) {
      var list = index.occDwa[o];
      var hits = 0;
      var hitWeight = 0;
      var deniedWeight = 0;
      for (var k = 0; k < list.length; k += 1) {
        var dwa = list[k];
        if (performedLookup[dwa] > 0) {
          hits += 1;
          hitWeight += performedLookup[dwa];
        }
        if (deniedLookup[dwa] > 0) {
          deniedWeight += deniedLookup[dwa];
        }
      }
      shared[o] = hits;
      var score =
        (hitWeight + totalDenied - deniedWeight) * logHit +
        (totalPerformed - hitWeight + deniedWeight) * logMiss;
      scores[o] = score;
      similarity[o] = totalWeight === 0 ? 0 : Math.exp(score / totalWeight);
    }
    return {
      scores: scores,
      similarity: similarity,
      shared: shared,
      priorityScore: priorityScores(
        index,
        { performed: performed, denied: denied, priority: weighted.priority }
      )
    };
  }

  /* Semantic title scores supplement the activity likelihood.
   * With no selected professions the combined score is activity-only. */
  function applyTitleFusion(scored, titleSimilarity, titleWeight) {
    var n = scored.similarity.length;
    var combined = new Float64Array(n);
    var weight = titleSimilarity ? titleWeight : 0;
    if (typeof weight !== 'number' || !isFinite(weight)) {
      weight = 0;
    }
    weight = Math.max(0, Math.min(1, weight));
    for (var o = 0; o < n; o += 1) {
      var title = titleSimilarity ? titleSimilarity[o] : 0;
      combined[o] = (1 - weight) * scored.similarity[o] + weight * title;
    }
    scored.combinedSimilarity = combined;
    scored.titleSimilarity = titleSimilarity || null;
    scored.titleWeight = weight;
  }

  /* The title similarity also acts as a prior on the blend weights. A
   * title-dissimilar occupation gets a negative linear term, so the optimizer
   * can lower its weight without a hard exclusion. The term is zero when the
   * title matches and equals -titlePrior when the title is unrelated. */
  function titlePriorGradient(scored, titlePrior) {
    if (!scored.titleSimilarity || !titlePrior) {
      return null;
    }
    var prior = new Float64Array(scored.titleSimilarity.length);
    for (var o = 0; o < prior.length; o += 1) {
      prior[o] = titlePrior * (scored.titleSimilarity[o] - 1);
    }
    return prior;
  }

  /* Occupations that the caller forbids as candidates. The validation harness
   * uses this to remove the true occupation, so the estimate cannot copy it. */
  function excludedMask(index, exclude) {
    if (!exclude) {
      return null;
    }
    var list = Array.from(exclude);
    if (list.length === 0) {
      return null;
    }
    var mask = new Uint8Array(index.nOcc);
    for (var i = 0; i < list.length; i += 1) {
      var o = list[i];
      if (o >= 0 && o < index.nOcc) {
        mask[o] = 1;
      }
    }
    return mask;
  }

  function rankOccupations(index, scored, weights) {
    var similarity = scored.combinedSimilarity || scored.similarity;
    var order = [];
    for (var o = 0; o < index.nOcc; o += 1) {
      if (scored.exclude && scored.exclude[o]) {
        continue;
      }
      order.push(o);
    }
    order.sort(function (a, b) {
      if (similarity[b] !== similarity[a]) {
        return similarity[b] - similarity[a];
      }
      var priorityB = scored.priorityScore ? scored.priorityScore[b] : 0;
      var priorityA = scored.priorityScore ? scored.priorityScore[a] : 0;
      if (priorityB !== priorityA) {
        return priorityB - priorityA;
      }
      return a - b;
    });
    var rank = new Int32Array(index.nOcc);
    for (var i = 0; i < order.length; i += 1) {
      rank[order[i]] = i + 1;
    }
    return { order: order, rank: rank };
  }

  function candidateSet(scored, limit) {
    var similarity = scored.titleSimilarity && scored.titleWeight > 0
      ? scored.combinedSimilarity : scored.scores;
    var order = [];
    for (var o = 0; o < scored.scores.length; o += 1) {
      if (scored.exclude && scored.exclude[o]) {
        continue;
      }
      order.push(o);
    }
    order.sort(function (a, b) {
      if (similarity[b] !== similarity[a]) {
        return similarity[b] - similarity[a];
      }
      var priorityB = scored.priorityScore ? scored.priorityScore[b] : 0;
      var priorityA = scored.priorityScore ? scored.priorityScore[a] : 0;
      if (priorityB !== priorityA) {
        return priorityB - priorityA;
      }
      return a - b;
    });
    return order.slice(0, Math.min(limit, order.length));
  }

  /* Exponentiated gradient ascent on the simplex. Multiplicative updates keep
   * the weights non-negative and summing to one, so no projection is needed.
   * Each evidence term enters the gradient with its frequency weight, which is
   * what makes a frequent activity count more than a rare one. */
  function exponentiatedGradient(index, evidence, support, weights, iterations, learningRate, slotTable, prior) {
    var weighted = weightedEvidence(evidence);
    var nPerformed = weighted.performed.length;
    var nDenied = weighted.denied.length;
    if (nPerformed + nDenied === 0 || support.length === 0) {
      return weights;
    }
    var performed = weighted.performed;
    var denied = weighted.denied;
    var performedWeights = weighted.performedWeights;
    var deniedWeights = weighted.deniedWeights;
    var total = performed.length + denied.length;
    var positions = new Int32Array(index.nDwa).fill(-1);
    var strength = new Float64Array(total);
    var d;
    var i;
    for (i = 0; i < total; i += 1) {
      if (i < nPerformed) {
        positions[performed[i]] = i;
        strength[i] = performedWeights[i];
      } else {
        positions[denied[i - nPerformed]] = i;
        strength[i] = deniedWeights[i - nPerformed];
      }
    }
    var p = new Float64Array(total);
    var gradient = new Float64Array(support.length);
    var step = 0;

    function recompute() {
      p.fill(0);
      for (var s = 0; s < support.length; s += 1) {
        var w = weights[s];
        if (w === 0) {
          continue;
        }
        var list = index.occDwa[support[s]];
        for (var k = 0; k < list.length; k += 1) {
          var position = positions[list[k]];
          if (position >= 0) {
            p[position] += w;
          }
        }
      }
    }

    recompute();
    for (var stepIndex = 0; stepIndex < iterations; stepIndex += 1) {
      gradient.fill(0);
      var maxAbs = 0;
      for (d = 0; d < total; d += 1) {
        var positive = d < nPerformed;
        var value = p[d] * (1 - 2 * EPS) + EPS;
        var weight = (positive ? 1 / value : -1 / (1 - value)) * strength[d];
        var dwa = positive ? performed[d] : denied[d - nPerformed];
        var occs = index.dwaOcc[dwa];
        for (var m = 0; m < occs.length; m += 1) {
          var slot = slotOf(occs[m]);
          if (slot >= 0) {
            gradient[slot] += weight;
          }
        }
      }
      if (prior) {
        for (i = 0; i < support.length; i += 1) {
          gradient[i] += prior[support[i]];
        }
      }
      for (i = 0; i < gradient.length; i += 1) {
        var magnitude = Math.abs(gradient[i]);
        if (magnitude > maxAbs) {
          maxAbs = magnitude;
        }
      }
      if (maxAbs === 0) {
        break;
      }
      step = learningRate / maxAbs;
      var sum = 0;
      for (i = 0; i < support.length; i += 1) {
        var updated = weights[i] * Math.exp(step * gradient[i]);
        if (!isFinite(updated)) {
          updated = weights[i];
        }
        weights[i] = updated;
        sum += updated;
      }
      if (sum <= 0 || !isFinite(sum)) {
        break;
      }
      for (i = 0; i < support.length; i += 1) {
        weights[i] /= sum;
      }
      recompute();
    }
    return weights;

    function slotOf(occupation) {
      return slotTable[occupation];
    }
  }

  /* Weighted entry point. evidence may carry a `frequency` Map (DWA index to
   * the 1 to 5 O*NET frequency); fitBlend keeps the original signature and both
   * run the same code. */
  function fitBlendWeighted(index, evidence, options) {
    return fitBlendCore(index, weightedEvidence(evidence), options);
  }

  function fitBlend(index, evidence, options) {
    return fitBlendWeighted(index, evidence, options);
  }

  function exactOccupation(index, evidence, excluded) {
    if (evidence.denied.length > 0 || evidence.performed.length === 0) {
      return -1;
    }
    var mask = new Uint8Array(index.nDwa);
    var unique = 0;
    for (var i = 0; i < evidence.performed.length; i += 1) {
      if (!mask[evidence.performed[i]]) {
        mask[evidence.performed[i]] = 1;
        unique += 1;
      }
    }
    for (var o = 0; o < index.nOcc; o += 1) {
      if (excluded && excluded[o]) {
        continue;
      }
      var list = index.occDwa[o];
      if (list.length !== unique) {
        continue;
      }
      var match = true;
      for (var k = 0; k < list.length; k += 1) {
        if (!mask[list[k]]) {
          match = false;
          break;
        }
      }
      if (match) {
        return o;
      }
    }
    return -1;
  }

  function fitBlendCore(index, evidence, options) {
    var settings = Object.assign({}, DEFAULTS, options || {});
    var started = now();
    var scored = scoreOccupations(index, evidence);
    scored.exclude = excludedMask(index, evidence.exclude);
    applyTitleFusion(scored, evidence.titleSimilarity, settings.titleWeight);
    var prior = titlePriorGradient(scored, settings.titlePrior);
    var exact = exactOccupation(index, evidence, scored.exclude);
    var exactTitle = exact >= 0 && scored.titleSimilarity ? scored.titleSimilarity[exact] : 1;
    if (exact >= 0 && exactTitle >= 0.999) {
      var result = summarize(index, evidence, scored, [exact], new Float64Array([1]));
      result.candidates = [exact];
      result.elapsedMs = Math.round(now() - started);
      result.scored = scored;
      return result;
    }
    var candidates = candidateSet(scored, settings.candidates);
    var slotTable = new Int32Array(index.nOcc).fill(-1);
    var i;
    for (i = 0; i < candidates.length; i += 1) {
      slotTable[candidates[i]] = i;
    }

    var support = candidates.slice();
    var weights = new Float64Array(support.length).fill(1 / support.length);
    exponentiatedGradient(index, evidence, support, weights, settings.iterations, settings.learningRate, slotTable, prior);

    /* Sparsify: keep the smallest support that carries the bulk of the mass. */
    var order = [];
    for (i = 0; i < support.length; i += 1) {
      order.push(i);
    }
    order.sort(function (a, b) {
      return weights[b] - weights[a];
    });
    var keep = 0;
    var carried = 0;
    while (keep < order.length && keep < settings.maxSupport) {
      carried += weights[order[keep]];
      keep += 1;
      if (carried >= 0.9 && keep >= 2) {
        break;
      }
    }
    keep = Math.max(1, keep);
    var trimmedSupport = [];
    var trimmedWeights = new Float64Array(keep);
    var mass = 0;
    for (i = 0; i < keep; i += 1) {
      trimmedSupport.push(support[order[i]]);
      trimmedWeights[i] = weights[order[i]];
      mass += trimmedWeights[i];
    }
    for (i = 0; i < keep; i += 1) {
      trimmedWeights[i] /= mass;
    }
    for (i = 0; i < slotTable.length; i += 1) {
      slotTable[i] = -1;
    }
    for (i = 0; i < trimmedSupport.length; i += 1) {
      slotTable[trimmedSupport[i]] = i;
    }
    exponentiatedGradient(
      index,
      evidence,
      trimmedSupport,
      trimmedWeights,
      settings.refineIterations,
      settings.learningRate,
      slotTable,
      prior
    );

    var result = summarize(index, evidence, scored, trimmedSupport, trimmedWeights);
    result.candidates = candidates;
    result.elapsedMs = Math.round(now() - started);
    result.scored = scored;
    return result;
  }

  function summarize(index, evidence, scored, support, weights) {
    var exposure = 0;
    var gap = 0;
    var concentration = 0;
    for (var i = 0; i < support.length; i += 1) {
      exposure += weights[i] * index.exposure[support[i]];
      gap += weights[i] * index.gap[support[i]];
      concentration += weights[i] * weights[i];
    }
    var ranking = rankOccupations(index, scored, weights);
    var top = [];
    for (var k = 0; k < Math.min(10, ranking.order.length); k += 1) {
      top.push(ranking.order[k]);
    }
    var weighted = weightedEvidence(evidence);
    return {
      support: support,
      weights: weights,
      exposure: exposure,
      gap: gap,
      effectiveSupport: concentration > 0 ? 1 / concentration : 0,
      similarity: scored.combinedSimilarity || scored.similarity,
      activitySimilarity: scored.similarity,
      shared: scored.shared,
      ranking: ranking,
      top: top,
      evidenceSize: weighted.performed.length + weighted.denied.length,
      evidenceWeight: weightSum(weighted.performedWeights) + weightSum(weighted.deniedWeights),
      evidenceOrder: declaredOrder(index, evidence)
    };
  }

  function exposureStandardDeviation(fits) {
    if (fits.length < 2) {
      return 0;
    }
    var mean = 0;
    var i;
    for (i = 0; i < fits.length; i += 1) {
      mean += fits[i];
    }
    mean /= fits.length;
    var variance = 0;
    for (i = 0; i < fits.length; i += 1) {
      variance += (fits[i] - mean) * (fits[i] - mean);
    }
    return Math.sqrt(variance / (fits.length - 1));
  }

  /* Bootstrap the evidence set: resample declared and denied activities with
   * replacement, refit, and report the spread of the exposure estimate. This
   * measures how much the answer depends on which activities were sampled. The
   * frequency weight travels with each resampled activity. */
  function bootstrapUncertainty(index, evidence, options) {
    var settings = Object.assign({}, DEFAULTS, options || {});
    var weighted = weightedEvidence(evidence);
    var resamples = settings.resamples;
    var estimates = [];
    if (resamples < 2) {
      return { std: 0, estimates: estimates };
    }
    var random = settings.random || Math.random;
    var draw = Math.max(1, Math.round(weighted.performed.length * settings.bootstrapShare));
    var drawDenied = Math.max(0, Math.round(weighted.denied.length * settings.bootstrapShare));
    for (var r = 0; r < resamples; r += 1) {
      var performed = sampleWithReplacement(weighted.performed, weighted.performedWeights, draw, random);
      var denied = sampleWithReplacement(weighted.denied, weighted.deniedWeights, drawDenied, random);
      var fit = fitBlendCore(
        index,
        {
          performed: performed.indices,
          denied: denied.indices,
          performedWeights: performed.weights,
          deniedWeights: denied.weights,
          priority: weighted.priority,
          exclude: weighted.exclude,
          titleSimilarity: weighted.titleSimilarity
        },
        Object.assign({}, settings, { resamples: 0 })
      );
      estimates.push(fit.exposure);
    }
    return { std: exposureStandardDeviation(estimates), estimates: estimates };
  }

  function sampleWithReplacement(source, weights, count, random) {
    var indices = new Int32Array(count);
    var sampled = new Float64Array(count);
    if (source.length === 0) {
      return { indices: indices, weights: sampled };
    }
    for (var i = 0; i < count; i += 1) {
      var pick = Math.floor(random() * source.length) % source.length;
      indices[i] = source[pick];
      sampled[i] = weights[pick];
    }
    return { indices: indices, weights: sampled };
  }

  function stability(previous, current) {
    if (!previous || !current) {
      return 1;
    }
    var map = new Map();
    var i;
    for (i = 0; i < previous.support.length; i += 1) {
      map.set(previous.support[i], previous.weights[i]);
    }
    var total = 0;
    for (i = 0; i < current.support.length; i += 1) {
      var before = map.get(current.support[i]) || 0;
      map.delete(current.support[i]);
      total += Math.abs(before - current.weights[i]);
    }
    map.forEach(function (value) {
      total += Math.abs(value);
    });
    return total / 2;
  }

  root.AIExposureModel = {
    EPS: EPS,
    DEFAULTS: DEFAULTS,
    FREQUENCY_MIN: FREQUENCY_MIN,
    FREQUENCY_MAX: FREQUENCY_MAX,
    buildIndex: buildIndex,
    semanticSimilarity: semanticSimilarity,
    scoreOccupations: scoreOccupations,
    fitBlend: fitBlend,
    fitBlendWeighted: fitBlendWeighted,
    bootstrapUncertainty: bootstrapUncertainty,
    stability: stability
  };
})(typeof self !== 'undefined' ? self : globalThis);
