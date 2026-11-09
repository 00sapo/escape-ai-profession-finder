/*
 * Deterministic activity ranking.
 *
 * The user splits each group into three ordered buckets: more frequent,
 * normal, and less frequent. Every group above four activities is split again.
 * A group of four or fewer activities needs no question: it keeps the order it
 * has in its bucket. The final order is the concatenation of the buckets, so
 * transitivity holds by construction. A completed tree can be reviewed: the
 * saved group questions appear again with their saved buckets, and a changed
 * split rebuilds only that subtree.
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

  function makeNode(items, bucket) {
    return {
      items: items.slice(),
      bucket: bucket || 'root',
      answer: null,
      children: null,
      resolved: false
    };
  }

  function createChildren(high, normal, low) {
    return {
      high: makeNode(high, 'high'),
      normal: makeNode(normal, 'normal'),
      low: makeNode(low, 'low')
    };
  }

  function create(items) {
    var model = {
      items: [],
      root: null,
      queue: [],
      current: null,
      answered: 0,
      reviewing: false,
      reviewQueue: [],
      reviewIndex: 0
    };
    setItems(model, items || []);
    return model;
  }

  function setItems(model, items) {
    var next = unique(items || []);
    model.items = next;
    model.root = makeNode(next, 'root');
    model.queue = [model.root];
    model.current = null;
    model.answered = 0;
    model.reviewing = false;
    model.reviewQueue = [];
    model.reviewIndex = 0;
    prepareNext(model);
  }

  /* One level at a time. A group of four or fewer activities needs no
   * question: it keeps its current item order. */
  function prepareNext(model) {
    model.current = null;
    while (model.queue.length > 0) {
      var node = model.queue[0];
      if (node.resolved) {
        model.queue.shift();
        continue;
      }
      if (node.items.length <= LEAF_SIZE) {
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
    if (model.reviewing) {
      var savedNode = model.current;
      if (!savedNode || !savedNode.children) {
        return null;
      }
      return {
        type: 'group',
        review: true,
        bucket: savedNode.bucket,
        items: savedNode.items.slice(),
        saved: {
          high: savedNode.children.high.items.slice(),
          normal: savedNode.children.normal.items.slice(),
          low: savedNode.children.low.items.slice()
        }
      };
    }
    if (!model.current) {
      prepareNext(model);
    }
    if (!model.current) {
      return null;
    }
    return {
      type: 'group',
      review: false,
      bucket: model.current.bucket,
      items: model.current.items.slice()
    };
  }

  function validateBuckets(node, buckets) {
    var high = unique(buckets && buckets.high ? buckets.high : []);
    var normal = unique(buckets && buckets.normal ? buckets.normal : []);
    var low = unique(buckets && buckets.low ? buckets.low : []);
    var all = high.concat(normal, low);
    if (all.length !== node.items.length) {
      return null;
    }
    var expected = new Set(node.items);
    var seen = new Set();
    for (var i = 0; i < all.length; i += 1) {
      if (!expected.has(all[i]) || seen.has(all[i])) {
        return null;
      }
      seen.add(all[i]);
    }
    var nonEmpty = 0;
    if (high.length > 0) { nonEmpty += 1; }
    if (normal.length > 0) { nonEmpty += 1; }
    if (low.length > 0) { nonEmpty += 1; }
    if (nonEmpty < 2) {
      return null;
    }
    return { high: high, normal: normal, low: low };
  }

  function pushChildren(model, node) {
    model.queue.shift();
    [node.children.high, node.children.normal, node.children.low].forEach(function (child) {
      if (child.items.length > 0) {
        model.queue.push(child);
      }
    });
  }

  /* buckets: { high, normal, low }. At least two buckets must be non-empty,
   * otherwise the group would not shrink and the questionnaire could loop. */
  function answerGroup(model, buckets) {
    if (model.reviewing) {
      return answerReviewGroup(model, buckets);
    }
    var node = model.current;
    if (!node || node.items.length <= LEAF_SIZE) {
      return false;
    }
    var valid = validateBuckets(node, buckets);
    if (!valid) {
      return false;
    }
    node.children = createChildren(valid.high, valid.normal, valid.low);
    node.resolved = true;
    pushChildren(model, node);
    model.answered += 1;
    model.current = null;
    prepareNext(model);
    return true;
  }

  function sameMembership(previous, next) {
    if (previous.length !== next.length) {
      return false;
    }
    var wanted = new Set(previous);
    for (var i = 0; i < next.length; i += 1) {
      if (!wanted.has(next[i])) {
        return false;
      }
    }
    return true;
  }

  function advanceReview(model) {
    model.reviewIndex += 1;
    if (model.reviewIndex >= model.reviewQueue.length) {
      model.reviewing = false;
      model.reviewQueue = [];
      model.reviewIndex = 0;
      model.current = null;
      return false;
    }
    model.current = model.reviewQueue[model.reviewIndex];
    return true;
  }

  /* Review one saved question. An unchanged split keeps the saved subtree. A
   * changed split rebuilds that subtree and returns to the normal flow. */
  function answerReviewGroup(model, buckets) {
    var node = model.current;
    if (!node || !node.children) {
      return false;
    }
    var valid = validateBuckets(node, buckets);
    if (!valid) {
      return false;
    }
    var unchanged =
      sameMembership(node.children.high.items, valid.high) &&
      sameMembership(node.children.normal.items, valid.normal) &&
      sameMembership(node.children.low.items, valid.low);
    if (unchanged) {
      advanceReview(model);
      return true;
    }
    node.children = createChildren(valid.high, valid.normal, valid.low);
    node.resolved = true;
    model.reviewing = false;
    model.reviewQueue = [];
    model.reviewIndex = 0;
    model.queue = [];
    model.current = null;
    [node.children.high, node.children.normal, node.children.low].forEach(function (child) {
      if (child.items.length > 0) {
        model.queue.push(child);
      }
    });
    prepareNext(model);
    return true;
  }

  /* Start a review pass over the saved group questions. Returns false when the
   * tree has no group question, for example when every selected group has four
   * activities or fewer. */
  function review(model) {
    if (!isDone(model)) {
      return false;
    }
    var queue = [model.root];
    var nodes = [];
    while (queue.length > 0) {
      var node = queue.shift();
      if (!node.children) {
        continue;
      }
      nodes.push(node);
      [node.children.high, node.children.normal, node.children.low].forEach(function (child) {
        if (child.items.length > 0) {
          queue.push(child);
        }
      });
    }
    if (nodes.length === 0) {
      return false;
    }
    model.reviewing = true;
    model.reviewQueue = nodes;
    model.reviewIndex = 0;
    model.current = nodes[0];
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
      type: model.current ? 'group' : null,
      bucket: model.current ? model.current.bucket : null,
      reviewing: model.reviewing,
      reviewIndex: model.reviewIndex
    };
  }

  root.AIExposureRank = {
    LEAF_SIZE: LEAF_SIZE,
    create: create,
    setItems: setItems,
    nextQuestion: nextQuestion,
    answerGroup: answerGroup,
    isDone: isDone,
    review: review,
    order: order,
    progress: progress
  };
})(typeof self !== 'undefined' ? self : globalThis);
