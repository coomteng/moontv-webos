/* detail.js — detail view: poster, info, source chips, episode grid, resume button (ES5 only). */
(function () {
  'use strict';

  var EP_COLS = 10;

  var sources = [];       /* [Result] */
  var cur = null;         /* selected Result */
  var query = '';
  var title = '';
  var record = null;      /* play record matching this title, if any */
  var epIndex = 0;
  var probes = {};        /* source key -> probe result */
  var probing = false;
  var userPicked = false; /* user chose a source explicitly: don't auto-switch after probe */
  var probeSeq = 0;
  var actionIndex = 0;
  var expanding = false;  /* background search to add the other sources (single-source entry) */
  var expandSeq = 0;    /* focused button in the actions row (继续观看 / 重新测速), kept across re-renders */

  function $(id) { return UI.$(id); }

  function episodeCount(r) { return (r && r.episodes) ? r.episodes.length : 0; }

  function pickDefault(list, preferSource) {
    var best = null;
    for (var i = 0; i < list.length; i++) {
      if (preferSource && list[i].source === preferSource && episodeCount(list[i]) > 0) return list[i];
    }
    for (var j = 0; j < list.length; j++) {
      if (!best || episodeCount(list[j]) > episodeCount(best)) best = list[j];
    }
    return best;
  }

  /* ---- stream quality probe ---- */
  function fmtSpeed(kbps) {
    if (!kbps) return '';
    return kbps >= 1000 ? (kbps / 1000).toFixed(1) + ' Mbps' : kbps + ' kbps';
  }

  function fmtRes(res) {
    if (!res) return '';
    var h = parseInt(res.split('x')[1], 10);
    if (h >= 2000) return '4K';
    if (h >= 1000) return '1080p';
    if (h >= 700) return '720p';
    if (h >= 500) return '540p';
    return h + 'p';
  }

  /* higher is better; unknown/failed sort last */
  function score(s) {
    var p = probes[s.source];
    if (!p) return -1;
    if (!p.ok) return -2;
    var h = p.resolution ? parseInt(p.resolution.split('x')[1], 10) : 0;
    return (h || 300) * 1000 + Math.min(p.speed_kbps || 0, 50000);
  }

  function sortSources() {
    sources.sort(function (a, b) {
      var d = score(b) - score(a);
      if (d !== 0) return d;
      return episodeCount(b) - episodeCount(a);
    });
  }

  function probeAll(epIdx, fresh) {
    var items = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var n = episodeCount(s);
      if (!n) continue;
      items.push({ source: s.source, source_name: s.source_name, url: s.episodes[Math.min(epIdx, n - 1)] });
    }
    if (!items.length) return;
    var seq = ++probeSeq;
    probing = true;
    probes = {};
    renderSources();
    renderActions();
    /* both renders replace their DOM nodes; re-seat the focus if it was on one of them */
    var zoneAtStart = App.zoneName ? App.zoneName() : null;
    if (zoneAtStart === 'actions' || zoneAtStart === 'sources') zones(zoneAtStart);
    API.probe(items, fresh).then(function (res) {
      if (seq !== probeSeq) return;          /* view changed meanwhile */
      probing = false;
      for (var j = 0; j < res.length; j++) probes[res[j].source] = res[j];
      var zoneNow = App.zoneName ? App.zoneName() : null;
      var focusWasSources = zoneNow === 'sources';
      var focusWasActions = zoneNow === 'actions';
      sortSources();
      /* auto-pick the best source unless the user already chose one, or is resuming a record
         on a source that is still alive */
      var curProbe = cur ? probes[cur.source] : null;
      var keepForResume = record && cur && record.source === cur.source && !(curProbe && !curProbe.ok);
      if (!userPicked && !keepForResume) {
        var best = sources[0];
        if (best && probes[best.source] && probes[best.source].ok && best !== cur) {
          if (record && cur && record.source === cur.source) UI.toast('上次观看的源已失效，已切换到 ' + (best.source_name || best.source));
          cur = best;
          epIndex = Math.min(epIndex, episodeCount(cur) - 1);
          renderInfo();
          renderEpisodes();
        }
      }
      renderSources();
      renderActions();
      zones(focusWasSources ? 'sources' : (focusWasActions ? 'actions' : (zoneNow || 'episodes')));
      if (fresh) UI.toast('测速完成，已按画质和速度重新排序');
    }, function (err) {
      if (seq !== probeSeq) return;
      probing = false;
      renderSources();
      renderActions();
      if (fresh) UI.toast('测速失败：' + (err && err.message ? err.message : '网络错误'));
    });
  }

  /* Re-measure every source for the current episode, bypassing the bridge's 15-min probe cache.
     Used by the 重新测速 button and the yellow remote key. */
  function reprobe() {
    if (!anyPlayable()) { UI.toast('没有可播放的源'); return; }
    if (probing || expanding) { UI.toast('正在测速中…'); return; }
    userPicked = false;
    probeAll(epIndex, true);
  }

  function anyPlayable() {
    for (var i = 0; i < sources.length; i++) if (episodeCount(sources[i])) return true;
    return false;
  }

  /* Entered with a single source (继续观看 from the home row only knows the source the record was
     made on): search the title in the background and merge the other sources in, so 换源 and
     测速 work here too. The current source and episode stay selected. */
  function expandSources() {
    if (expanding || !query) return;
    var seq = ++expandSeq;
    expanding = true;
    renderActions();
    API.search(query).then(function (res) {
      if (seq !== expandSeq) return;
      expanding = false;
      var g = null;
      for (var i = 0; i < (res || []).length && !g; i++) {
        var cand = res[i];
        if (!cand || !cand.sources) continue;
        for (var j = 0; j < cand.sources.length; j++) {
          var c = cand.sources[j];
          if (cur && c.source === cur.source && String(c.id) === String(cur.id)) { g = cand; break; }
        }
      }
      if (!g) { renderActions(); return; }
      var merged = [];
      for (var k = 0; k < g.sources.length; k++) {
        var sx = g.sources[k];
        if (cur && sx.source === cur.source && String(sx.id) === String(cur.id)) merged.push(cur);
        else merged.push(sx);
      }
      sources = merged;
      renderSources();
      renderActions();
      zones(App.zoneName ? App.zoneName() : 'episodes');
      if (sources.length > 1) probeAll(epIndex);
    }, function () {
      if (seq !== expandSeq) return;
      expanding = false;
      renderActions();
    });
  }

  function epTitle(r, i) {
    var t = r.episodes_titles && r.episodes_titles[i];
    if (t) return UI.cleanText(t);
    return episodeCount(r) > 1 ? '第' + UI.pad2(i + 1) + '集' : '正片';
  }

  /* ---- render ---- */
  function renderInfo() {
    var r = cur || sources[0] || {};
    $('detail-title').textContent = title || r.title || '';
    var meta = [];
    if (r.year) meta.push(r.year);
    if (r.type_name) meta.push(r.type_name);
    if (r['class']) meta.push(r['class']);
    if (r.source_name) meta.push('来源：' + r.source_name);
    $('detail-meta').textContent = meta.join(' · ');
    $('detail-desc').textContent = UI.cleanText(r.desc) || '暂无简介';
    var p = r.poster ? 'url("' + API.poster(r.poster) + '")' : 'none';
    $('detail-poster').style.backgroundImage = p;
    $('detail-bg').style.backgroundImage = p;
  }

  function renderActions() {
    var box = $('detail-actions');
    UI.empty(box);
    if (record && record.index) {
      var b = UI.text('div', 'btn resume', '继续观看 第' + record.index + '集' +
        (record.play_time ? '  ' + UI.fmtTime(record.play_time) : ''));
      b.setAttribute('data-action', 'resume');
      box.appendChild(b);
    }
    if (anyPlayable()) {
      var r = UI.text('div', 'btn reprobe', probing ? '测速中…' : (expanding ? '查找其它源…' : '重新测速'));
      r.setAttribute('data-action', 'reprobe');
      if (probing) UI.addClass(r, 'busy');
      box.appendChild(r);
    }
  }

  function onAction(el) {
    var a = el && el.getAttribute('data-action');
    if (a === 'resume') resume();
    else if (a === 'reprobe') reprobe();
  }

  function renderSources() {
    var box = $('detail-sources');
    UI.empty(box);
    var okCount = 0, done = 0;
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      var label = (s.source_name || s.source) + (episodeCount(s) > 1 ? ' · ' + episodeCount(s) + '集' : '');
      var p = probes[s.source];
      var c = UI.text('div', 'chip', label);
      if (p) {
        done++;
        var q = document.createElement('span');
        q.className = 'quality';
        if (p.ok) {
          okCount++;
          var parts = [];
          if (p.resolution) parts.push(fmtRes(p.resolution));
          if (p.speed_kbps) parts.push(fmtSpeed(p.speed_kbps));
          q.textContent = parts.join(' ') || '可用';
          if ((p.speed_kbps || 0) >= 4000) UI.addClass(c, 'fast');
          else if ((p.speed_kbps || 0) < 1500) UI.addClass(c, 'slow');
        } else {
          q.textContent = '不可用';
          UI.addClass(c, 'dead');
        }
        c.appendChild(q);
      } else if (probing && episodeCount(s)) {
        var w = document.createElement('span');
        w.className = 'quality';
        w.textContent = '测速中…';
        c.appendChild(w);
      }
      if (!episodeCount(s)) UI.addClass(c, 'disabled');
      if (s === cur) UI.addClass(c, 'current');
      box.appendChild(c);
    }
    var t = $('detail-sources-title');
    if (t) {
      t.textContent = '换源（' + sources.length + '）' +
        (probing ? '  测速中…' : (done ? '  可用 ' + okCount + '/' + done + (sources.length > 1 ? '，已按画质和速度排序' : '') : '')) +
        (expanding ? '  正在查找其它源…' : '');
    }
  }

  function renderEpisodes() {
    var box = $('detail-episodes');
    UI.empty(box);
    UI.translate(box, 0, 0);
    var n = episodeCount(cur);
    $('detail-ep-title').textContent = n ? '选集（' + n + '）' : '选集（该源暂无剧集）';
    for (var i = 0; i < n; i++) {
      var e = UI.text('div', 'ep', epTitle(cur, i));
      if (record && record.source === cur.source && String(record.id) === String(cur.id) && record.index === i + 1) UI.addClass(e, 'current');
      box.appendChild(e);
    }
  }

  function zones(startName) {
    var z = [];
    z.push({
      name: 'actions',
      cols: 0,
      remember: true,
      index: actionIndex,
      disabled: function () { return !$('detail-actions').children.length; },
      onFocus: function (el, i) { actionIndex = i; },
      getItems: function () { return UI.toArray($('detail-actions').children); },
      onEnter: function (el) { onAction(el); }
    });
    z.push({
      name: 'sources',
      flow: true,
      remember: true,
      index: Math.max(0, indexOf(sources, cur)),
      getItems: function () { return UI.toArray($('detail-sources').children); },
      onFocus: function (el) { Nav.scrollY($('detail-sources'), el, $('detail-sources-wrap').clientHeight, 0, 0); },
      onEnter: function (el, i) { selectSource(i); }
    });
    z.push({
      name: 'episodes',
      cols: EP_COLS,
      remember: true,
      index: epIndex,
      disabled: function () { return !episodeCount(cur); },
      getItems: function () { return UI.toArray($('detail-episodes').children); },
      onFocus: function (el, i) {
        epIndex = i;
        Nav.scrollY($('detail-episodes'), el, $('detail-episodes-wrap').clientHeight, 0, 0);
      },
      onEnter: function (el, i) { play(i, 0); }
    });
    var start = 2;
    for (var k = 0; k < z.length; k++) if (z[k].name === startName) start = k;
    App.setZones(z, start);
  }

  function indexOf(list, item) { for (var i = 0; i < list.length; i++) if (list[i] === item) return i; return -1; }

  /* ---- actions ---- */
  function selectSource(i) {
    var s = sources[i];
    if (!s) return;
    if (!episodeCount(s)) { UI.toast('该源没有可播放的剧集'); return; }
    var p = probes[s.source];
    if (p && !p.ok) UI.toast('该源测速失败（' + (p.error || '不可用') + '），可能无法播放');
    userPicked = true;
    cur = s;
    epIndex = Math.min(epIndex, episodeCount(cur) - 1);
    renderInfo();
    renderSources();
    renderEpisodes();
    zones('sources');
  }

  function play(i, startTime) {
    if (!cur || !episodeCount(cur)) { UI.toast('没有可播放的剧集'); return; }
    App.go('player', { result: cur, index: i, startTime: startTime || 0, query: query });
  }

  function resume() {
    if (!record) return;
    /* prefer the source the record was made on */
    var same = null;
    for (var i = 0; i < sources.length; i++) {
      if (sources[i].source === record.source && episodeCount(sources[i])) { same = sources[i]; break; }
    }
    if (same && same !== cur) { cur = same; renderInfo(); renderSources(); renderEpisodes(); }
    var idx = Math.max(0, Math.min((record.index || 1) - 1, episodeCount(cur) - 1));
    play(idx, record.play_time || 0);
  }

  App.register('detail', {
    enter: function (params, isBack) {
      if (!isBack) {
        if (params.group) {
          sources = params.group.sources.slice();
          title = params.group.title;
        } else {
          sources = [params.result];
          title = params.result.title;
        }
        query = params.query || title;
        record = App.Records.findByTitle(title);
        cur = pickDefault(sources, record && record.source);
        epIndex = 0;
        userPicked = false;
        probes = {};
        actionIndex = 0;
        if (record && cur && record.source === cur.source && record.index) epIndex = Math.min(record.index - 1, episodeCount(cur) - 1);
      } else {
        /* back from the player: refresh the record / 当前 marker */
        record = App.Records.findByTitle(title) || record;
        if (record && cur && record.source === cur.source && String(record.id) === String(cur.id) && record.index) {
          epIndex = Math.max(0, Math.min(record.index - 1, episodeCount(cur) - 1));
        }
      }
      renderInfo();
      renderActions();
      renderSources();
      renderEpisodes();
      zones(isBack ? 'episodes' : (episodeCount(cur) ? 'episodes' : 'sources'));
      if (!isBack && anyPlayable()) probeAll(epIndex);
      /* also on the way back from the player: the home 继续观看 card goes detail → player at once,
         so the expansion started on the first enter was cancelled by leave() */
      if (sources.length === 1) expandSources();
    },
    leave: function () { probeSeq++; probing = false; expandSeq++; expanding = false; },
    /* Yellow key: re-run the probe (e.g. after a source started stuttering) */
    key: function (code) {
      if (code === 405) { reprobe(); return true; }
      return false;
    }
  });
})();
