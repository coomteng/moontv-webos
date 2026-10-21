/* browse.js — category pages (电影 / 剧集 / 动漫 / 综艺): filter chips + 7-column poster grid (ES5 only).
 *
 * Two modes per type, mirroring MoonTV's web UI:
 *   - normal: first row [全部 | 热门电影 | …] + 地区/类型 row, list from /list (douban categories)
 *   - 全部 (advanced): the rows come from /filters/advanced (排序 / 类型 / 地区 / 年代 / 平台), list from
 *     /list/advanced. anime has no 全部 tab (the bridge answers 400 for it). */
(function () {
  'use strict';

  var COLS = 7;
  var PAGE = 24;
  var TITLES = { movie: '电影', tv: '剧集', anime: '动漫', show: '综艺' };
  var ADV_TYPES = { movie: true, tv: true, show: true };
  var ALL = '全部';

  var filters = null;          /* from /filters */
  var advGroups = {};          /* type -> [{key, label, options}] from /filters/advanced */
  var state = {};              /* per type: { tag, region, adv, advParams, items, start, done, index } */
  var type = 'movie';
  var chipRows = [];           /* [{ kind:'cats'|'regions'|'adv-<key>', el, chips:[el], wrap, scroll }] */
  var gridZone = null;
  var loadingMore = false;
  var reqSeq = 0;

  function st() {
    if (!state[type]) state[type] = { tag: '', region: '', adv: false, advParams: {}, items: [], start: 0, done: false, index: 0 };
    return state[type];
  }

  function hasAdv() { return !!ADV_TYPES[type]; }

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
    var cats = f.cats || [];
    if (hasAdv()) cats = [ALL].concat(cats);
    /* row labels follow MoonTV's web UI: movie 分类/地区, tv 分类/类型, show 分类/地区, anime 分类 */
    addChipRow('cats', '分类', cats, s.adv ? ALL : s.tag, false);
    if (s.adv) {
      var groups = advGroups[type] || [];
      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        var curv = s.advParams[grp.key] || (grp.options && grp.options[0]) || '';
        addChipRow('adv-' + grp.key, grp.label, grp.options || [], curv, true);
      }
    } else if (f.regions && f.regions.length) {
      addChipRow('regions', type === 'tv' ? '类型' : '地区', f.regions, s.region, false);
    }
    UI.toggleClass(UI.$('browse-head'), 'no-filters', chipRows.length === 0 || (chipRows.length === 1 && chipRows[0].chips.length <= 1));
    /* grid starts right under the filter block (its height depends on the number of chip rows) */
    var head = UI.$('browse-head');
    scrollEl().style.top = (head.offsetTop + head.offsetHeight + 10) + 'px';
  }

  /* scroll=true: a single non-wrapping line that is translated so the focused chip stays visible */
  function addChipRow(kind, label, values, current, scroll) {
    var row = UI.el('div', 'filter-row');
    row.appendChild(UI.text('div', 'filter-label', label));
    var chips = UI.el('div', scroll ? 'chips strip' : 'chips');
    var els = [];
    for (var i = 0; i < values.length; i++) {
      var c = UI.text('div', 'chip', values[i]);
      c.setAttribute('data-value', values[i]);
      if (values[i] === current) UI.addClass(c, 'current');
      chips.appendChild(c);
      els.push(c);
    }
    var holder = chips;
    if (scroll) {
      holder = UI.el('div', 'chips-wrap');
      holder.appendChild(chips);
      UI.translate(chips, 0, 0);
    }
    row.appendChild(holder);
    UI.$('browse-filters').appendChild(row);
    chipRows.push({ kind: kind, el: row, chips: els, chipsEl: chips, wrap: scroll ? holder : null });
  }

  function findRow(kind) {
    for (var i = 0; i < chipRows.length; i++) if (chipRows[i].kind === kind) return chipRows[i];
    return null;
  }

  function markCurrent(rowDef, el) {
    for (var k = 0; k < rowDef.chips.length; k++) UI.toggleClass(rowDef.chips[k], 'current', rowDef.chips[k] === el);
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
      onFocus: function (el) {
        UI.translate(gridEl(), 0, 0);
        if (rowDef.wrap) Nav.scrollX(rowDef.chipsEl, el, rowDef.wrap.clientWidth, 0, 8);
      },
      onEnter: function (el) {
        var v = el.getAttribute('data-value');
        var s = st();
        if (rowDef.kind === 'cats') {
          var wantAdv = hasAdv() && v === ALL;
          if (wantAdv) {
            if (s.adv) return;                       /* already on 全部 */
            s.adv = true;
            switchMode('chips-cats');
            return;
          }
          s.tag = v;
          if (s.adv) { s.adv = false; switchMode('chips-cats'); return; }
          markCurrent(rowDef, el);
          reload('chips-cats');
        } else if (rowDef.kind === 'regions') {
          s.region = v;
          markCurrent(rowDef, el);
          reload('chips-regions');
        } else {
          /* advanced group row */
          s.advParams[rowDef.kind.substring(4)] = v;
          markCurrent(rowDef, el);
          reload('chips-' + rowDef.kind);
        }
      }
    };
  }

  /* 全部 <-> normal: rebuild the chip rows (needs the advanced groups), then reload the list. */
  function switchMode(focusName) {
    var myType = type;
    ensureAdv().then(function () {
      if (myType !== type || App.currentName() !== 'browse') return;
      buildChips();
      buildZones(false);
      Nav.focusZoneByName(focusName, 0);
      reload(focusName);
    });
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

  /* Advanced params as sent to /list/advanced: every group's current value (defaults = first option). */
  function advQuery(s) {
    var p = {}, groups = advGroups[type] || [];
    for (var g = 0; g < groups.length; g++) {
      var k = groups[g].key;
      p[k] = s.advParams[k] || (groups[g].options && groups[g].options[0]) || '';
    }
    return p;
  }

  function fetchPage(append, focusName) {
    var s = st();
    var mySeq = ++reqSeq;
    var myType = type;
    loadingMore = true;
    UI.loading(true);
    var req = s.adv ? API.advancedList(myType, advQuery(s), s.start, PAGE) : API.list(myType, s.tag, s.region, s.start, PAGE);
    req.then(function (items) {
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

  /* Advanced groups for the current type (cached per type). Not needed unless 全部 is selected. */
  function ensureAdv() {
    var myType = type;
    if (!hasAdv()) return Promise.resolve([]);
    if (advGroups[myType]) return Promise.resolve(advGroups[myType]);
    return API.advancedFilters(myType).then(function (g) {
      advGroups[myType] = g || [];
      return advGroups[myType];
    }, function (err) {
      App.errorToast(err, '筛选项加载失败');
      advGroups[myType] = [];
      return advGroups[myType];
    });
  }

  App.register('browse', {
    enter: function (params, isBack) {
      type = params.type || 'movie';
      UI.$('browse-title').textContent = TITLES[type] || type;
      ensureFilters().then(function () {
        return st().adv ? ensureAdv() : null;
      }).then(function () {
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
