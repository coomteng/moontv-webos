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
  function request(method, path, body, timeoutMs) {
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
        } else {
          fail('HTTP ' + xhr.status + ' ' + path);
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
