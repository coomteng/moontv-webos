/* player.js — fullscreen <video> player with OSD, episode strip and play-record sync (ES5 only). */
(function () {
  'use strict';

  var OSD_TIMEOUT = 4000;
  var SAVE_INTERVAL = 10000;
  var SEEK_STEP = 10;
  /* webOS native HLS buffer depth (seconds) via the `mediaOption` JSON in the <source type> attribute
   * (LG mediaOption mechanism; bufferControl keys from webosose/g-media-pipeline PlayerTypes.h;
   * preBufferTime < 3 falls back to the default). null = platform default (plain <video src>).
   * 2.8.0 shipped { pre: 4, min: 4, max: 60 }: steady-state buffer-ahead ~28 s on a webOS 5 projector,
   * but +10 s seeks felt slower on slow sources (resume waits for bufferingMinTime; the connection is
   * never idle), and an A/B could not show a benefit — so it is off until measured properly. */
  var BUFFER = null;
  var HLS_MIME = 'application/vnd.apple.mpegurl';

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
  /* 跳过片头片尾 (web: ArtPlayer settings, stored per source+id in /skip as seconds) */
  var skip = { enable: false, intro_time: 0, outro_time: 0 };
  var skipSeq = 0;
  var introDone = false;   /* intro seek applied for the current episode */
  var outroDone = false;   /* outro auto-next fired for the current episode */
  var skipSaving = false;
  var plainFallback = false; /* true once the current episode was retried without mediaOption */

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

  /* ---- skip intro / outro ---- */
  function skipKey() { return result ? result.source + '+' + result.id : ''; }

  function loadSkip() {
    var seq = ++skipSeq;
    skip = { enable: false, intro_time: 0, outro_time: 0 };
    API.skipConfig(skipKey()).then(function (cfg) {
      if (seq !== skipSeq || !active) return;
      cfg = cfg || {};
      skip = { enable: !!cfg.enable, intro_time: Number(cfg.intro_time) || 0, outro_time: Number(cfg.outro_time) || 0 };
      /* config arrived after loadedmetadata: apply the intro skip now if still at the start */
      maybeSkipIntro();
    }, function () { /* non-fatal: no skipping */ });
  }

  function maybeSkipIntro() {
    if (introDone || !active || !video) return;
    if (!skip.enable || !(skip.intro_time > 0)) return;
    if (!video.duration || !isFinite(video.duration) || video.readyState < 1) return;
    if (pendingSeek > 0) { introDone = true; return; }       /* resuming: never jump */
    /* only at the very start of the episode (the config may arrive a moment after loadedmetadata) */
    if ((video.currentTime || 0) > 5 || skip.intro_time >= video.duration - 5) { introDone = true; return; }
    introDone = true;
    try { video.currentTime = skip.intro_time; } catch (e) { /* ignore */ }
    UI.toast('已跳过片头');
    updateTime();
  }

  function maybeSkipOutro() {
    if (outroDone || !skip.enable || !(skip.outro_time > 0)) return;
    var dur = video.duration;
    if (!dur || !isFinite(dur)) return;
    if ((video.currentTime || 0) >= dur - skip.outro_time) {
      outroDone = true;
      UI.toast('已跳过片尾');
      nextEpisode();
    }
  }

  function saveSkip(cfg) {
    if (skipSaving) { UI.toast('正在保存…'); return; }
    var key = skipKey();
    if (!key) return;
    var next = { enable: !!(cfg.intro_time > 0 || cfg.outro_time > 0), intro_time: cfg.intro_time, outro_time: cfg.outro_time };
    skipSaving = true;
    API.saveSkipConfig(key, next).then(function () {
      skipSaving = false;
      skip = next;
      var parts = [];
      if (next.intro_time > 0) parts.push('片头 ' + UI.fmtTime(next.intro_time));
      if (next.outro_time > 0) parts.push('片尾前 ' + UI.fmtTime(next.outro_time));
      UI.toast(next.enable ? '已保存：' + parts.join('，') : '已关闭跳过片头片尾');
    }, function (err) {
      skipSaving = false;
      App.errorToast(err, '保存失败');
    });
  }

  /* YELLOW: 设置片头 = current position is where the intro ends */
  function setIntroHere() {
    var t = Math.floor(video.currentTime || 0);
    if (t === skip.intro_time && skip.enable) return;
    saveSkip({ intro_time: t, outro_time: skip.outro_time });
    showOsd(false);
  }

  /* BLUE: 设置片尾 = seconds before the end from the current position */
  function setOutroHere() {
    var dur = video.duration;
    if (!dur || !isFinite(dur)) { UI.toast('时长未知，无法设置片尾'); return; }
    var t = Math.floor(dur - (video.currentTime || 0));
    if (t < 0) t = 0;
    outroDone = true;      /* we are at the new outro point: do not cut this episode short right away */
    saveSkip({ intro_time: skip.intro_time, outro_time: t });
    showOsd(false);
  }

  /* ---- playback ---- */
  function loadEpisode(i, startTime) {
    if (!result.episodes[i]) return;
    if (i !== index && video.currentTime > 3) saveRecord(true);
    index = i;
    pendingSeek = startTime || 0;
    introDone = false;
    outroDone = false;
    lastSaved = { time: -1, index: -1 };
    renderTitle();
    markCurrentEp();
    setState('加载中…');
    /* On the TV: native HLS via <video src>. In the desktop simulator, window.HLS_SHIM (hls.js
     * adapter injected by sim/index.html) attaches MSE playback instead. */
    plainFallback = false;
    if (window.HLS_SHIM && window.HLS_SHIM.attach) {
      window.HLS_SHIM.attach(video, result.episodes[i]);
    } else {
      attachNative(result.episodes[i], !BUFFER);
    }
    startPlay();
    if (osdFocus) { Nav.focusZone(0, index); }
    showOsd(false);
    updateTime();
  }

  function startPlay() {
    var p = null;
    try { p = video.play(); } catch (e) { /* ignore */ }
    if (p && p.then) p.then(null, function () { /* autoplay may be rejected headless; ignore */ });
  }

  function clearSources() {
    var s;
    while ((s = video.querySelector('source'))) video.removeChild(s);
    video.removeAttribute('src');
  }

  /* Native playback. plain=false: <source> with mediaOption (deeper buffer); plain=true: bare src. */
  function attachNative(url, plain) {
    clearSources();
    if (plain) {
      video.src = url;
    } else {
      var opt = { mediaTransportType: 'HLS', option: { bufferControl: {
        userBufferCtrl: true, preBufferTime: BUFFER.pre,
        bufferingMinTime: BUFFER.min, bufferingMaxTime: BUFFER.max } } };
      var src = document.createElement('source');
      src.setAttribute('src', url);
      src.setAttribute('type', HLS_MIME + ';mediaOption=' + encodeURIComponent(JSON.stringify(opt)));
      /* An unsupported type / failed fetch of a <source> child fires `error` on the <source>, not
       * on the <video> (video.error stays null), so listen here too. */
      src.addEventListener('error', function () { if (active) retryPlain(); }, false);
      video.appendChild(src);
    }
    try { video.load(); } catch (e) { /* ignore */ }
  }

  /* The mediaOption source was refused: retry once the old way (plain src, default buffer). */
  function retryPlain() {
    if (plainFallback || window.HLS_SHIM) return false;
    plainFallback = true;
    if (video.currentTime > 3) pendingSeek = video.currentTime; /* mid-stream failure: resume where we were */
    attachNative(result.episodes[index], true);
    startPlay();
    return true;
  }

  /* ---- Magic Remote: pointer on the player ----
   * moving the pointer shows the OSD; click on the video toggles play/pause; click on the progress
   * bar seeks to that position; the episode strip is a Nav zone so hover/click work there already;
   * wheel = seek ±10 s. */
  function bindPointer() {
    var osd = $('osd');
    document.getElementById('player').addEventListener('mousemove', function () {
      if (!active) return;
      showOsd(false);
    }, false);
    video.addEventListener('click', function (e) {
      if (!active) return;
      e.preventDefault();
      togglePlay();
    }, false);
    $('osd-state').addEventListener('click', function (e) { if (active) { e.preventDefault(); togglePlay(); } }, false);
    $('osd-bar').addEventListener('click', function (e) {
      if (!active || !isFinite(video.duration) || !video.duration) return;
      e.preventDefault();
      e.stopPropagation();
      var r = this.getBoundingClientRect();
      var frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      video.currentTime = frac * video.duration;
      updateTime();
      showOsd(false);
    }, false);
    osd.addEventListener('wheel', function (e) {
      if (!active) return;
      e.preventDefault();
      e.stopPropagation();
      seekBy((e.deltaY || 0) > 0 ? 10 : -10);
    }, { passive: false });
    document.getElementById('player').addEventListener('wheel', function (e) {
      if (!active) return;
      e.preventDefault();
      e.stopPropagation();
      seekBy((e.deltaY || 0) > 0 ? 10 : -10);
    }, { passive: false });
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
        introDone = true;              /* resuming a record: do not jump to the intro end */
      }
      pendingSeek = 0;
      updateTime();
      maybeSkipIntro();
    }, false);
    video.addEventListener('playing', function () { setState(''); startSaveTimer(); }, false);
    video.addEventListener('waiting', function () { setState('缓冲中…'); }, false);
    video.addEventListener('pause', function () {
      if (!active) return;
      if (!video.ended) { setState('已暂停'); showOsd(true); saveRecord(true); }
    }, false);
    video.addEventListener('play', function () { setState(''); showOsd(false); }, false);
    video.addEventListener('timeupdate', function () { if (active) { updateTime(); maybeSkipOutro(); } }, false);
    video.addEventListener('ended', function () { if (active) nextEpisode(); }, false);
    video.addEventListener('error', function () {
      if (!active) return;
      var code = video.error && video.error.code;
      if (video.querySelector('source') && retryPlain()) return;
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
      case 405: setIntroHere(); return true;                           /* Yellow: 设为片头结束点 */
      case 406: setOutroHere(); return true;                           /* Blue: 设为片尾开始点 */
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
      if (!video) { video = $('video'); bindVideo(); bindPointer(); document.addEventListener('keyup', onKeyUp, false); }
      active = true;
      result = params.result;
      query = params.query || '';
      index = params.index || 0;
      renderTitle();
      renderEps();
      zones();
      loadSkip();
      loadEpisode(index, params.startTime || 0);
    },
    leave: function () {
      active = false;
      skipSeq++;
      skipSaving = false;
      stopSeekHold();
      stopSaveTimer();
      if (video) {
        if (video.currentTime > 3) saveRecord(true);
        try { video.pause(); } catch (e) { /* ignore */ }
        clearSources();
        try { video.load(); } catch (e2) { /* ignore */ }
      }
      setState('');
      UI.removeClass($('osd'), 'show');
      osdFocus = false;
    },
    key: onKey
  });
})();
