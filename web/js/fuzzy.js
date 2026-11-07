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

  root.AIExposureFuzzy = { search: search, fold: fold };
})(typeof self !== 'undefined' ? self : globalThis);
