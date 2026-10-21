/* search.js — search view: system-IME input, recent searches, grouped results (ES5 only). */
(function () {
  'use strict';

  var COLS = 7;
  var HISTORY_KEY = 'moontv.searchHistory';
  var MAX_HISTORY = 20;

  var groups = [];          /* last results */
  var lastQuery = '';
  var reqSeq = 0;
  var searching = false;
  var gridIndex = 0;
  var inputFocused = false;  /* DOM focus (IME) state of the input */

  function input() { return UI.$('search-input'); }
  function gridEl() { return UI.$('search-grid'); }
  function status(msg) { UI.$('search-status').textContent = msg || ''; }

  /* ---- history (localStorage) ---- */
  function getHistory() {
    try {
      var raw = window.localStorage.getItem(HISTORY_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return arr && arr.length !== undefined ? arr : [];
    } catch (e) { return []; }
  }
  function pushHistory(q) {
    var h = getHistory(), out = [q];
    for (var i = 0; i < h.length && out.length < MAX_HISTORY; i++) if (h[i] !== q) out.push(h[i]);
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(out)); } catch (e) { /* quota / private mode */ }
  }

  function renderHistory() {
    var wrap = UI.$('search-history-chips');
    UI.empty(wrap);
    var h = getHistory();
    for (var i = 0; i < h.length; i++) {
      var c = UI.text('div', 'chip', h[i]);
      c.setAttribute('data-q', h[i]);
      wrap.appendChild(c);
    }
    UI.toggleClass(UI.$('search-history'), 'hidden', !h.length || groups.length > 0 || searching);
  }

  /* ---- results ---- */
  function renderResults() {
    var g = gridEl();
    UI.empty(g);
    UI.translate(g, 0, 0);
    for (var i = 0; i < groups.length; i++) g.appendChild(Cards.group(groups[i]));
    UI.toggleClass(UI.$('search-scroll'), 'hidden', !groups.length);
  }

  function zones() {
    var z = [];
    z.push({
      name: 'search-head',
      cols: 0,
      remember: true,
      index: 0,
      getItems: function () { return [input(), UI.$('search-btn')]; },
      onEnter: function (el) {
        if (el === input()) openIme();
        else runSearch(input().value);
      }
    });
    var hist = UI.$('search-history-chips');
    z.push({
      name: 'history',
      flow: true,
      remember: true,
      index: 0,
      disabled: function () { return UI.hasClass(UI.$('search-history'), 'hidden'); },
      getItems: function () { return UI.toArray(hist.children); },
      onEnter: function (el) {
        var q = el.getAttribute('data-q');
        input().value = q;
        runSearch(q);
      }
    });
    z.push({
      name: 'results',
      cols: COLS,
      remember: true,
      index: gridIndex,
      disabled: function () { return !groups.length; },
      getItems: function () { return UI.toArray(gridEl().children); },
      onFocus: function (el, i) {
        gridIndex = i;
        Nav.scrollY(gridEl(), el, UI.$('search-scroll').clientHeight, 20, 20);
      },
      onEnter: function (el, i) {
        if (groups[i]) App.go('detail', { group: groups[i], query: lastQuery });
      }
    });
    return z;
  }

  function applyZones(startName) {
    var z = zones();
    var start = 0;
    for (var i = 0; i < z.length; i++) if (z[i].name === startName) start = i;
    App.setZones(z, start);
  }

  /* ---- IME handling ----
   * OK on the input gives it real DOM focus → webOS opens the on-screen keyboard.
   * While focused, keys go to the input; Enter runs the search and blurs. */
  /* The EU TV's system keyboard has no Chinese, so we use our own pinyin overlay (js/ime.js).
   * The <input> is display-only; it never receives DOM focus. */
  function openIme() {
    var el = input();
    UI.addClass(el, 'editing');
    IME.open({
      value: el.value,
      submitLabel: '搜索',
      onChange: function (v) { el.value = v; },
      onSubmit: function (v) { UI.removeClass(el, 'editing'); runSearch(v); },
      onClose: function (v) { el.value = v; UI.removeClass(el, 'editing'); }
    });
  }
  function closeIme() {
    IME.close();
    UI.removeClass(input(), 'editing');
  }

  function runSearch(q, opts) {
    opts = opts || {};
    q = UI.cleanText(q);
    closeIme();
    if (!q) { UI.toast('请输入要搜索的片名'); return; }
    input().value = q;
    lastQuery = q;
    pushHistory(q);
    var mySeq = ++reqSeq;
    searching = true;
    groups = [];
    gridIndex = 0;
    renderResults();
    renderHistory();
    status('搜索中…「' + q + '」');
    UI.loading(true);
    API.search(q).then(function (res) {
      UI.loading(false);
      if (mySeq !== reqSeq) return;
      searching = false;
      groups = [];
      for (var i = 0; i < (res || []).length; i++) {
        var g = res[i];
        if (g && g.sources && g.sources.length) groups.push(g);
      }
      renderResults();
      renderHistory();
      if (!groups.length) {
        status('没有找到「' + q + '」相关的内容');
        if (App.currentName() === 'search') applyZones('search-head');
        return;
      }
      status('找到 ' + groups.length + ' 个结果');
      if (App.currentName() !== 'search') return;
      if (opts.autoOpen && groups.length === 1) {
        applyZones('results');
        App.go('detail', { group: groups[0], query: q });
      } else {
        applyZones('results');
      }
    }, function (err) {
      UI.loading(false);
      if (mySeq !== reqSeq) return;
      searching = false;
      status('搜索失败');
      renderHistory();
      App.errorToast(err, '搜索失败');
      if (App.currentName() === 'search') applyZones('search-head');
    });
  }

  function onInputKey(code, e) {
    if (IME.isOpen()) return IME.handleKey(code);
    if (!inputFocused) return false;
    if (code === 13) {
      runSearch(input().value);
      return true;
    }
    if (code === 461 || code === 27) {   /* Back closes the keyboard, does not leave the view */
      closeIme();
      return true;
    }
    if (code === 38 || code === 40) {    /* leave the input with ↑/↓ */
      closeIme();
      return false;
    }
    /* ←/→ and characters belong to the input while editing: no preventDefault, no Nav */
    return 'ignore';
  }

  App.register('search', {
    enter: function (params, isBack) {
      var el = input();
      renderHistory();
      if (isBack) {
        renderResults();
        status(groups.length ? '找到 ' + groups.length + ' 个结果' : (lastQuery ? '没有找到「' + lastQuery + '」相关的内容' : ''));
        applyZones(groups.length ? 'results' : 'search-head');
        return;
      }
      if (params.q) {
        el.value = params.q;
        if (params.auto) {
          applyZones('search-head');
          runSearch(params.q, { autoOpen: !!params.autoOpen });
          return;
        }
      }
      if (!groups.length) { status(''); }
      renderResults();
      applyZones('search-head');
    },
    leave: function () { closeIme(); },
    key: onInputKey
  });

  /* Pointer click (magic remote) on the input opens the pinyin keyboard too; block native focus. */
  document.addEventListener('DOMContentLoaded', function () {
    var el = input();
    el.setAttribute('readonly', 'readonly');
    el.setAttribute('tabindex', '-1');
    el.addEventListener('mousedown', function (e) { if (e.preventDefault) e.preventDefault(); openIme(); }, false);
    el.addEventListener('focus', function () { try { el.blur(); } catch (e) { /* ignore */ } }, false);
  }, false);
})();
