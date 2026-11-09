/*
 * Deterministic activity ranking.
 *
 * The user splits each group into three ordered buckets: more frequent,
 * normal, and less frequent. Every group above four activities is split again.
 * A group of four or fewer activities is ordered directly. The final order is
 * the concatenation of the buckets, so transitivity holds by construction:
 * if A is in a higher bucket than B, and B is in a higher bucket than C, then
 * A is above C. There is no probabilistic model and no uncertainty.
 *
 * Classic script on purpose, same as model.js and fuzzy.js.
 */
(function (root) {
  'use strict';

  var LEAF_SIZE = 4;

  function unique(items) {
    var seen = new Set();
    var out = [];
    for (var i = 0; i < items.length; i += 1) {
      if (!seen.has(items[i])) {
        seen.add(items[i]);
        out.push(items[i]);
      }
    }
    return out;
  }

  function makeNode(items) {
    return {
      items: items.slice(),
      answer: null,
      children: null,
      resolved: false
    };
  }

  function create(items) {
    var model = {
      items: [],
      root: null,
      queue: [],
      current: null,
      answered: 0
    };
    setItems(model, items || []);
    return model;
  }

  function setItems(model, items) {
    var next = unique(items || []);
    model.items = next;
    model.root = makeNode(next);
    model.queue = [model.root];
    model.current = null;
    model.answered = 0;
    prepareNext(model);
  }

  /* Depth-first is not needed: the queue gives one level at a time. Nodes with
   * one activity resolve without a question. */
  function prepareNext(model) {
    model.current = null;
    while (model.queue.length > 0) {
      var node = model.queue[0];
      if (node.resolved) {
        model.queue.shift();
        continue;
      }
      if (node.items.length <= 1) {
        node.answer = node.items.slice();
        node.resolved = true;
        model.queue.shift();
        continue;
      }
      model.current = node;
      return;
    }
  }

  function nextQuestion(model) {
    if (!model.current) {
      prepareNext(model);
    }
    if (!model.current) {
      return null;
    }
    var node = model.current;
    return {
      type: node.items.length <= LEAF_SIZE ? 'order' : 'group',
      items: node.items.slice()
    };
  }

  /* buckets: { high, normal, low }. At least two buckets must be non-empty,
   * otherwise the group would not shrink and the questionnaire could loop. */
  function answerGroup(model, buckets) {
    var node = model.current;
    if (!node || node.items.length <= LEAF_SIZE) {
      return false;
    }
    var high = unique(buckets && buckets.high ? buckets.high : []);
    var normal = unique(buckets && buckets.normal ? buckets.normal : []);
    var low = unique(buckets && buckets.low ? buckets.low : []);
    var all = high.concat(normal, low);
    if (all.length !== node.items.length) {
      return false;
    }
    var expected = new Set(node.items);
    var seen = new Set();
    for (var i = 0; i < all.length; i += 1) {
      if (!expected.has(all[i]) || seen.has(all[i])) {
        return false;
      }
      seen.add(all[i]);
    }
    var nonEmpty = 0;
    if (high.length > 0) { nonEmpty += 1; }
    if (normal.length > 0) { nonEmpty += 1; }
    if (low.length > 0) { nonEmpty += 1; }
    if (nonEmpty < 2) {
      return false;
    }
    node.children = {
      high: makeNode(high),
      normal: makeNode(normal),
      low: makeNode(low)
    };
    node.resolved = true;
    model.queue.shift();
    [node.children.high, node.children.normal, node.children.low].forEach(function (child) {
      if (child.items.length > 0) {
        model.queue.push(child);
      }
    });
    model.answered += 1;
    model.current = null;
    prepareNext(model);
    return true;
  }

  function answerOrder(model, order) {
    var node = model.current;
    if (!node || node.items.length > LEAF_SIZE) {
      return false;
    }
    var list = unique(order || []);
    if (list.length !== node.items.length) {
      return false;
    }
    var expected = new Set(node.items);
    for (var i = 0; i < list.length; i += 1) {
      if (!expected.has(list[i])) {
        return false;
      }
    }
    node.answer = list.slice();
    node.resolved = true;
    model.queue.shift();
    model.answered += 1;
    model.current = null;
    prepareNext(model);
    return true;
  }

  function collect(node) {
    if (!node) {
      return [];
    }
    if (node.answer) {
      return node.answer.slice();
    }
    if (!node.children) {
      return [];
    }
    return collect(node.children.high)
      .concat(collect(node.children.normal))
      .concat(collect(node.children.low));
  }

  function order(model) {
    return collect(model.root);
  }

  function isComplete(node) {
    if (!node || node.items.length === 0) {
      return true;
    }
    if (node.answer) {
      return true;
    }
    if (!node.children) {
      return false;
    }
    return (
      isComplete(node.children.high) &&
      isComplete(node.children.normal) &&
      isComplete(node.children.low)
    );
  }

  function isDone(model) {
    return isComplete(model.root);
  }

  function progress(model) {
    return {
      answered: model.answered,
      current: model.current ? model.current.items.length : 0,
      type: model.current
        ? model.current.items.length <= LEAF_SIZE
          ? 'order'
          : 'group'
        : null
    };
  }

  root.AIExposureRank = {
    LEAF_SIZE: LEAF_SIZE,
    create: create,
    setItems: setItems,
    nextQuestion: nextQuestion,
    answerGroup: answerGroup,
    answerOrder: answerOrder,
    isDone: isDone,
    order: order,
    progress: progress
  };
})(typeof self !== 'undefined' ? self : globalThis);
