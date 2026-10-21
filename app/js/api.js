/* api.js — XMLHttpRequest wrapper for the moontv-api bridge. ES5 only.
 * Set BASE to your bridge, e.g. 'http://<bridge-host>:8788'. */
var API = (function () {
  'use strict';

  /* On the TV the app is loaded from file:// and needs an explicit bridge address.
   * When served by the bridge itself (http://<bridge>:8788/tv/) use the same origin. */
  var BASE = (window.location.protocol === 'http:' || window.location.protocol === 'https:')
    ? window.location.protocol + '//' + window.location.host
    : 'http://BRIDGE_HOST:8788';
  var DEFAULT_TIMEOUT = 20000;

  /* Session token issued by POST /login; sent as X-Session on every request.
   * Empty = use the bridge's default account. reauth() is installed by Accounts and is called
   * once when the bridge answers 401 (bridge restarted / token expired) to re-login silently. */
  var session = '';
  var reauth = null;

  function qs(params) {
    var parts = [];
    for (var k in params) {
      if (!params.hasOwnProperty(k)) continue;
      var v = params[k];
      if (v === undefined || v === null || v === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
    return parts.length ? '?' + parts.join('&') : '';
  }

  /* request(method, path, body, timeoutMs) -> Promise<json>. Errors are plain Error objects with .url set. */
  function request(method, path, body, timeoutMs, isRetry) {
    var url = BASE + path;
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var done = false;
      function fail(msg) {
        if (done) return;
        done = true;
        var err = new Error(msg);
        err.url = url;
        reject(err);
      }
      try {
        xhr.open(method, url, true);
      } catch (e) {
        return fail('open failed: ' + e.message);
      }
      xhr.timeout = timeoutMs || DEFAULT_TIMEOUT;
      if (session) { try { xhr.setRequestHeader('X-Session', session); } catch (e3) { /* ignore */ } }
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4 || done) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          var data = null;
          try {
            data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
          } catch (e) {
            return fail('bad JSON from ' + path);
          }
          done = true;
          resolve(data);
        } else if (xhr.status === 401 && session && !isRetry && reauth && path !== '/login') {
          /* token no longer valid on the bridge: re-login with the stored credentials, retry once */
          done = true;
          reauth().then(function () {
            request(method, path, body, timeoutMs, true).then(resolve, reject);
          }, function () {
            var err = new Error('HTTP 401 ' + path); err.url = url; err.status = 401; reject(err);
          });
        } else {
          var e2 = new Error('HTTP ' + xhr.status + ' ' + path); e2.url = url; e2.status = xhr.status;
          if (done) return;
          done = true;
          reject(e2);
        }
      };
      xhr.onerror = function () { fail('network error ' + path); };
      xhr.ontimeout = function () { fail('timeout ' + path); };
      if (body !== undefined && body !== null) {
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify(body));
      } else {
        xhr.send();
      }
    });
  }

  function get(path, params, timeoutMs) { return request('GET', path + qs(params || {}), null, timeoutMs); }

  /* Poster URL via the bridge cache (douban blocks hotlinking). */
  function poster(url) {
    if (!url) return '';
    return BASE + '/poster?url=' + encodeURIComponent(url);
  }

  return {
    BASE: BASE,
    home: function () { return get('/home'); },
    filters: function () { return get('/filters'); },
    titles: function () { return get('/titles', null, 120000); },
    /* --- web-UI parity features --- */
    advancedFilters: function (type) { return get('/filters/advanced', { type: type }); },
    advancedList: function (type, params, start, size) {
      var p = { type: type, start: start, size: size };
      for (var k in params) if (params.hasOwnProperty(k) && params[k]) p[k] = params[k];
      return get('/list/advanced', p, 60000);
    },
    favorites: function () { return get('/favorites'); },
    addFavorite: function (key, fav) { return request('POST', '/favorites', { key: key, favorite: fav }); },
    removeFavorite: function (key) { return request('DELETE', '/favorites' + qs({ key: key })); },
    skipConfig: function (key) { return get('/skip', { key: key }); },
    saveSkipConfig: function (key, cfg) { return request('POST', '/skip', { key: key, config: cfg }); },
    clearRecords: function () { return request('DELETE', '/record'); },
    removeRecord: function (key) { return request('DELETE', '/record' + qs({ key: key })); },
    bangumi: function () { return get('/bangumi'); },
    /* --- accounts --- */
    login: function (username, password) { return request('POST', '/login', { username: username, password: password }, 20000, true); },
    logout: function () { var t = session; session = ''; return t ? request('POST', '/logout', { session: t }, 10000, true).then(null, function () {}) : Promise.resolve(); },
    me: function () { return get('/me'); },
    seedAccounts: function () { return get('/seed-accounts', null, 10000); },
    /* --- phone-as-keyboard --- */
    remoteNew: function (id) { return request('POST', '/remote/new', { id: id || '' }, 10000, true); },
    remotePoll: function (id, since) { return get('/remote/' + id + '/poll', { since: since }, 35000); },
    remoteState: function (id, state) { return request('POST', '/remote/' + id + '/state', state, 5000, true).then(null, function () {}); },
    remoteQr: function (id) { return BASE + '/remote/' + id + '/qr.svg'; },
    base: function () { return BASE; },
    setSession: function (t) { session = t || ''; },
    hasSession: function () { return !!session; },
    setReauth: function (fn) { reauth = fn; },
    list: function (type, tag, region, start, size) {
      return get('/list', { type: type, tag: tag, region: region, start: start || 0, size: size || 24 });
    },
    search: function (q) { return get('/search', { q: q }, 90000); },
    detail: function (source, id) { return get('/detail', { source: source, id: id }); },
    records: function () { return get('/record'); },
    saveRecord: function (key, record) { return request('POST', '/record', { key: key, record: record }); },
    /* items: [{source, source_name, url}] -> same list + {ok, latency_ms, speed_kbps, resolution, error} */
    /* fresh=true makes the bridge drop its 15-min cache for these urls and measure again */
    probe: function (items, fresh) { return request('POST', '/probe', { items: items, fresh: !!fresh }, 60000); },
    poster: poster
  };
})();
