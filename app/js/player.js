/* player.js — fullscreen <video> player with OSD, episode strip and play-record sync (ES5 only). */
(function () {
  'use strict';

  var OSD_TIMEOUT = 4000;
  var SAVE_INTERVAL = 10000;
  var SEEK_STEP = 10;

  var video = null;
  var result = null;       /* current Result */
  var index = 0;           /* current episode index (0-based) */
  var query = '';
  var pendingSeek = 0;
  var osdTimer = null;
  var saveTimer = null;
  var active = false;
  var seekHold = { timer: null, dir: 0 };
  var osdFocus = false;    /* true while focus is in the episode strip */
  var lastSaved = { time: -1, index: -1 };

  function $(id) { return UI.$(id); }

  function episodeName(i) {
    var t = result.episodes_titles && result.episodes_titles[i];
    if (t) return UI.cleanText(t);
    return result.episodes.length > 1 ? '第' + UI.pad2(i + 1) + '集' : '';
  }

  /* ---- OSD ---- */
  function showOsd(sticky) {
    UI.addClass($('osd'), 'show');
    if (osdTimer) clearTimeout(osdTimer);
    if (!sticky) osdTimer = setTimeout(hideOsd, OSD_TIMEOUT);
  }
  function hideOsd() {
    if (osdFocus) { osdTimer = setTimeout(hideOsd, OSD_TIMEOUT); return; }
    UI.removeClass($('osd'), 'show');
  }
  function setState(msg) {
    var s = $('osd-state');
    s.textContent = msg || '';
    UI.toggleClass(s, 'show', !!msg);
  }

  function updateTime() {
    var cur = video.currentTime || 0, dur = video.duration;
    if (!isFinite(dur)) dur = 0;
    $('osd-time').textContent = UI.fmtTime(cur) + ' / ' + UI.fmtTime(dur);
    var pos = $('osd-bar').children[1], buf = $('osd-bar').children[0];
    pos.style.width = dur ? Math.min(100, 100 * cur / dur) + '%' : '0%';
    var b = 0;
    try { if (video.buffered.length) b = video.buffered.end(video.buffered.length - 1); } catch (e) { /* ignore */ }
    buf.style.width = dur ? Math.min(100, 100 * b / dur) + '%' : '0%';
  }

  function renderTitle() {
    var t = $('osd-title');
    t.children[0].textContent = result.title || '';
    var en = episodeName(index);
    t.children[1].textContent = en ? ' > ' + en : '';
  }

  function renderEps() {
    var box = $('osd-eps');
    UI.empty(box);
    UI.translate(box, 0, 0);
    for (var i = 0; i < result.episodes.length; i++) {
      var e = UI.text('div', 'ep', result.episodes.length > 1 ? String(i + 1) : '正片');
      e.setAttribute('title', episodeName(i));
      if (i === index) UI.addClass(e, 'current');
      box.appendChild(e);
    }
    UI.toggleClass($('osd-eps-wrap'), 'hidden', result.episodes.length <= 1);
  }

  function markCurrentEp() {
    var kids = $('osd-eps').children;
    for (var i = 0; i < kids.length; i++) UI.toggleClass(kids[i], 'current', i === index);
  }

  /* ---- nav zones: the strip is the only zone; ↑/↓ toggles focus into/out of it ---- */
  function zones() {
    App.setZones([{
      name: 'osd-eps',
      cols: 0,
      remember: true,
      index: index,
      getItems: function () { return UI.toArray($('osd-eps').children); },
      onFocus: function (el) { Nav.scrollX($('osd-eps'), el, 1760, 0, 0); },
      onEnter: function (el, i) { loadEpisode(i, 0); }
    }], 0);
    Nav.clearFocus();   /* no focus ring until the user presses ↑/↓ */
    osdFocus = false;
  }

  function enterStrip() {
    if (result.episodes.length <= 1) return;
    osdFocus = true;
    Nav.focusZone(0, index);
    showOsd(true);
  }
  function leaveStrip() {
    osdFocus = false;
    Nav.clearFocus();
    showOsd(false);
  }

  /* ---- records ---- */
  function saveRecord(force) {
    if (!result || !video) return;
    var cur = Math.floor(video.currentTime || 0);
    var dur = Math.floor(video.duration || 0);
    if (!force && cur === lastSaved.time && index === lastSaved.index) return;
    if (!force && cur < 3) return;
    if (!isFinite(dur)) dur = 0;
    lastSaved = { time: cur, index: index };
    var key = result.source + '+' + result.id;
    var rec = {
      title: result.title,
      source_name: result.source_name,
      cover: result.poster,
      index: index + 1,
      total_episodes: result.episodes.length,
      play_time: cur,
      total_time: dur,
      save_time: new Date().getTime(),
      year: result.year || '',
      search_title: query || result.title
    };
    App.Records.put({
      key: key, source: result.source, id: result.id, title: rec.title, poster: rec.cover, year: rec.year,
      source_name: rec.source_name, index: rec.index, total_episodes: rec.total_episodes,
      play_time: rec.play_time, total_time: rec.total_time, save_time: rec.save_time, search_title: rec.search_title
    });
    API.saveRecord(key, rec).then(null, function () { /* non-fatal */ });
  }

  function startSaveTimer() {
    stopSaveTimer();
    saveTimer = setInterval(function () { if (!video.paused && !video.ended) saveRecord(false); }, SAVE_INTERVAL);
  }
  function stopSaveTimer() { if (saveTimer) { clearInterval(saveTimer); saveTimer = null; } }

  /* ---- playback ---- */
  function loadEpisode(i, startTime) {
    if (!result.episodes[i]) return;
    if (i !== index && video.currentTime > 3) saveRecord(true);
    index = i;
    pendingSeek = startTime || 0;
    lastSaved = { time: -1, index: -1 };
    renderTitle();
    markCurrentEp();
    setState('加载中…');
    /* On the TV: native HLS via <video src>. In the desktop simulator, window.HLS_SHIM (hls.js
     * adapter injected by sim/index.html) attaches MSE playback instead. */
    if (window.HLS_SHIM && window.HLS_SHIM.attach) {
      window.HLS_SHIM.attach(video, result.episodes[i]);
    } else {
      video.src = result.episodes[i];
      try { video.load(); } catch (e) { /* ignore */ }
    }
    var p = null;
    try { p = video.play(); } catch (e2) { /* ignore */ }
    if (p && p.then) p.then(null, function () { /* autoplay may be rejected headless; ignore */ });
    if (osdFocus) { Nav.focusZone(0, index); }
    showOsd(false);
    updateTime();
  }

  function togglePlay() {
    if (video.paused || video.ended) {
      var p = null;
      try { p = video.play(); } catch (e) { /* ignore */ }
      if (p && p.then) p.then(null, function () {});
    } else {
      video.pause();
    }
    showOsd(false);
  }

  function seekBy(delta) {
    var dur = video.duration;
    var t = (video.currentTime || 0) + delta;
    if (t < 0) t = 0;
    if (isFinite(dur) && dur > 0 && t > dur - 1) t = dur - 1;
    try { video.currentTime = t; } catch (e) { /* ignore */ }
    setState((delta > 0 ? '▶▶ +' : '◀◀ −') + Math.abs(delta) + ' 秒');
    updateTime();
    showOsd(false);
  }

  function nextEpisode() {
    if (index + 1 < result.episodes.length) loadEpisode(index + 1, 0);
    else { setState('已播放完毕'); saveRecord(true); }
  }

  /* ---- video events ---- */
  function bindVideo() {
    video.addEventListener('loadedmetadata', function () {
      if (pendingSeek > 0 && pendingSeek < (video.duration || 1e9) - 5) {
        try { video.currentTime = pendingSeek; } catch (e) { /* ignore */ }
      }
      pendingSeek = 0;
      updateTime();
    }, false);
    video.addEventListener('playing', function () { setState(''); startSaveTimer(); }, false);
    video.addEventListener('waiting', function () { setState('缓冲中…'); }, false);
    video.addEventListener('pause', function () {
      if (!active) return;
      if (!video.ended) { setState('已暂停'); showOsd(true); saveRecord(true); }
    }, false);
    video.addEventListener('play', function () { setState(''); showOsd(false); }, false);
    video.addEventListener('timeupdate', function () { if (active) updateTime(); }, false);
    video.addEventListener('ended', function () { if (active) nextEpisode(); }, false);
    video.addEventListener('error', function () {
      if (!active) return;
      var code = video.error && video.error.code;
      setState('播放失败（' + (result.source_name || result.source) + '，错误 ' + (code || '?') + '）\n按返回键退出，可在详情页换源');
      showOsd(true);
      stopSaveTimer();
    }, false);
  }

  /* ---- key handling ---- */
  function startSeekHold(dir) {
    seekBy(dir * SEEK_STEP);
    if (seekHold.timer) return;
    seekHold.dir = dir;
    seekHold.timer = setInterval(function () { seekBy(seekHold.dir * SEEK_STEP); }, 400);
  }
  function stopSeekHold() {
    if (seekHold.timer) { clearInterval(seekHold.timer); seekHold.timer = null; }
  }

  function onKey(code, e) {
    if (!active) return false;
    if (code !== 37 && code !== 39) stopSeekHold();
    if (osdFocus) {
      switch (code) {
        case 37: case 39: case 13: showOsd(true); return Nav.handleKey(code);
        case 38: case 40: leaveStrip(); return true;
        case 461: case 27: leaveStrip(); return true;
      }
    }
    showOsd(false);
    switch (code) {
      case 13: togglePlay(); return true;
      case 37: if (e && e.repeat) { seekBy(-SEEK_STEP); } else { startSeekHold(-1); } return true;
      case 39: if (e && e.repeat) { seekBy(SEEK_STEP); } else { startSeekHold(1); } return true;
      case 38: case 40: enterStrip(); return true;
      case 415: if (video.paused) togglePlay(); return true;           /* Play */
      case 19: if (!video.paused) togglePlay(); return true;           /* Pause */
      case 10252: togglePlay(); return true;                           /* Play/Pause */
      case 413: video.pause(); saveRecord(true); App.back(); return true; /* Stop */
      case 417: seekBy(60); return true;                               /* FF */
      case 412: seekBy(-60); return true;                              /* RW */
      case 461: case 27: App.back(); return true;
    }
    return false;
  }

  function onKeyUp(e) {
    var code = e.keyCode || e.which;
    if (code === 37 || code === 39) stopSeekHold();
  }

  App.register('player', {
    enter: function (params) {
      if (!video) { video = $('video'); bindVideo(); document.addEventListener('keyup', onKeyUp, false); }
      active = true;
      result = params.result;
      query = params.query || '';
      index = params.index || 0;
      renderTitle();
      renderEps();
      zones();
      loadEpisode(index, params.startTime || 0);
    },
    leave: function () {
      active = false;
      stopSeekHold();
      stopSaveTimer();
      if (video) {
        if (video.currentTime > 3) saveRecord(true);
        try { video.pause(); } catch (e) { /* ignore */ }
        video.removeAttribute('src');
        try { video.load(); } catch (e2) { /* ignore */ }
      }
      setState('');
      UI.removeClass($('osd'), 'show');
      osdFocus = false;
    },
    key: onKey
  });
})();
