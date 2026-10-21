/* home.js — home view: 继续观看 / 我的收藏 / douban rows / 新番放送, horizontal strips (ES5 only). */
(function () {
  'use strict';

  /* /home key order == render order */
  var ROWS = [
    { key: 'continue', title: '继续观看', kind: 'record' },
    { key: 'favorites', title: '我的收藏', kind: 'fav' },
    { key: 'movie', title: '热门电影', kind: 'douban' },
    { key: 'tv', title: '热门剧集', kind: 'douban' },
    { key: 'bangumi', title: '新番放送', kind: 'bangumi' },
    { key: 'anime', title: '热门动漫', kind: 'douban' },
    { key: 'show', title: '热门综艺', kind: 'douban' }
  ];
  var VIEW_H = 970;   /* 1080 - topbar 110 */
  var CLEAR_CONFIRM_MS = 5000;

  var data = null;
  var rowEls = {};    /* key -> { row, cards, zone } */
  var zones = [];
  var loaded = false;
  var loadingNow = false;
  var clearArmed = 0; /* timestamp of the first RED press on 继续观看 (two-press confirmation) */

  function rowsNode() { return UI.$('home-rows'); }

  function scrollToRow(rowEl) {
    Nav.pinTop(rowsNode(), rowEl, 10);
  }

  function makeZone(def, rowEl, cardsEl, items) {
    return {
      name: 'row-' + def.key,
      cols: 0,
      remember: true,
      index: 0,
      getItems: function () { return UI.toArray(cardsEl.children); },
      onFocus: function (el) {
        Nav.scrollX(cardsEl, el, 1920, 60, 60);
        scrollToRow(rowEl);
      },
      onEnter: function (el, i) {
        var item = items[i];
        if (!item) return;
        if (def.kind === 'record' || def.kind === 'fav') openRecord(item);
        else openDouban(item);
      }
    };
  }

  function buildCard(kind, item) {
    if (kind === 'record') return Cards.record(item);
    if (kind === 'fav') return Cards.fav(item);
    if (kind === 'bangumi') return Cards.bangumi(item);
    return Cards.douban(item);
  }

  function buildRow(def, items) {
    var row = UI.el('div', 'row');
    var title = UI.text('div', 'row-title', def.title);
    if (def.kind === 'record') title.appendChild(UI.text('span', 'hint', '按确认键继续播放 · 红键 清空'));
    row.appendChild(title);
    var cards = UI.el('div', 'cards');
    for (var i = 0; i < items.length; i++) cards.appendChild(buildCard(def.kind, items[i]));
    row.appendChild(cards);
    UI.translate(cards, 0, 0);
    return { row: row, cards: cards, zone: makeZone(def, row, cards, items) };
  }

  function render() {
    var root = rowsNode();
    var cur = Nav.current();
    var prevRows = rowEls;
    var startZone = 0;
    UI.empty(root);
    rowEls = {};
    zones = [];
    for (var r = 0; r < ROWS.length; r++) {
      var def = ROWS[r];
      var items = (data && data[def.key]) || [];
      if (!items.length) continue;              /* skip empty rows */
      var built = buildRow(def, items);
      /* keep the previous position in this row, if any */
      if (prevRows[def.key]) {
        built.zone.index = Math.min(prevRows[def.key].zone.index || 0, items.length - 1);
        if (cur && cur.zone === prevRows[def.key].zone) startZone = zones.length;
      }
      root.appendChild(built.row);
      rowEls[def.key] = built;
      zones.push(built.zone);
    }
    UI.translate(root, 0, 0);
    if (!zones.length) {
      root.appendChild(UI.text('div', 'empty', '没有数据。请检查桥接服务 ' + API.BASE));
    }
    App.setZones(zones, startZone);
  }

  /* Re-render the 继续观看 / 我的收藏 rows from the local caches (after playback / detail page). */
  function refreshContinue() {
    if (!data) return;
    data['continue'] = App.Records.list.slice(0, 20);
    data['favorites'] = App.Favorites.list.slice(0, 20);
    render();
  }

  /* RED on the 继续观看 row: first press arms, second press within 5 s clears all records (web: 清空). */
  function clearContinue() {
    var now = new Date().getTime();
    if (!clearArmed || now - clearArmed > CLEAR_CONFIRM_MS) {
      clearArmed = now;
      UI.toast('再按红键清空继续观看', CLEAR_CONFIRM_MS);
      return;
    }
    clearArmed = 0;
    UI.loading(true);
    API.clearRecords().then(function () {
      UI.loading(false);
      App.Records.set([]);
      UI.toast('已清空继续观看');
      if (App.currentName() === 'home') refreshContinue();
    }, function (err) {
      UI.loading(false);
      App.errorToast(err, '清空失败');
    });
  }

  function load() {
    if (loadingNow) return;
    loadingNow = true;
    UI.loading(true);
    API.home().then(function (d) {
      UI.loading(false);
      loadingNow = false;
      data = d || {};
      loaded = true;
      if (data['continue'] && data['continue'].length) App.Records.set(data['continue'].slice());
      if (data['favorites']) App.Favorites.set(data['favorites'].slice());
      render();
    }, function (err) {
      UI.loading(false);
      loadingNow = false;
      data = data || {};
      App.errorToast(err, '首页加载失败');
      render();
    });
  }

  /* ---- actions ---- */

  /* Douban card: open search pre-filled, auto-run, auto-open single result. */
  function openDouban(item) {
    App.go('search', { q: item.title, auto: true, autoOpen: true });
  }

  /* Record / favourite card: fetch episodes, fall back to search, then resume in the player
     (a favourite has no index/play_time: it opens the detail page only). */
  function openRecord(rec) {
    UI.loading(true);
    var done = function (result) {
      UI.loading(false);
      if (!result || !result.episodes || !result.episodes.length) {
        UI.toast('没有找到「' + rec.title + '」的播放源（' + (rec.source_name || rec.source) + '）', 4000);
        return;
      }
      var idx = Math.max(0, Math.min((rec.index || 1) - 1, result.episodes.length - 1));
      App.go('detail', { result: result, group: null, query: rec.search_title || rec.title });
      if (rec.index) App.go('player', { result: result, index: idx, startTime: rec.play_time || 0, query: rec.search_title || rec.title });
    };
    var fail = function (err) {
      UI.loading(false);
      App.errorToast(err, '获取剧集失败');
    };
    API.detail(rec.source, rec.id).then(function (res) {
      if (res && res.episodes && res.episodes.length) return res;
      return API.search(rec.search_title || rec.title).then(function (groups) {
        var same = null, fallback = null;
        for (var g = 0; g < (groups || []).length; g++) {
          var srcs = groups[g].sources || [];
          for (var s = 0; s < srcs.length; s++) {
            if (!srcs[s].episodes || !srcs[s].episodes.length) continue;
            if (srcs[s].source === rec.source && String(srcs[s].id) === String(rec.id)) return srcs[s];
            if (!same && srcs[s].source === rec.source && srcs[s].title === rec.title) same = srcs[s];
            if (!fallback && srcs[s].title === rec.title) fallback = srcs[s];
          }
        }
        return same || fallback;
      });
    }).then(done, fail);
  }

  /* Called by App when the user changes: forget everything fetched for the previous user. */
  function reset() {
    data = null;
    loaded = false;
    loadingNow = false;
    clearArmed = 0;
    UI.empty(UI.$('home-rows'));
  }

  App.register('home', {
    reset: reset,
    enter: function (params, isBack) {
      if (!loaded) { load(); return; }
      /* 继续观看 / 我的收藏 may have changed in the player / detail page: re-render from the caches */
      refreshContinue();
    },
    leave: function () { clearArmed = 0; },
    key: function (code) {
      if (code === 403 && App.zoneName() === 'row-continue') { clearContinue(); return true; }   /* red = 清空 */
      return false;
    }
  });
})();
