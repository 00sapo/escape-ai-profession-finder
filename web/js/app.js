/*
 * App shell: questionnaire state, suggestion loop, results view, CSV export.
 * No network. The dataset is already in memory from data/dataset.js.
 */
(function () {
  'use strict';

  var dataset = self.__AI_EXPOSURE_DATASET__;
  var model = self.AIExposureModel;
  var fuzzy = self.AIExposureFuzzy;
  var i18n = self.AIExposureI18n;
  if (!dataset || !model || !i18n) {
    return;
  }

  /* Derived from data/dist/validation_report.json. validation/check_tuning.js
   * fails when these numbers and the report disagree. */
  var TUNING = {
    maxSupport: 10,
    learningRate: 1,
    stopStability: 0.041
  };

  var index = model.buildIndex(dataset);
  var floor = dataset.meta.min_dwa_initial;
  var pageSize = 50;

  var state = {
    performed: new Set(),
    denied: new Set(),
    fit: null,
    screen: 'intro',
    shown: 0,
    origin: 'tree',
    infoDwa: -1,
    detailOccupation: -1,
    slide: 0,
    selectedOccupations: [],
    activityOrder: [],
    activityEnabled: new Map()
  };

  var elements = {};
  var occupationByCode = new Map();
  var gapMin = 0;
  var gapMax = 0;
  var gapBins = new Int32Array(100);
  var gapBinMax = 1;

  function id(name) {
    return document.getElementById(name);
  }

  function t(key, values) {
    return i18n.t(key, values);
  }

  function format(value) {
    return i18n.number(value, 2);
  }

  function percent(value) {
    return i18n.percent(value);
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function translationOf(map) {
    if (!map) {
      return null;
    }
    return map[i18n.get()] || null;
  }

  function occupationLabel(index) {
    var entry = dataset.occupations[index];
    return translationOf(entry.tr) || entry.t;
  }

  function activityLabel(dwaIndex) {
    var entry = dataset.dwas[dwaIndex];
    return translationOf(entry.tr) || entry.n;
  }

  function addSourceLine(node, english, localized) {
    if (english && english !== localized) {
      var source = element('span', 'translation-source', english);
      source.lang = 'en';
      node.appendChild(source);
    }
  }

  var SLIDE_VISUALS = [
    '<svg viewBox="0 0 120 64" width="120" height="64"><rect x="4" y="10" width="40" height="18" rx="4" fill="#0a4f9c"/><rect x="40" y="26" width="40" height="18" rx="4" fill="#4f7fb5"/><rect x="76" y="10" width="40" height="18" rx="4" fill="#0a4f9c"/><path d="M24 28 L60 44 L96 28" stroke="#4f5a68" fill="none" stroke-width="2"/><rect x="30" y="46" width="60" height="12" rx="4" fill="#e3edf9" stroke="#0a4f9c"/></svg>',
    '<svg viewBox="0 0 120 64" width="120" height="64"><rect x="10" y="8" width="100" height="10" rx="4" fill="#0a4f9c"/><rect x="10" y="24" width="82" height="10" rx="4" fill="#8aa9c9"/><rect x="10" y="40" width="64" height="10" rx="4" fill="#c8d0da"/><path d="M96 8 l0 -6 m0 0 l-4 4 m4 -4 l4 4" stroke="#12161c" fill="none" stroke-width="2"/></svg>',
    '<svg viewBox="0 0 120 64" width="120" height="64"><rect x="8" y="8" width="104" height="48" rx="5" fill="#ffffff" stroke="#4f5a68"/><path d="M20 42 L38 30 L54 36 L72 20 L92 26 L104 18" stroke="#0a4f9c" fill="none" stroke-width="2"/><circle cx="72" cy="20" r="3" fill="#0a4f9c"/></svg>',
    '<svg viewBox="0 0 120 64" width="120" height="64"><rect x="8" y="26" width="104" height="12" rx="6" fill="url(#g)"/><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#b3261e"/><stop offset="1" stop-color="#1a6b3c"/></linearGradient></defs><rect x="8" y="42" width="6" height="6" fill="#12161c"/><rect x="106" y="42" width="6" height="6" fill="#12161c"/></svg>'
  ];

  function renderSlide() {
    var index = state.slide;
    elements['slide-title'].textContent = t('slides.' + (index + 1) + '.title');
    elements['slide-text'].textContent = t('slides.' + (index + 1) + '.text', {
      min: i18n.number(gapMin, gapMin === Math.round(gapMin) ? 0 : 2),
      max: i18n.number(gapMax, 2)
    });
    elements['slide-visual'].innerHTML = SLIDE_VISUALS[index];
    var progress = t('slides.progress', { current: i18n.number(index + 1, 0), total: i18n.number(4, 0) });
    elements['slide-progress'].textContent = '';
    elements['slide-progress'].appendChild(document.createTextNode(progress + ' '));
    for (var dot = 0; dot < 4; dot += 1) {
      var marker = element('span', 'slide-dot' + (dot === index ? ' is-current' : ''), '•');
      marker.setAttribute('aria-hidden', 'true');
      elements['slide-progress'].appendChild(marker);
    }
    elements['slide-back'].disabled = index === 0;
    elements['slide-next'].textContent = index === 3 ? t('slides.finish') : t('slides.next');
  }

  function changeSlide(step) {
    state.slide = Math.max(0, Math.min(3, state.slide + step));
    renderSlide();
  }

  function openOccupations() {
    renderOccupationScreen();
    setScreen('occupations');
  }

  function prepare() {
    var i;
    for (i = 0; i < dataset.occupations.length; i += 1) {
      occupationByCode.set(dataset.occupations[i].c, i);
    }
    gapMin = Infinity;
    gapMax = -Infinity;
    for (i = 0; i < dataset.occupations.length; i += 1) {
      var gapValue = dataset.occupations[i].g;
      if (gapValue < gapMin) { gapMin = gapValue; }
      if (gapValue > gapMax) { gapMax = gapValue; }
    }
    if (gapMax <= gapMin) { gapMax = gapMin + 1; }
    gapBins = new Int32Array(100);
    gapBinMax = 1;
    for (i = 0; i < dataset.occupations.length; i += 1) {
      var bin = Math.min(99, Math.floor(((dataset.occupations[i].g - gapMin) / (gapMax - gapMin)) * 100));
      gapBins[bin] += 1;
      if (gapBins[bin] > gapBinMax) { gapBinMax = gapBins[bin]; }
    }
    gapMin = Infinity;
    gapMax = -Infinity;
    for (i = 0; i < dataset.occupations.length; i += 1) {
      var gapValue = dataset.occupations[i].g;
      if (gapValue < gapMin) { gapMin = gapValue; }
      if (gapValue > gapMax) { gapMax = gapValue; }
    }
    if (gapMax <= gapMin) { gapMax = gapMin + 1; }
    for (i = 0; i < dataset.occupations.length; i += 1) {
      var bin = Math.min(99, Math.floor(((dataset.occupations[i].g - gapMin) / (gapMax - gapMin)) * 100));
      gapBins[bin] += 1;
      if (gapBins[bin] > gapBinMax) { gapBinMax = gapBins[bin]; }
    }


    [
      'screen-intro',
      'screen-occupations',
      'screen-slides',
      'slide-panel',
      'slide-title',
      'slide-text',
      'slide-visual',
      'slide-progress',
      'slide-back',
      'slide-next',
      'slide-skip',
      'screen-activities',
      'screen-results',
      'start-occupations',
      'occupation-search',
      'occupation-count',
      'occupation-results',
      'selected-occupations',
      'occupations-continue',
      'activity-list',
      'activities-back',
      'activities-done',
      'results-back',
      'activity-info',
      'activity-info-area',
      'activity-info-group',
      'activity-info-activity',
      'activity-info-text',
      'activity-info-occupations',
      'activity-info-close',
      'occupation-detail',
      'occupation-detail-title',
      'occupation-detail-total',
      'domain-list',
      'occupation-detail-close',
      'score-value',
      'score-uncertainty',
      'gap-histogram',
      'histogram-bars',
      'histogram-axis-left',
      'histogram-axis-right',
      'histogram-label-left',
      'histogram-label-right',
      'histogram-left-occupation',
      'histogram-right-occupation',
      'histogram-caption',
      'representatives',
      'filter-exposure',
      'filter-exposure-value',
      'filter-similarity',
      'filter-similarity-value',
      'export',
      'restart',
      'ranking',
      'ranking-count',
      'more',
      'locale'
    ].forEach(function (name) {
      elements[name] = id(name);
    });
  }

  function staticValues() {
    return {
      occupations: i18n.number(dataset.meta.n_occupations, 0),
      floor: i18n.number(floor, 0)
    };
  }

  function applyStatic() {
    var values = staticValues();
    document.querySelectorAll('[data-i18n]').forEach(function (node) {
      var key = node.getAttribute('data-i18n');
      if (i18n.has(key)) {
        node.textContent = t(key, values);
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (node) {
      var key = node.getAttribute('data-i18n-placeholder');
      if (i18n.has(key)) {
        node.setAttribute('placeholder', t(key));
      }
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(function (node) {
      var key = node.getAttribute('data-i18n-aria-label');
      if (i18n.has(key)) {
        node.setAttribute('aria-label', t(key));
      }
    });
    if (i18n.has('app.title')) {
      document.title = t('app.title');
    }
    elements.locale.value = i18n.get();
    if (state.infoDwa >= 0 && elements['activity-info'] && elements['activity-info'].open) {
      fillInfo(state.infoDwa);
    }
    if (state.detailOccupation >= 0 && elements['occupation-detail'] && elements['occupation-detail'].open) {
      openOccupationDetail(state.detailOccupation);
    }
  }

  function setLocale(locale) {
    i18n.set(locale);
    try {
      window.history.replaceState(null, '', '#' + locale);
    } catch (error) {
      /* file:// or a sandbox may refuse the history call. The language still applies. */
    }
    applyStatic();
    refresh();
  }

  function refresh() {
    if (state.screen === 'occupations') {
      renderOccupationScreen();
    } else if (state.screen === 'activities') {
      renderActivityScreen();
    } else if (state.screen === 'results' && state.fit) {
      renderScore();
      renderRepresentatives(state.fit);
      renderRanking(true);
    }
  }

  function setScreen(name) {
    state.screen = name;
    ['intro', 'slides', 'occupations', 'activities', 'results'].forEach(function (screen) {
      var node = elements['screen-' + screen];
      if (node) {
        node.hidden = screen !== name;
      }
    });
    window.scrollTo(0, 0);
    var heading = document.querySelector('#screen-' + name + ' h2, #screen-' + name + ' h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }

  function parentText(dwaIndex) {
    var entry = dataset.dwas[dwaIndex];
    return dataset.gwas[entry.g] + ' · ' + dataset.iwas[entry.w];
  }

  var OCCUPATION_RESULT_LIMIT = 20;

  /* Occupations whose title matches, case insensitive. The list is capped but
   * the total is reported. */

  function isOccupationSelected(occupationIndex) {
    return state.selectedOccupations.indexOf(occupationIndex) >= 0;
  }

  /* The activity list is the union of the selected occupations. Activities that
   * were already present keep their priority order; new ones are appended. */
  function rebuildActivities() {
    var present = new Set();
    state.selectedOccupations.forEach(function (occupationIndex) {
      dataset.occupations[occupationIndex].dwa.forEach(function (dwaIndex) {
        present.add(dwaIndex);
      });
    });
    var kept = state.activityOrder.filter(function (dwaIndex) {
      return present.has(dwaIndex);
    });
    present.forEach(function (dwaIndex) {
      if (kept.indexOf(dwaIndex) < 0) {
        kept.push(dwaIndex);
      }
    });
    state.activityOrder = kept;
    present.forEach(function (dwaIndex) {
      if (!state.activityEnabled.has(dwaIndex)) {
        state.activityEnabled.set(dwaIndex, true);
      }
    });
    Array.from(state.activityEnabled.keys()).forEach(function (dwaIndex) {
      if (!present.has(dwaIndex)) {
        state.activityEnabled.delete(dwaIndex);
      }
    });
  }

  function occupationButton(occupationIndex) {
    var entry = dataset.occupations[occupationIndex];
    var selected = isOccupationSelected(occupationIndex);
    var button = element('button', 'button occupation-select', selected ? t('occupations.added') : t('occupations.add'));
    button.type = 'button';
    button.setAttribute('data-select-occupation', entry.c);
    button.disabled = selected;
    if (selected) {
      button.classList.add('is-selected');
    }
    button.appendChild(element('span', 'visually-hidden', ' ' + occupationLabel(occupationIndex) + ' ' + entry.t));
    return button;
  }

  function occupationRanking(query) {
    var english = dataset.occupations.map(function (entry) { return entry.t; });
    var localized = dataset.occupations.map(function (entry, index) { return occupationLabel(index); });
    if (!query) {
      return {
        rows: localized
          .map(function (title, index) { return { index: index, score: 0, label: title, title: english[index] }; })
          .sort(function (a, b) {
            if (a.label !== b.label) { return a.label < b.label ? -1 : 1; }
            return a.index - b.index;
          })
          .slice(0, OCCUPATION_RESULT_LIMIT),
        total: localized.length
      };
    }
    var best = new Map();
    [english, localized].forEach(function (titles) {
      fuzzy.search(query, titles, titles.length).forEach(function (hit) {
        best.set(hit.index, Math.max(best.get(hit.index) || 0, hit.score));
      });
    });
    var ranked = Array.from(best, function (pair) {
      return { index: pair[0], score: pair[1], label: localized[pair[0]], title: english[pair[0]] };
    });
    ranked.sort(function (a, b) {
      if (b.score !== a.score) { return b.score - a.score; }
      if (a.label !== b.label) { return a.label < b.label ? -1 : 1; }
      return a.index - b.index;
    });
    return { rows: ranked.slice(0, OCCUPATION_RESULT_LIMIT), total: ranked.length };
  }

  function renderOccupationSearch() {
    var query = elements['occupation-search'].value.trim();
    var ranking = occupationRanking(query);
    var ranked = ranking.rows;
    var result = { hits: ranked.map(function (hit) { return hit.index; }), scores: new Map(ranked.map(function (hit) { return [hit.index, hit.score]; })), total: ranking.total };
    var list = elements['occupation-results'];
    list.textContent = '';
    elements['occupation-count'].textContent = t('occupations.count', {
      total: i18n.number(result.total, 0),
      shown: i18n.number(result.hits.length, 0)
    });
    result.hits.forEach(function (occupationIndex) {
      var entry = dataset.occupations[occupationIndex];
      var item = document.createElement('li');
      item.className = 'occupation-item';
      item.setAttribute('data-occupation', entry.c);
      var titleNode = element('span', 'occupation-title', occupationLabel(occupationIndex));
      addSourceLine(titleNode, entry.t, occupationLabel(occupationIndex));
      item.appendChild(titleNode);
      if (query && result.scores) {
        item.appendChild(element('span', 'occupation-score', i18n.number(result.scores.get(occupationIndex) || 0, 1)));
      }
      item.appendChild(occupationButton(occupationIndex));
      list.appendChild(item);
    });
  }

  function renderSelectedOccupations() {
    var list = elements['selected-occupations'];
    list.textContent = '';
    if (state.selectedOccupations.length === 0) {
      list.appendChild(element('li', 'hint', t('occupations.empty')));
      return;
    }
    state.selectedOccupations.forEach(function (occupationIndex) {
      var entry = dataset.occupations[occupationIndex];
      var item = document.createElement('li');
      item.className = 'selected-occupation';
      item.setAttribute('data-occupation', entry.c);
      var titleNode = element('span', 'occupation-title', occupationLabel(occupationIndex));
      addSourceLine(titleNode, entry.t, occupationLabel(occupationIndex));
      item.appendChild(titleNode);
      var button = element('button', 'button occupation-remove', t('occupations.remove'));
      button.type = 'button';
      button.setAttribute('data-remove-occupation', entry.c);
      button.appendChild(element('span', 'visually-hidden', ' ' + occupationLabel(occupationIndex) + ' ' + entry.t));
      item.appendChild(button);
      list.appendChild(item);
    });
  }

  function updateOccupationsContinue() {
    elements['occupations-continue'].disabled = state.selectedOccupations.length === 0;
  }

  function renderOccupationScreen() {
    renderOccupationSearch();
    renderSelectedOccupations();
    updateOccupationsContinue();
  }

  function addOccupation(occupationIndex) {
    if (isOccupationSelected(occupationIndex)) {
      return;
    }
    state.selectedOccupations.push(occupationIndex);
    rebuildActivities();
    renderOccupationScreen();
  }

  function removeOccupation(occupationIndex) {
    var at = state.selectedOccupations.indexOf(occupationIndex);
    if (at < 0) {
      return;
    }
    state.selectedOccupations.splice(at, 1);
    rebuildActivities();
    renderOccupationScreen();
  }

  /* --- Occupation flow: ordered union of activities -------------------- */

  function activityCheckbox(dwaIndex) {
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'activity-' + dwaIndex;
    checkbox.setAttribute('data-enabled', '');
    checkbox.checked = state.activityEnabled.get(dwaIndex) !== false;
    checkbox.addEventListener('change', function () {
      state.activityEnabled.set(dwaIndex, checkbox.checked);
      updateActivitiesDone();
    });
    return checkbox;
  }

  function renderActivityScreen() {
    var list = elements['activity-list'];
    list.textContent = '';
    state.activityOrder.forEach(function (dwaIndex, position) {
      var row = document.createElement('li');
      row.className = 'activity-item';
      row.setAttribute('data-dwa', String(dwaIndex));
      row.setAttribute('draggable', 'true');
      row.appendChild(rankInput(position, state.activityOrder.length));
      var checkbox = activityCheckbox(dwaIndex);
      var label = document.createElement('label');
      label.className = 'activity-label';
      label.htmlFor = checkbox.id;
      var activityNode = element('span', 'activity-name', activityLabel(dwaIndex));
      addSourceLine(activityNode, dataset.dwas[dwaIndex].n, activityLabel(dwaIndex));
      label.appendChild(activityNode);
      label.appendChild(element('span', 'dwa-parent', parentText(dwaIndex)));
      var moves = element('div', 'activity-moves');
      moves.appendChild(moveButton('up', t('activity.moveUp'), position === 0));
      moves.appendChild(moveButton('down', t('activity.moveDown'), position === state.activityOrder.length - 1));
      var info = element('button', 'info-button', 'i');
      info.type = 'button';
      info.setAttribute('data-info', String(dwaIndex));
      info.appendChild(element('span', 'visually-hidden', ' ' + t('info.openFor', { activity: activityLabel(dwaIndex) })));
      row.appendChild(checkbox);
      row.appendChild(label);
      row.appendChild(moves);
      row.appendChild(info);
      list.appendChild(row);
    });
    updateActivitiesDone();
  }

  function updateActivitiesDone() {
    elements['activities-done'].disabled = !state.activityOrder.some(function (dwaIndex) {
      return state.activityEnabled.get(dwaIndex) !== false;
    });
  }

  function updateActivityMoveButtons() {
    var rows = elements['activity-list'].querySelectorAll('li[data-dwa]');
    rows.forEach(function (row, position) {
      row.querySelector('button[data-move="up"]').disabled = position === 0;
      row.querySelector('button[data-move="down"]').disabled = position === rows.length - 1;
    });
  }

  function moveActivityRow(dwaIndex, direction) {
    var list = elements['activity-list'];
    var rows = Array.prototype.slice.call(list.querySelectorAll('li[data-dwa]'));
    var position = -1;
    for (var i = 0; i < rows.length; i += 1) {
      if (Number(rows[i].getAttribute('data-dwa')) === dwaIndex) {
        position = i;
        break;
      }
    }
    if (position < 0) {
      return;
    }
    var target = position + direction;
    if (target < 0 || target >= rows.length) {
      return;
    }
    if (direction < 0) {
      list.insertBefore(rows[position], rows[target]);
    } else {
      list.insertBefore(rows[target], rows[position]);
    }
    updateActivityMoveButtons();
    state.activityOrder = Array.prototype.map.call(
      list.querySelectorAll('li[data-dwa]'),
      function (row) {
        return Number(row.getAttribute('data-dwa'));
      }
    );
    var moved = list.querySelector('li[data-dwa="' + dwaIndex + '"]');
    var wanted = direction < 0 ? 'up' : 'down';
    var focusButton = moved.querySelector('button[data-move="' + wanted + '"]');
    if (focusButton.disabled) {
      focusButton = moved.querySelector('button[data-move="' + (wanted === 'up' ? 'down' : 'up') + '"]');
    }
    if (focusButton && !focusButton.disabled) {
      focusButton.focus();
    } else {
      moved.querySelector('input[data-enabled]').focus();
    }
  }

  /* The ordered union is the evidence: enabled activities are performed,
   * disabled ones are denied. Priority is the list order; frequency stays out
   * of this path, so the order alone carries the priority. */
  function showOccupationResults() {
    var performed = [];
    var denied = [];
    state.activityOrder.forEach(function (dwaIndex) {
      if (state.activityEnabled.get(dwaIndex) === false) {
        denied.push(dwaIndex);
      } else {
        performed.push(dwaIndex);
      }
    });
    var evidence = {
      performed: Int32Array.from(performed),
      denied: Int32Array.from(denied),
      priority: Int32Array.from(state.activityOrder)
    };
    state.performed = new Set(performed);
    state.denied = new Set(denied);
    state.origin = 'occupations';
    var fit = model.fitBlendWeighted(index, evidence, TUNING);
    fit.uncertainty = model.bootstrapUncertainty(index, evidence).std;
    state.fit = fit;
    state.stableRounds = 0;
    renderScore();
    renderRepresentatives(fit);
    state.shown = 0;
    renderRanking(true);
    setScreen('results');
  }

  /* --- Principal activity and disambiguation questionnaire ------------- */

  function rankInput(position, total) {
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'rank-input';
    input.min = '1';
    input.max = String(total);
    input.step = '1';
    input.value = String(position + 1);
    input.setAttribute('data-rank', '');
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('aria-label', t('row.rank'));
    return input;
  }

  function listRows(list) {
    return Array.prototype.slice.call(list.querySelectorAll('li[data-dwa]'));
  }

  function syncListOrder(list) {
    state.activityOrder = listRows(list).map(function (row) {
      return Number(row.getAttribute('data-dwa'));
    });
  }

  function renumberList(list) {
    listRows(list).forEach(function (row, position) {
      var input = row.querySelector('input[data-rank]');
      if (input) {
        input.value = String(position + 1);
        input.max = String(listRows(list).length);
      }
    });
  }

  function refreshMoveButtonsFor() {
    updateActivityMoveButtons();
  }

  /* Move one row to a 1-based position. The row keeps its inputs, so the
   * frequency and the enabled flag stay with the activity. */
  function moveRowTo(list, dwaIndex, targetIndex) {
    var rows = listRows(list);
    var position = -1;
    for (var i = 0; i < rows.length; i += 1) {
      if (Number(rows[i].getAttribute('data-dwa')) === dwaIndex) {
        position = i;
        break;
      }
    }
    if (position < 0) {
      return;
    }
    targetIndex = Math.max(0, Math.min(rows.length - 1, targetIndex));
    if (targetIndex === position) {
      renumberList(list);
      return;
    }
    var row = rows[position];
    if (targetIndex < position) {
      list.insertBefore(row, rows[targetIndex]);
    } else {
      list.insertBefore(row, rows[targetIndex].nextSibling);
    }
    syncListOrder(list);
    renumberList(list);
    refreshMoveButtonsFor();
    var rank = row.querySelector('input[data-rank]');
    if (rank) {
      rank.focus();
      rank.select();
    }
  }

  function commitRank(list, input) {
    var row = input.closest('li[data-dwa]');
    var rows = listRows(list);
    var position = rows.indexOf(row);
    var value = parseInt(input.value, 10);
    if (!row || position < 0 || !isFinite(value) || value < 1 || value > rows.length) {
      input.value = String(position + 1);
      return;
    }
    moveRowTo(list, Number(row.getAttribute('data-dwa')), value - 1);
  }

  function wireDrag(list) {
    var dragged = null;
    list.addEventListener('dragstart', function (event) {
      var row = event.target.closest ? event.target.closest('li[data-dwa]') : null;
      if (!row) {
        return;
      }
      dragged = row;
      row.setAttribute('data-dragging', 'true');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        try {
          event.dataTransfer.setData('text/plain', row.getAttribute('data-dwa'));
        } catch (error) {
          /* some browsers refuse the write during a synthetic drag */
        }
      }
    });
    list.addEventListener('dragend', function () {
      if (dragged) {
        dragged.removeAttribute('data-dragging');
      }
      dragged = null;
    });
    list.addEventListener('dragover', function (event) {
      if (dragged) {
        event.preventDefault();
      }
    });
    list.addEventListener('drop', function (event) {
      if (!dragged) {
        return;
      }
      event.preventDefault();
      var target = event.target.closest ? event.target.closest('li[data-dwa]') : null;
      if (!target) {
        return;
      }
      var rows = listRows(list);
      moveRowTo(list, Number(dragged.getAttribute('data-dwa')), rows.indexOf(target));
    });
  }

  function moveButton(direction, label, disabled) {
    var button = element('button', 'move-button', direction === 'up' ? '↑' : '↓');
    button.type = 'button';
    button.setAttribute('data-move', direction);
    button.disabled = disabled;
    button.appendChild(element('span', 'visually-hidden', ' ' + label));
    return button;
  }



  function openInfo(dwaIndex) {
    var entry = dataset.dwas[dwaIndex];
    if (!entry) {
      return;
    }
    state.infoDwa = dwaIndex;
    fillInfo(dwaIndex);
    var panel = elements['activity-info'];
    if (!panel.open) {
      if (typeof panel.showModal === 'function') {
        panel.showModal();
      } else {
        panel.setAttribute('open', '');
      }
    }
    elements['activity-info-close'].focus();
  }

  function fillInfo(dwaIndex) {
    var entry = dataset.dwas[dwaIndex];
    elements['activity-info-area'].textContent = dataset.gwas[entry.g];
    elements['activity-info-group'].textContent = dataset.iwas[entry.w];
    elements['activity-info-activity'].textContent = activityLabel(dwaIndex) + (activityLabel(dwaIndex) === entry.n ? '' : ' (' + entry.n + ')');
    elements['activity-info-text'].textContent = t('info.noDescription');
    renderInfoOccupations(dwaIndex);
  }

  /* Occupations that contain the activity, most exposed first (the OECD gap
   * runs the other way), then by title. At most 20 rows, with the total. */
  var INFO_OCCUPATION_LIMIT = 20;

  function renderInfoOccupations(dwaIndex) {
    var container = elements['activity-info-occupations'];
    container.textContent = '';
    var occupations = index.dwaOcc[dwaIndex];
    container.appendChild(
      element('p', 'info-total', t('info.total', { count: i18n.number(occupations.length, 0) }))
    );
    var order = occupations.slice().sort(function (a, b) {
      var gapA = dataset.occupations[a].g;
      var gapB = dataset.occupations[b].g;
      if (gapA !== gapB) {
        return gapA - gapB;
      }
      var titleA = dataset.occupations[a].t;
      var titleB = dataset.occupations[b].t;
      if (titleA !== titleB) {
        return titleA < titleB ? -1 : 1;
      }
      return a - b;
    });
    var list = document.createElement('ul');
    list.className = 'info-occupation-list';
    order.slice(0, INFO_OCCUPATION_LIMIT).forEach(function (occupation) {
      var item = document.createElement('li');
      item.className = 'info-occupation';
      item.appendChild(element('span', 'info-occupation-title', occupationLabel(occupation)));
      item.appendChild(
        element('span', 'info-occupation-gap', t('row.gap', { value: format(dataset.occupations[occupation].g) }))
      );
      list.appendChild(item);
    });
    container.appendChild(list);
  }

  function openOccupationDetail(occupationIndex) {
    var entry = dataset.occupations[occupationIndex];
    if (!entry) {
      return;
    }
    state.detailOccupation = occupationIndex;
    elements['occupation-detail-title'].textContent = occupationLabel(occupationIndex);
    elements['occupation-detail-total'].textContent = t('domain.total', { gap: format(entry.g) });
    var list = elements['domain-list'];
    list.textContent = '';
    dataset.domains.forEach(function (key, position) {
      var gap = entry.dg[position];
      var level = dataset.aiCapability[position];
      var row = document.createElement('li');
      row.className = 'domain-row';
      row.setAttribute('data-domain', key);
      row.appendChild(element('span', 'domain-name', t('domain.' + key + '.name')));
      row.appendChild(
        element(
          'span',
          'domain-metrics',
          t('domain.level', { value: format(level) }) + ' · ' + t('domain.gap', { value: format(gap) })
        )
      );
      var track = element('span', 'domain-bar-track');
      var bar = element('span', 'domain-bar');
      bar.style.width = Math.max(0, Math.min(100, Math.round((gap / 5) * 100))) + '%';
      track.appendChild(bar);
      row.appendChild(track);
      row.appendChild(element('span', 'domain-desc', t('domain.' + key + '.desc')));
      list.appendChild(row);
    });
    var dialog = elements['occupation-detail'];
    if (!dialog.open) {
      dialog.showModal();
    }
    elements['occupation-detail-close'].focus();
  }

  function closeOccupationDetail() {
    var dialog = elements['occupation-detail'];
    if (dialog.open) {
      dialog.close();
    }
    state.detailOccupation = -1;
  }

  function closeInfo() {
    var panel = elements['activity-info'];
    if (typeof panel.close === 'function') {
      panel.close();
    } else {
      panel.removeAttribute('open');
    }
    state.infoDwa = -1;
  }

  function binOfGap(gapValue) {
    return Math.max(0, Math.min(99, Math.floor(((gapValue - gapMin) / (gapMax - gapMin)) * 100)));
  }

  /* Distribution of all occupations over 100 equal gap bins, with the bin that
   * contains the user's estimated gap marked. */
  function histogramEdgeTitle(startBin, direction) {
    var bins = gapBins;
    var bin = startBin;
    while (bin >= 0 && bin < 100 && bins[bin] === 0) {
      bin += direction;
    }
    if (bin < 0 || bin > 99) {
      return '';
    }
    var best = '';
    var bestIndex = -1;
    for (var i = 0; i < dataset.occupations.length; i += 1) {
      if (binOfGap(dataset.occupations[i].g) !== bin) {
        continue;
      }
      var title = dataset.occupations[i].t;
      if (best === '' || title < best) {
        best = title;
        bestIndex = i;
      }
    }
    return bestIndex >= 0 ? occupationLabel(bestIndex) : best;
  }

  function renderHistogram(fit) {
    var container = elements['histogram-bars'];
    container.textContent = '';
    var current = binOfGap(fit.gap);
    for (var i = 0; i < 100; i += 1) {
      var bar = document.createElement('span');
      bar.className = 'histogram-bin';
      bar.setAttribute('data-bin', String(i));
      if (i === current) {
        bar.setAttribute('data-current', 'true');
      }
      bar.style.height = Math.max(2, Math.round((gapBins[i] / gapBinMax) * 100)) + '%';
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', t('results.histogramBin', {
        from: format(gapMin + ((gapMax - gapMin) * i) / 100),
        to: format(gapMin + ((gapMax - gapMin) * (i + 1)) / 100),
        count: i18n.number(gapBins[i], 0)
      }));
      container.appendChild(bar);
    }
    elements['histogram-caption'].textContent = t('results.histogramCurrent', {
      bin: i18n.number(current + 1, 0)
    });
    elements['histogram-axis-left'].textContent = format(gapMin);
    elements['histogram-axis-right'].textContent = format(gapMax);
    elements['histogram-left-occupation'].textContent = histogramEdgeTitle(0, 1);
    elements['histogram-right-occupation'].textContent = histogramEdgeTitle(99, -1);
  }

  function renderScore() {
    var fit = state.fit;
    elements['score-value'].textContent = format(fit.gap);
    renderHistogram(fit);
    elements['score-uncertainty'].textContent = t('results.uncertainty', {
      std: format(fit.uncertainty || 0),
      resamples: i18n.number(24, 0),
      support: i18n.number(fit.support.length, 0)
    });
  }

  /* Declared activities in the user's priority order, with the frequency kept
   * as the magnitude of the evidence. */

  function renderRepresentatives(fit) {
    var list = elements.representatives;
    list.textContent = '';
    var maxWeight = 0;
    fit.support.forEach(function (occupation, position) {
      if (fit.weights[position] > maxWeight) {
        maxWeight = fit.weights[position];
      }
    });
    fit.support.forEach(function (occupation, position) {
      var weight = fit.weights[position];
      var item = document.createElement('li');
      var repTitle = element('p', 'rank-title', occupationLabel(occupation));
      repTitle.title = dataset.occupations[occupation].t;
      item.appendChild(repTitle);
      item.appendChild(
        element(
          'p',
          'metric',
          t('row.weight', { value: percent(weight) }) +
            ' · ' +
            t('row.gap', { value: format(dataset.occupations[occupation].g) }) +
            ' · ' +
            t('row.similarity', { value: percent(fit.similarity[occupation]) })
        )
      );
      var track = element('div', 'bar-track');
      var bar = element('div', 'bar');
      bar.style.width = Math.max(4, Math.round((weight / maxWeight) * 100)) + '%';
      track.appendChild(bar);
      item.appendChild(track);
      list.appendChild(item);
    });
  }

  function filteredOrder() {
    var minGap = Number(elements['filter-exposure'].value);
    var minSimilarity = Number(elements['filter-similarity'].value);
    var order = state.fit.ranking.order;
    var kept = [];
    for (var i = 0; i < order.length; i += 1) {
      var occupation = order[i];
      if (dataset.occupations[occupation].g < minGap) {
        continue;
      }
      if (state.fit.similarity[occupation] < minSimilarity) {
        continue;
      }
      kept.push(occupation);
    }
    return kept;
  }

  function renderRanking(reset) {
    var order = filteredOrder();
    if (reset) {
      elements.ranking.textContent = '';
      state.shown = 0;
    }
    var limit = Math.min(order.length, state.shown + pageSize);
    for (var i = state.shown; i < limit; i += 1) {
      elements.ranking.appendChild(renderRow(order[i], i + 1));
    }
    state.shown = limit;
    elements.more.hidden = limit >= order.length;
    elements['ranking-count'].textContent = t('results.count', {
      total: i18n.number(order.length, 0),
      shown: i18n.number(limit, 0)
    });
  }

  function gapBand(gapValue) {
    var span = gapMax - gapMin || 1;
    return Math.max(0, Math.min(100, Math.round(((gapValue - gapMin) / span) * 100)));
  }

  function renderRow(occupation, position) {
    var entry = dataset.occupations[occupation];
    var fit = state.fit;
    var item = document.createElement('li');
    var details = document.createElement('details');
    details.className = 'ranking-card';
    details.setAttribute('data-occupation', String(occupation));
    details.setAttribute('tabindex', '0');
    details.setAttribute('aria-haspopup', 'dialog');
    var band = gapBand(entry.g);
    var hue = Math.round((band / 100) * 120);
    details.setAttribute('data-gap-band', String(band));
    details.style.borderLeft = '8px solid hsl(' + hue + ', 70%, 42%)';
    details.style.backgroundColor = 'hsl(' + hue + ', 70%, 94%)';
    var summary = document.createElement('summary');

    var summaryTitle = element('span', 'rank-title', position + '. ' + occupationLabel(occupation));
    summaryTitle.title = entry.t;
    summary.appendChild(summaryTitle);
    summary.appendChild(element('span', 'metric', t('row.similarity', { value: percent(fit.similarity[occupation]) })));
    summary.appendChild(element('span', 'metric', t('row.gap', { value: format(entry.g) })));
    summary.appendChild(
      element(
        'span',
        'metric',
        t('row.shared', {
          shared: i18n.number(fit.shared[occupation], 0),
          total: i18n.number(entry.dwa.length, 0)
        })
      )
    );

    details.appendChild(summary);
    var detail = element('div', 'detail');
    details.appendChild(detail);
    var filled = false;
    details.addEventListener('toggle', function () {
      if (!details.open || filled) {
        return;
      }
      filled = true;
      fillDetail(detail, occupation);
    });
    item.appendChild(details);
    return item;
  }

  function fillDetail(container, occupation) {
    var entry = dataset.occupations[occupation];
    var shared = [];
    var extra = [];
    entry.dwa.forEach(function (dwaIndex) {
      if (state.performed.has(dwaIndex)) {
        shared.push(activityLabel(dwaIndex) + (activityLabel(dwaIndex) === dataset.dwas[dwaIndex].n ? '' : ' (' + dataset.dwas[dwaIndex].n + ')'));
      } else {
        extra.push(activityLabel(dwaIndex) + (activityLabel(dwaIndex) === dataset.dwas[dwaIndex].n ? '' : ' (' + dataset.dwas[dwaIndex].n + ')'));
      }
    });

    container.appendChild(element('h4', null, t('detail.shared')));
    if (shared.length === 0) {
      container.appendChild(element('p', 'hint', t('detail.sharedEmpty')));
    } else {
      var sharedList = document.createElement('ul');
      shared.forEach(function (name) {
        sharedList.appendChild(element('li', null, name));
      });
      container.appendChild(sharedList);
    }

    container.appendChild(element('h4', null, t('detail.extra')));
    var extraList = document.createElement('ul');
    extra.slice(0, 12).forEach(function (name) {
      extraList.appendChild(element('li', null, name));
    });
    container.appendChild(extraList);
    if (extra.length > 12) {
      container.appendChild(element('p', 'hint', t('detail.more', { count: i18n.number(extra.length - 12, 0) })));
    }
    if (entry.d) {
      container.appendChild(element('h4', null, t('detail.description')));
      container.appendChild(element('p', 'hint', entry.d));
    }
  }

  function csvEscape(value) {
    var text = String(value);
    if (text.indexOf('"') >= 0 || text.indexOf(';') >= 0 || text.indexOf('\n') >= 0) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function exportCsv() {
    var order = filteredOrder();
    var rows = [
      ['code', 'title', 'similarity', 'shared_dwas', 'occupation_dwas', 'gap_index', 'exposure', 'blend_weight']
    ];
    var weightOf = new Map();
    state.fit.support.forEach(function (occupation, position) {
      weightOf.set(occupation, state.fit.weights[position]);
    });
    order.forEach(function (occupation) {
      var entry = dataset.occupations[occupation];
      rows.push([
        entry.c,
        occupationLabel(occupation),
        state.fit.similarity[occupation].toFixed(4),
        state.fit.shared[occupation],
        entry.dwa.length,
        entry.g,
        entry.e,
        (weightOf.get(occupation) || 0).toFixed(4)
      ]);
    });
    var text = rows
      .map(function (row) {
        return row.map(csvEscape).join(';');
      })
      .join('\n');
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'ai-exposure.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }

  function restart() {
    state.performed.clear();
    state.denied.clear();
    state.fit = null;
    state.stableRounds = 0;
    state.shown = 0;
    state.origin = 'tree';
    if (elements['activity-info'].open) {
      closeInfo();
    }
    if (elements['occupation-detail'].open) {
      closeOccupationDetail();
    }
    state.infoDwa = -1;
    state.selectedOccupations = [];
    state.activityOrder = [];
    state.activityEnabled = new Map();
    elements['occupation-search'].value = '';
    elements['occupation-results'].textContent = '';
    elements['selected-occupations'].textContent = '';
    elements['activity-list'].textContent = '';
    elements.ranking.textContent = '';
    elements.representatives.textContent = '';
    renderOccupationScreen();
    setScreen('occupations');
  }

  function wire() {
    elements['start-occupations'].addEventListener('click', function () {
      state.slide = 0;
      renderSlide();
      setScreen('slides');
    });
    elements['slide-back'].addEventListener('click', function () {
      changeSlide(-1);
    });
    elements['slide-next'].addEventListener('click', function () {
      if (state.slide === 3) {
        openOccupations();
      } else {
        changeSlide(1);
      }
    });
    elements['slide-skip'].addEventListener('click', openOccupations);
    document.addEventListener('keydown', function (event) {
      if (state.screen !== 'slides') {
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        changeSlide(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        changeSlide(-1);
      }
    });
    elements['results-back'].addEventListener('click', function () {
      if (state.origin === 'occupations') {
        renderActivityScreen();
        setScreen('activities');
        return;
      }
      renderOccupationScreen();
      setScreen('occupations');
    });
    elements['activity-info-close'].addEventListener('click', closeInfo);
    elements['activity-info'].addEventListener('close', function () {
      state.infoDwa = -1;
    });
    elements['occupation-results'].addEventListener('click', function (event) {
      var target = event.target;
      if (!target.closest) {
        return;
      }
      var button = target.closest('[data-select-occupation]');
      if (!button || button.disabled) {
        return;
      }
      var occupationIndex = occupationByCode.get(button.getAttribute('data-select-occupation'));
      if (occupationIndex !== undefined) {
        addOccupation(occupationIndex);
      }
    });
    elements['selected-occupations'].addEventListener('click', function (event) {
      var target = event.target;
      if (!target.closest) {
        return;
      }
      var button = target.closest('[data-remove-occupation]');
      if (!button) {
        return;
      }
      var occupationIndex = occupationByCode.get(button.getAttribute('data-remove-occupation'));
      if (occupationIndex !== undefined) {
        removeOccupation(occupationIndex);
      }
    });
    elements['occupation-search'].addEventListener('input', renderOccupationSearch);
    elements['occupations-continue'].addEventListener('click', function () {
      renderActivityScreen();
      setScreen('activities');
    });

    elements['activity-list'].addEventListener('click', function (event) {
      var target = event.target;
      if (!target.closest) {
        return;
      }
      var infoButton = target.closest('[data-info]');
      if (infoButton) {
        openInfo(Number(infoButton.getAttribute('data-info')));
        return;
      }
      var move = target.closest('[data-move]');
      if (!move || move.disabled) {
        return;
      }
      var row = move.closest('li[data-dwa]');
      if (!row) {
        return;
      }
      moveActivityRow(Number(row.getAttribute('data-dwa')), move.getAttribute('data-move') === 'up' ? -1 : 1);
    });
    elements['activity-list'].addEventListener('change', function (event) {
      var input = event.target.closest ? event.target.closest('input[data-rank]') : null;
      if (input) {
        commitRank(elements['activity-list'], input);
      }
    });
    wireDrag(elements['activity-list']);
    elements['activities-back'].addEventListener('click', function () {
      renderOccupationScreen();
      setScreen('occupations');
    });
    elements['activities-done'].addEventListener('click', showOccupationResults);



    elements['filter-exposure'].addEventListener('input', function () {
      elements['filter-exposure-value'].textContent = format(Number(elements['filter-exposure'].value));
      renderRanking(true);
    });
    elements['filter-similarity'].addEventListener('input', function () {
      elements['filter-similarity-value'].textContent = percent(Number(elements['filter-similarity'].value));
      renderRanking(true);
    });
    elements.export.addEventListener('click', exportCsv);
    elements.restart.addEventListener('click', restart);
    elements.more.addEventListener('click', function () {
      renderRanking(false);
    });
    elements.ranking.addEventListener('click', function (event) {
      var summary = event.target.closest ? event.target.closest('summary') : null;
      if (!summary) {
        return;
      }
      var card = summary.closest('details.ranking-card');
      if (!card) {
        return;
      }
      event.preventDefault();
      openOccupationDetail(Number(card.getAttribute('data-occupation')));
    });
    elements.ranking.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      var card = event.target.closest ? event.target.closest('details.ranking-card') : null;
      if (!card) {
        return;
      }
      event.preventDefault();
      openOccupationDetail(Number(card.getAttribute('data-occupation')));
    });
    elements['occupation-detail-close'].addEventListener('click', closeOccupationDetail);
    elements['occupation-detail'].addEventListener('close', function () {
      state.detailOccupation = -1;
    });
    elements.locale.addEventListener('change', function () {
      setLocale(elements.locale.value);
    });
  }

  function boot() {
    i18n.set(i18n.fromHash() || i18n.detect());
    prepare();
    applyStatic();
    wire();
    elements['filter-exposure-value'].textContent = format(0);
    elements['filter-similarity-value'].textContent = percent(0);
  }

  boot();
  self.__AI_EXPOSURE_APP__ = {
    state: state,
    index: index,
    setLocale: setLocale,
  };
})();
