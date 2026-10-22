/* app.js — router, view stack, top bar, global key dispatch, play-record cache (ES5 only). */
var App = (function () {
  'use strict';

  var views = {};          /* name -> { enter(params, isBack), leave(), key(code) -> bool, zones() -> [Zone] } */
  var stack = [];          /* [{ name, params }] — last entry is the active view */
  var tabEls = [];
  var tabsZone = null;
  var activeName = null;

  /* ------------------------------------------------------------ play records cache */
  var Records = {
    list: [],
    byKey: {},
    load: function () {
      return API.records().then(function (recs) {
        Records.set(recs || []);
        return Records.list;
      }, function () { return Records.list; });
    },
    set: function (recs) {
      Records.list = recs;
      Records.byKey = {};
      for (var i = 0; i < recs.length; i++) Records.byKey[recs[i].key] = recs[i];
    },
    /* Newest record whose title matches (records are already newest-first). */
    findByTitle: function (title) {
      if (!title) return null;
      for (var i = 0; i < Records.list.length; i++) {
        if (Records.list[i].title === title) return Records.list[i];
      }
      return null;
    },
    findByKey: function (key) { return Records.byKey[key] || null; },
    /* Local update after a successful (or attempted) POST so views stay consistent. */
    put: function (rec) {
      var i;
      for (i = 0; i < Records.list.length; i++) {
        if (Records.list[i].key === rec.key) { Records.list.splice(i, 1); break; }
      }
      Records.list.unshift(rec);
      Records.byKey[rec.key] = rec;
    }
  };

  /* ------------------------------------------------------------ favourites cache (我的收藏) */
  var Favorites = {
    list: [],
    byKey: {},
    load: function () {
      return API.favorites().then(function (favs) {
        Favorites.set(favs || []);
        return Favorites.list;
      }, function () { return Favorites.list; });
    },
    set: function (favs) {
      Favorites.list = favs;
      Favorites.byKey = {};
      for (var i = 0; i < favs.length; i++) Favorites.byKey[favs[i].key] = favs[i];
    },
    has: function (key) { return !!Favorites.byKey[key]; },
    findByKey: function (key) { return Favorites.byKey[key] || null; },
    /* Local update after POST /favorites: newest first, same card fields as /home "favorites". */
    put: function (fav) {
      Favorites.remove(fav.key);
      Favorites.list.unshift(fav);
      Favorites.byKey[fav.key] = fav;
    },
    remove: function (key) {
      for (var i = 0; i < Favorites.list.length; i++) {
        if (Favorites.list[i].key === key) { Favorites.list.splice(i, 1); break; }
      }
      delete Favorites.byKey[key];
    }
  };

  /* ------------------------------------------------------------ top bar */
  function buildTabs() {
    tabEls = UI.toArray(document.querySelectorAll('#topbar .tab'));
    tabsZone = {
      name: 'tabs',
      cols: 0,
      remember: true,
      index: 0,
      getItems: function () { return tabEls; },
      onEnter: function (el) {
        var v = el.getAttribute('data-view');
        var t = el.getAttribute('data-type');
        if (v === 'user') return userMenu();
        goRoot(v, t ? { type: t } : {});
      }
    };
  }

  /* OK on the user tab: log out → account picker (accounts stay remembered). */
  function userMenu() {
    if (!currentUser) { stack = []; activate({ name: 'login', params: {} }, false); return; }
    UI.toast('已登出 ' + currentUser);
    Accounts.logout().then(function () {
      setUser('');
      Records.set([]);
      Favorites.set([]);
      stack = [];
      activate({ name: 'login', params: {} }, false);
    });
  }

  function markCurrentTab(name, params) {
    for (var i = 0; i < tabEls.length; i++) {
      var el = tabEls[i];
      var match = el.getAttribute('data-view') === name &&
        (name !== 'browse' || (params && el.getAttribute('data-type') === params.type));
      UI.toggleClass(el, 'current', match);
      if (match) tabsZone.index = i;
    }
  }

  /* ------------------------------------------------------------ view switching */
  function showDom(name) {
    var all = document.querySelectorAll('.view');
    for (var i = 0; i < all.length; i++) UI.toggleClass(all[i], 'active', all[i].id === name);
    UI.toggleClass(UI.$('topbar'), 'hidden', name === 'player' || name === 'login');
  }

  /* current user shown in the top bar; '' = bridge default account */
  var currentUser = '';
  function setUser(u) {
    var changed = (u || '') !== currentUser;
    currentUser = u || '';
    if (changed) {
      /* per-user state must not leak across accounts */
      Records.set([]);
      Favorites.set([]);
      for (var n in views) if (views.hasOwnProperty(n) && views[n].reset) views[n].reset();
    }
    var el = UI.$('tab-user');
    if (el) el.textContent = currentUser ? '\u25CF ' + currentUser : '登录';
  }
  function getUser() { return currentUser; }

  function activate(entry, isBack) {
    var prev = activeName;
    if (prev && views[prev] && views[prev].leave && prev !== entry.name) views[prev].leave();
    activeName = entry.name;
    showDom(entry.name);
    var tabName = entry.name === 'detail' || entry.name === 'player' ? null : entry.name;
    markCurrentTab(tabName, entry.params);
    views[entry.name].enter(entry.params || {}, !!isBack);
  }

  /* Push a view on the stack. */
  function go(name, params) {
    if (!views[name]) return;
    stack.push({ name: name, params: params || {} });
    activate(stack[stack.length - 1], false);
  }

  /* Replace the top of the stack (used for tab switches so Back always lands on home). */
  function goRoot(name, params) {
    stack = [{ name: 'home', params: {} }];
    if (name !== 'home') stack.push({ name: name, params: params || {} });
    activate(stack[stack.length - 1], false);
  }

  function back() {
    if (stack.length <= 1) {
      /* On home: Back exits the app (spec §7). */
      try { window.close(); } catch (e) { /* ignore */ }
      return;
    }
    stack.pop();
    activate(stack[stack.length - 1], true);
  }

  function currentName() { return activeName; }

  /* Views call this whenever their zones change. Tabs are prepended except in the player. */
  function setZones(zones, startZone, noTabs) {
    var bare = noTabs || activeName === 'player' || activeName === 'login';
    var all = bare ? zones : [tabsZone].concat(zones);
    var start = startZone === undefined ? (bare ? 0 : 1) : startZone + (bare ? 0 : 1);
    if (start >= all.length) start = all.length - 1;
    Nav.setContext({ zones: all, zone: start });
  }

  function focusTabs() { Nav.focusZoneByName('tabs'); }

  function zoneName() { var c = Nav.current(); return c && c.zone ? c.zone.name : null; }

  /* ------------------------------------------------------------ key dispatch */
  function isNavKey(code) {
    return code === 37 || code === 38 || code === 39 || code === 40 || code === 13 || code === 461;
  }

  function onKeyDown(e) {
    var code = e.keyCode || e.which;
    var view = views[activeName];
    if (!view) return;
    var handled = false;
    if (view.key) handled = view.key(code, e);
    if (handled === 'ignore') return;   /* e.g. typing in the search input: leave the browser default alone */
    if (!handled) {
      if (code === 461 || code === 27) {
        back();
        handled = true;
      } else {
        handled = Nav.handleKey(code);
      }
    }
    if (handled || isNavKey(code)) {
      if (e.preventDefault) e.preventDefault();
    }
  }

  function register(name, view) { views[name] = view; }

  function errorToast(err, what) {
    var msg = (what || '请求失败') + '：' + (err && err.message ? err.message : '未知错误');
    if (err && /network|timeout/.test(err.message || '')) msg += '（' + API.BASE + '）';
    UI.toast(msg, 5000);
  }

  /* ------------------------------------------------------------ bootstrap */
  /* Show the installed version next to the logo (from appinfo.json, the single source of truth). */
  function showVersion() {
    var el = UI.$('app-version');
    if (!el) return;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'appinfo.json', true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      try { var v = JSON.parse(xhr.responseText).version; if (v) el.textContent = 'v' + v; } catch (e) { /* ignore */ }
    };
    try { xhr.send(); } catch (e2) { /* ignore */ }
  }

  function init() {
    showVersion();
    buildTabs();
    UI.clock();
    setInterval(UI.clock, 15000);
    /* clock zone from the bridge; refresh hourly in case of DST changes */
    var syncClock = function () { API.time().then(function (t) { if (t) UI.setClockOffset(t.offset_min); }, function () {}); };
    syncClock();
    setInterval(syncClock, 60 * 60 * 1000);
    document.addEventListener('keydown', onKeyDown, false);
    Nav.installPointer();
    /* Reduce scrolling/jumping from the TV browser default handlers. */
    window.addEventListener('scroll', function () { window.scrollTo(0, 0); }, false);
    API.setReauth(Accounts.reauth);
    /* Boot: auto-login as the last user; otherwise show the account picker. */
    UI.loading(true);
    Accounts.autoLogin().then(function (u) {
      UI.loading(false);
      if (u) {
        setUser(u);
        Records.load();
        Favorites.load();
        goRoot('home', {});
      } else {
        setUser('');
        stack = [];
        activate({ name: 'login', params: {} }, false);
      }
    }, function () {
      /* bridge unreachable: still show the picker so the user sees an error there */
      UI.loading(false);
      setUser('');
      stack = [];
      activate({ name: 'login', params: {} }, false);
    });
  }

  return {
    register: register, go: go, goRoot: goRoot, back: back, setZones: setZones, focusTabs: focusTabs,
    currentName: currentName, zoneName: zoneName, errorToast: errorToast, setUser: setUser, getUser: getUser, Records: Records, Favorites: Favorites, init: init,
    stackNames: function () { var n = []; for (var i = 0; i < stack.length; i++) n.push(stack[i].name); return n; }
  };
})();

document.addEventListener('DOMContentLoaded', function () { App.init(); }, false);
