/* accounts.js — multi-user login for the TV (ES5 only).
 *
 * Behaviour (as specified by the user):
 *   - Credentials entered once are remembered on the TV (localStorage) and never asked again.
 *   - The last logged-in user is auto-logged-in at start; no login screen is shown.
 *   - "Log out" (from the top bar "user" tab) returns to the account picker; remembered accounts
 *     stay in the list and open with one OK press. Accounts can also be removed from the picker.
 *   - If the bridge forgot the session (restart), API.reauth() re-logs in silently with the
 *     stored credentials.
 *
 * Storage (localStorage):
 *   moontv.accounts = [{u: username, p: password, t: lastLoginMs}, ...]   newest first
 *   moontv.currentUser = username | ''                                      who is logged in
 *
 * The password is stored obfuscated (base64 of a xor'd string): this is NOT encryption — the
 * TV has no key store — it only keeps the value out of casual sight in DevTools. Accept this as
 * the cost of "remember my password" on a shared living-room device.
 */
var Accounts = (function () {
  'use strict';

  var KEY_LIST = 'moontv.accounts';
  var KEY_CUR = 'moontv.currentUser';
  var MASK = 'moontv-webos';

  function obf(str) {
    var out = '';
    for (var i = 0; i < str.length; i++) out += String.fromCharCode(str.charCodeAt(i) ^ MASK.charCodeAt(i % MASK.length));
    try { return window.btoa(unescape(encodeURIComponent(out))); } catch (e) { return ''; }
  }
  function deobf(b64) {
    var str;
    try { str = decodeURIComponent(escape(window.atob(b64))); } catch (e) { return ''; }
    return obf === null ? '' : (function () {
      var out = '';
      for (var i = 0; i < str.length; i++) out += String.fromCharCode(str.charCodeAt(i) ^ MASK.charCodeAt(i % MASK.length));
      return out;
    })();
  }

  function load() {
    try { var a = JSON.parse(window.localStorage.getItem(KEY_LIST) || '[]'); return a && a.length !== undefined ? a : []; }
    catch (e) { return []; }
  }
  function save(list) {
    try { window.localStorage.setItem(KEY_LIST, JSON.stringify(list)); } catch (e) { /* quota */ }
  }
  function currentName() { try { return window.localStorage.getItem(KEY_CUR) || ''; } catch (e) { return ''; } }
  function setCurrentName(u) { try { if (u) window.localStorage.setItem(KEY_CUR, u); else window.localStorage.removeItem(KEY_CUR); } catch (e) { /* ignore */ } }

  function find(list, u) { for (var i = 0; i < list.length; i++) if (list[i].u === u) return i; return -1; }

  function remember(u, p) {
    var list = load();
    var i = find(list, u);
    if (i >= 0) list.splice(i, 1);
    list.unshift({ u: u, p: obf(p), t: new Date().getTime() });
    save(list);
  }

  function forget(u) {
    var list = load();
    var i = find(list, u);
    if (i >= 0) { list.splice(i, 1); save(list); }
    if (currentName() === u) setCurrentName('');
  }

  /* ---- bridge interaction ---- */
  function loginWith(u, p) {
    return API.login(u, p).then(function (res) {
      API.setSession(res && res.session);
      remember(u, p);
      setCurrentName(u);
      return u;
    });
  }

  /* Used by API on 401: re-login as the current user with stored credentials. */
  function reauth() {
    var u = currentName();
    var list = load();
    var i = find(list, u);
    if (!u || i < 0 || !list[i].p) return Promise.reject(new Error('no stored credentials'));
    return API.login(u, deobf(list[i].p)).then(function (res) { API.setSession(res && res.session); });
  }

  /* At start: returns a promise resolving to the username logged in, or '' if the picker is needed.
   * On a TV that never saw the account feature (no list, no current user) the bridge's default
   * account is probed via /me and, if it is a real user, seeded as the first remembered account so
   * the upgrade is seamless; it still has to be re-entered once if its password is later needed
   * (we do not know it) — hence only the username is stored and pickUser falls back to the form. */
  function autoLogin() {
    var u = currentName();
    var list = load();
    if (!u && !list.length) {
      return API.me().then(function (me) {
        if (me && me.username) {
          /* legacy single-account mode: keep using the bridge default; mark it as current */
          list.push({ u: me.username, p: '', t: new Date().getTime(), legacy: true });
          save(list);
          setCurrentName(me.username);
          return me.username;
        }
        return '';
      }, function () { return ''; });
    }
    var i = find(list, u);
    if (!u || i < 0) return Promise.resolve('');
    if (!list[i].p) { API.setSession(''); return Promise.resolve(u); }   /* legacy default-account user */
    return API.login(u, deobf(list[i].p)).then(function (res) {
      API.setSession(res && res.session);
      return u;
    }, function (err) {
      /* wrong password now (changed on the server) → drop the current marker, keep the entry */
      if (err && err.status === 401) setCurrentName('');
      return '';
    });
  }

  function logout() {
    setCurrentName('');
    return API.logout();
  }

  return {
    list: load, remember: remember, forget: forget, currentName: currentName,
    loginWith: loginWith, reauth: reauth, autoLogin: autoLogin, logout: logout
  };
})();

/* ------------------------------------------------------------------ login view */
(function () {
  'use strict';

  var mode = 'pick';     /* 'pick' | 'add' */
  var user = '';         /* add form */
  var pass = '';
  var field = 0;         /* 0 = username, 1 = password */
  var busy = false;
  var confirmDelete = ''; /* username pending delete confirmation */

  function $(id) { return UI.$(id); }

  function renderPick() {
    var list = Accounts.list();
    var box = $('login-users');
    UI.empty(box);
    for (var i = 0; i < list.length; i++) {
      var tile = UI.el('div', 'user-tile');
      tile.setAttribute('data-u', list[i].u);
      var av = UI.text('div', 'avatar', list[i].u.charAt(0).toUpperCase());
      var nm = UI.text('div', 'name', list[i].u);
      tile.appendChild(av); tile.appendChild(nm);
      if (confirmDelete === list[i].u) {
        UI.addClass(tile, 'confirm');
        tile.appendChild(UI.text('div', 'hint', '再按红键删除'));
      }
      box.appendChild(tile);
    }
    var add = UI.el('div', 'user-tile add');
    add.setAttribute('data-u', '');
    add.appendChild(UI.text('div', 'avatar', '+'));
    add.appendChild(UI.text('div', 'name', '添加用户'));
    box.appendChild(add);
    $('login-title').textContent = list.length ? '选择用户' : '登录 MoonTV';
    $('login-sub').textContent = list.length
      ? '确认键 登录 · 红键 删除该用户 · 密码已记住，无需再次输入'
      : '首次使用：添加一个 MoonTV 账号，之后不再需要输入';
    UI.toggleClass($('login-pick'), 'hidden', false);
    UI.toggleClass($('login-add'), 'hidden', true);
  }

  function renderAdd() {
    $('login-title').textContent = '添加用户';
    $('login-sub').textContent = '用拼音键盘的 EN 模式输入；确认键 编辑，蓝键 登录，返回 取消';
    $('f-user').textContent = user || '';
    $('f-pass').textContent = pass ? new Array(pass.length + 1).join('•') : '';
    UI.toggleClass($('f-user-wrap'), 'empty', !user);
    UI.toggleClass($('f-pass-wrap'), 'empty', !pass);
    UI.toggleClass($('login-pick'), 'hidden', true);
    UI.toggleClass($('login-add'), 'hidden', false);
    $('login-err').textContent = '';
  }

  function zonesPick() {
    App.setZones([{
      name: 'users', flow: true, remember: true, index: 0,
      getItems: function () { return UI.toArray($('login-users').children); },
      onFocus: function (el) { if (confirmDelete && el.getAttribute('data-u') !== confirmDelete) { confirmDelete = ''; renderPick(); } },
      onEnter: function (el) {
        var u = el.getAttribute('data-u');
        if (!u) { mode = 'add'; user = ''; pass = ''; field = 0; renderAdd(); zonesAdd(); return; }
        pickUser(u);
      }
    }], 0, true);
  }

  function zonesAdd() {
    App.setZones([{
      name: 'form', cols: 1, remember: true, index: field,
      getItems: function () { return [$('f-user-wrap'), $('f-pass-wrap'), $('f-submit')]; },
      onFocus: function (el, i) { field = i; },
      onEnter: function (el, i) {
        if (i === 2) return submit();
        editField(i);
      }
    }], 0, true);
  }

  function editField(i) {
    IME.open({
      /* re-editing the password always starts empty (you cannot see what was there) */
      value: i === 0 ? user : '',
      english: true,
      onChange: function () {},
      onSubmit: function (v) { setField(i, v); if (i === 0 && !pass) { field = 1; zonesAdd(); Nav.focusZoneByName('form', 1); } },
      onClose: function (v) { setField(i, v); }
    });
  }
  function setField(i, v) {
    v = (v || '').replace(/\s+$/, '');
    if (i === 0) user = v; else pass = v;
    renderAdd();
  }

  function submit() {
    if (busy) return;
    if (!user || !pass) { $('login-err').textContent = '请输入用户名和密码'; return; }
    busy = true;
    UI.loading(true);
    Accounts.loginWith(user, pass).then(function (u) {
      busy = false; UI.loading(false);
      enterApp(u);
    }, function (err) {
      busy = false; UI.loading(false);
      $('login-err').textContent = (err && err.status === 401) ? '用户名或密码错误' : ('无法连接桥接服务：' + (err && err.message));
    });
  }

  function pickUser(u) {
    if (busy) return;
    var list = Accounts.list();
    var entry = null;
    for (var i = 0; i < list.length; i++) if (list[i].u === u) entry = list[i];
    if (!entry) return;
    busy = true;
    UI.loading(true);
    /* loginWith needs the clear password: Accounts keeps it obfuscated; re-use autoLogin path */
    try { window.localStorage.setItem('moontv.currentUser', u); } catch (e) { /* ignore */ }
    Accounts.autoLogin().then(function (name) {
      busy = false; UI.loading(false);
      if (name) return enterApp(name);
      /* stored password no longer valid: go to the add form prefilled */
      UI.toast('密码已失效，请重新输入');
      mode = 'add'; user = u; pass = ''; field = 1; renderAdd(); zonesAdd(); Nav.focusZoneByName('form', 1);
    });
  }

  function enterApp(u) {
    App.setUser(u);
    App.Records.load().then(function () { App.goRoot('home', {}); }, function () { App.goRoot('home', {}); });
  }

  App.register('login', {
    enter: function (params) {
      busy = false; confirmDelete = '';
      mode = (params && params.add) ? 'add' : 'pick';
      if (mode === 'add') { user = ''; pass = ''; field = 0; renderAdd(); zonesAdd(); }
      else { renderPick(); zonesPick(); }
    },
    leave: function () { IME.close(); },
    key: function (code) {
      if (IME.isOpen()) return IME.handleKey(code);
      if (mode === 'add') {
        if (code === 461 || code === 27) {           /* Back: cancel to picker (or exit if no accounts) */
          if (Accounts.list().length) { mode = 'pick'; renderPick(); zonesPick(); } else { try { window.close(); } catch (e) {} }
          return true;
        }
        if (code === 406) { submit(); return true; } /* blue = login */
        return false;
      }
      /* pick mode */
      if (code === 403) {                             /* red = delete focused user (two presses) */
        var f = document.querySelector('#login-users .focus');
        var u = f && f.getAttribute('data-u');
        if (!u) return true;
        var idx = UI.toArray($('login-users').children).indexOf(f);
        if (confirmDelete === u) { Accounts.forget(u); confirmDelete = ''; renderPick(); zonesPick(); UI.toast('已删除 ' + u); }
        else { confirmDelete = u; renderPick(); Nav.focusZoneByName('users', idx); }
        return true;
      }
      if (code === 461 || code === 27) { try { window.close(); } catch (e2) {} return true; }  /* Back on picker = exit app */
      return false;
    }
  });
})();
