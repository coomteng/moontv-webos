/* browse.js — category pages (电影 / 剧集 / 动漫 / 综艺): filter chips + 7-column poster grid (ES5 only). */
(function () {
  'use strict';

  var COLS = 7;
  var PAGE = 24;
  var TITLES = { movie: '电影', tv: '剧集', anime: '动漫', show: '综艺' };

  var filters = null;          /* from /filters */
  var state = {};              /* per type: { tag, region, items, start, done, zoneIndex } */
  var type = 'movie';
  var chipRows = [];           /* [{ kind:'cats'|'regions', el, chips:[el] }] */
  var gridZone = null;
  var loadingMore = false;
  var reqSeq = 0;

  function st() {
    if (!state[type]) state[type] = { tag: '', region: '', items: [], start: 0, done: false, index: 0 };
    return state[type];
  }

  function gridEl() { return UI.$('browse-grid'); }
  function scrollEl() { return UI.$('browse-scroll'); }

  /* ---- filter chips ---- */
  function buildChips() {
    var wrap = UI.$('browse-filters');
    UI.empty(wrap);
    chipRows = [];
    var f = (filters && filters[type]) || { cats: [], regions: [] };
    var s = st();
    if (!s.tag && f.cats && f.cats.length) s.tag = f.cats[0];
    if (!s.region && f.regions && f.regions.length) s.region = f.regions[0];
    /* row labels follow MoonTV's web UI: movie 分类/地区, tv 分类/类型, show 分类/地区, anime 分类 */
    addChipRow('cats', '分类', f.cats || [], s.tag);
    if (f.regions && f.regions.length) addChipRow('regions', type === 'tv' ? '类型' : '地区', f.regions, s.region);
    UI.toggleClass(UI.$('browse-head'), 'no-filters', chipRows.length === 0 || (chipRows.length === 1 && chipRows[0].chips.length <= 1));
    /* grid starts right under the filter block (its height depends on the number of chip rows) */
    var head = UI.$('browse-head');
    scrollEl().style.top = (head.offsetTop + head.offsetHeight + 10) + 'px';
  }

  function addChipRow(kind, label, values, current) {
    var row = UI.el('div', 'filter-row');
    row.appendChild(UI.text('div', 'filter-label', label));
    var chips = UI.el('div', 'chips');
    var els = [];
    for (var i = 0; i < values.length; i++) {
      var c = UI.text('div', 'chip', values[i]);
      c.setAttribute('data-value', values[i]);
      if (values[i] === current) UI.addClass(c, 'current');
      chips.appendChild(c);
      els.push(c);
    }
    row.appendChild(chips);
    UI.$('browse-filters').appendChild(row);
    chipRows.push({ kind: kind, el: row, chips: els });
  }

  function chipZone(rowDef) {
    var idx = 0;
    for (var i = 0; i < rowDef.chips.length; i++) if (UI.hasClass(rowDef.chips[i], 'current')) idx = i;
    return {
      name: 'chips-' + rowDef.kind,
      cols: 0,
      remember: true,
      index: idx,
      getItems: function () { return rowDef.chips; },
      onFocus: function () { UI.translate(gridEl(), 0, 0); },
      onEnter: function (el) {
        var v = el.getAttribute('data-value');
        var s = st();
        if (rowDef.kind === 'cats') s.tag = v; else s.region = v;
        for (var k = 0; k < rowDef.chips.length; k++) UI.toggleClass(rowDef.chips[k], 'current', rowDef.chips[k] === el);
        reload('chips-' + rowDef.kind);
      }
    };
  }

  /* ---- grid ---- */
  function cardsInGrid() { return UI.toArray(gridEl().children); }

  function renderGrid(append) {
    var g = gridEl();
    var s = st();
    if (!append) { UI.empty(g); UI.translate(g, 0, 0); }
    var from = append ? g.children.length : 0;
    for (var i = from; i < s.items.length; i++) g.appendChild(Cards.douban(s.items[i]));
    UI.$('browse-empty').textContent = s.items.length ? '' : (s.done ? '没有内容' : '');
  }

  function buildZones(startAtGrid) {
    var zones = [];
    for (var i = 0; i < chipRows.length; i++) if (chipRows[i].chips.length > 1) zones.push(chipZone(chipRows[i]));
    gridZone = {
      name: 'grid',
      cols: COLS,
      remember: true,
      index: st().index || 0,
      getItems: cardsInGrid,
      onFocus: function (el, i) {
        st().index = i;
        var viewH = scrollEl().clientHeight;
        Nav.scrollY(gridEl(), el, viewH, 20, 20);
        /* prefetch the next page when the user is on the last two rows */
        var n = cardsInGrid().length;
        if (i >= n - COLS * 2) loadMore();
      },
      onEnter: function (el, i) {
        var item = st().items[i];
        if (item) App.go('search', { q: item.title, auto: true, autoOpen: true });
      },
      onDownExit: function () { loadMore(); return true; }
    };
    zones.push(gridZone);
    var start = startAtGrid && st().items.length ? zones.length - 1 : 0;
    App.setZones(zones, start);
  }

  /* Drop the current list and fetch page 1; `focusName` is the zone to focus afterwards. */
  function reload(focusName) {
    var s = st();
    s.items = [];
    s.start = 0;
    s.done = false;
    s.index = 0;
    renderGrid(false);
    fetchPage(false, focusName);
  }

  function loadMore() {
    var s = st();
    if (s.done || loadingMore) return;
    fetchPage(true);
  }

  function fetchPage(append, focusName) {
    var s = st();
    var mySeq = ++reqSeq;
    var myType = type;
    loadingMore = true;
    UI.loading(true);
    API.list(myType, s.tag, s.region, s.start, PAGE).then(function (items) {
      UI.loading(false);
      loadingMore = false;
      if (mySeq !== reqSeq || myType !== type || App.currentName() !== 'browse') return;
      items = items || [];
      s.items = s.items.concat(items);
      s.start += PAGE;
      if (items.length < PAGE) s.done = true;
      renderGrid(append);
      if (append) { Nav.refresh(); return; }
      /* first load → focus the grid; after a filter change → stay on that chip row */
      buildZones(!focusName);
      if (focusName) Nav.focusZoneByName(focusName);
    }, function (err) {
      UI.loading(false);
      loadingMore = false;
      if (mySeq !== reqSeq || App.currentName() !== 'browse') return;
      App.errorToast(err, '列表加载失败');
      renderGrid(append);
      if (!append) { buildZones(false); if (focusName) Nav.focusZoneByName(focusName); }
    });
  }

  function ensureFilters() {
    if (filters) return Promise.resolve(filters);
    return API.filters().then(function (f) { filters = f || {}; return filters; }, function (err) {
      App.errorToast(err, '筛选项加载失败');
      filters = { movie: { cats: ['热门电影'], regions: ['全部'] }, tv: { cats: ['最近热门'], regions: ['全部'] }, anime: { cats: ['番剧', '剧场版'], regions: [] }, show: { cats: ['最近热门'], regions: ['全部'] } };
      return filters;
    });
  }

  App.register('browse', {
    enter: function (params, isBack) {
      type = params.type || 'movie';
      UI.$('browse-title').textContent = TITLES[type] || type;
      ensureFilters().then(function () {
        buildChips();
        var s = st();
        renderGrid(false);
        if (s.items.length) {
          buildZones(true);
        } else {
          buildZones(false);
          fetchPage(false);
        }
      });
    },
    leave: function () {},
    key: function () { return false; }
  });
})();
