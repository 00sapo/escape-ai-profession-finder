/*
 * Fuzzy occupation search. No dependency, no async, no model.
 * Folding: lowercase and strip diacritics. Tokens are the folded words.
 * Score: exact substring (300) beats prefix (200) beats all tokens present
 * (100 + coverage) beats subsequence (50) beats a token edit distance of at
 * most 2 (10 - distance). Ties go to the title, then the index.
 */
(function (root) {
  'use strict';

  function fold(text) {
    return String(text)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function editDistance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) {
      return limit + 1;
    }
    var previous = new Array(b.length + 1);
    var current = new Array(b.length + 1);
    var i;
    var j;
    for (j = 0; j <= b.length; j += 1) {
      previous[j] = j;
    }
    for (i = 1; i <= a.length; i += 1) {
      current[0] = i;
      for (j = 1; j <= b.length; j += 1) {
        current[j] = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      var swap = previous;
      previous = current;
      current = swap;
    }
    return previous[b.length];
  }

  function subsequence(needle, haystack) {
    var at = 0;
    for (var i = 0; i < haystack.length && at < needle.length; i += 1) {
      if (haystack[i] === needle[at]) {
        at += 1;
      }
    }
    return at === needle.length;
  }

  function scoreTitle(query, title) {
    var foldedQuery = fold(query).trim();
    if (!foldedQuery) {
      return 0;
    }
    var foldedTitle = fold(title);
    var position = foldedTitle.indexOf(foldedQuery);
    if (position >= 0) {
      return 300 - Math.min(50, position);
    }
    var tokens = foldedQuery.split(/\s+/).filter(Boolean);
    var titleTokens = foldedTitle.split(/[^a-z0-9]+/).filter(Boolean);
    if (tokens.length === 0) {
      return 0;
    }
    if (tokens.every(function (token) {
      return titleTokens.some(function (word) {
        return word.indexOf(token) === 0;
      });
    })) {
      return 200 + tokens.length;
    }
    var present = tokens.filter(function (token) {
      return titleTokens.some(function (word) {
        return word.indexOf(token) >= 0;
      });
    }).length;
    if (present === tokens.length) {
      return 100 + tokens.length;
    }
    if (subsequence(tokens.join(''), foldedTitle)) {
      return 50;
    }
    var best = 3;
    for (var t = 0; t < tokens.length; t += 1) {
      for (var w = 0; w < titleTokens.length; w += 1) {
        var distance = editDistance(tokens[t], titleTokens[w], 2);
        if (distance < best) {
          best = distance;
        }
      }
    }
    return best <= 2 ? 10 - best : 0;
  }

  /* Pairwise title similarity. Fold case and diacritics, split on any
   * non-letter or non-digit, drop common words, then compare every token with
   * the best token on the other side. A token match is one minus the edit
   * distance divided by the longer length, so a typo keeps most of the score.
   * The result is symmetric and lies between 0 and 1. */
  var STOPWORDS = new Set([
    'a', 'an', 'and', 'the', 'of', 'in', 'on', 'for', 'to', 'with', 'at', 'by', 'from',
    'di', 'del', 'della', 'dei', 'delle', 'e', 'ed', 'per', 'con', 'da', 'un', 'una', 'uno',
    'y', 'el', 'la', 'las', 'los', 'de', 'en', 'por', 'para',
    'et', 'le', 'les', 'des', 'du', 'pour', 'avec', 'une',
    'و', 'في', 'من', 'على', 'إلى',
    'का', 'के', 'की', 'में', 'और',
    '的', '和', '与', '在'
  ]);

  function tokenize(text) {
    return fold(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(function (token) {
        return token && !STOPWORDS.has(token);
      });
  }

  function bigrams(text) {
    var grams = [];
    for (var i = 0; i < text.length - 1; i += 1) {
      grams.push(text.slice(i, i + 2));
    }
    return grams;
  }

  function tokenSimilarity(a, b) {
    if (a === b) {
      return 1;
    }
    if (a.indexOf(b) === 0 || b.indexOf(a) === 0) {
      return 1;
    }
    var left = bigrams(a);
    var right = bigrams(b);
    if (left.length === 0 || right.length === 0) {
      return 0;
    }
    var counts = new Map();
    var i;
    for (i = 0; i < left.length; i += 1) {
      counts.set(left[i], (counts.get(left[i]) || 0) + 1);
    }
    var overlap = 0;
    for (i = 0; i < right.length; i += 1) {
      var count = counts.get(right[i]) || 0;
      if (count > 0) {
        overlap += 1;
        counts.set(right[i], count - 1);
      }
    }
    return (2 * overlap) / (left.length + right.length);
  }

  function similarity(left, right) {
    var leftTokens = tokenize(left);
    var rightTokens = tokenize(right);
    if (leftTokens.length === 0 || rightTokens.length === 0) {
      return 0;
    }
    var total = 0;
    var i;
    var j;
    var best;
    for (i = 0; i < leftTokens.length; i += 1) {
      best = 0;
      for (j = 0; j < rightTokens.length; j += 1) {
        var forward = tokenSimilarity(leftTokens[i], rightTokens[j]);
        if (forward > best) {
          best = forward;
        }
      }
      total += best;
    }
    for (j = 0; j < rightTokens.length; j += 1) {
      best = 0;
      for (i = 0; i < leftTokens.length; i += 1) {
        var backward = tokenSimilarity(rightTokens[j], leftTokens[i]);
        if (backward > best) {
          best = backward;
        }
      }
      total += best;
    }
    return total / (leftTokens.length + rightTokens.length);
  }

  /* Returns [{index, score}] sorted by score, then title, capped at limit. */
  function search(query, titles, limit) {
    var hits = [];
    for (var i = 0; i < titles.length; i += 1) {
      var score = scoreTitle(query, titles[i]);
      if (score > 0) {
        hits.push({ index: i, score: score, title: titles[i] });
      }
    }
    hits.sort(function (a, b) {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.title !== b.title) {
        return a.title < b.title ? -1 : 1;
      }
      return a.index - b.index;
    });
    return hits.slice(0, limit);
  }

  root.AIExposureFuzzy = { search: search, similarity: similarity, fold: fold };
})(typeof self !== 'undefined' ? self : globalThis);
