/* ime.js — on-screen pinyin keyboard for the remote control (ES5 only).
 *
 * The TV's system keyboard has no Chinese on EU models, so the search view opens
 * this overlay instead. Layout:
 *
 *   [ text being composed            ]   ← committed text + pinyin buffer
 *   [ candidate strip (←/→ to scroll) ]   ← Chinese candidates for the buffer
 *   [ q w e r t y u i o p  ]  [ 1 2 3 ]
 *   [ a s d f g h j k l    ]  [ 4 5 6 ]
 *   [ z x c v b n m        ]  [ 7 8 9 ]
 *   [ 中/EN  空格  删除  清空  0  搜索 ]
 *
 * Data: PINYIN_DATA (full pinyin → words/chars) and PINYIN_INITIALS (initials → words)
 * from pinyin-data.js. Candidate lookup for a buffer like "lanxiang":
 *   1. exact full-pinyin match ("lanxiang")
 *   2. initials match if buffer has no vowels ("lxrg")
 *   3. longest prefix that matches ("lan" → 兰…), leaving the rest in the buffer
 * Selecting a candidate commits it and consumes the matched part of the buffer.
 *
 * Public API: IME.open({value, onChange, onSubmit, onClose}), IME.close(), IME.isOpen(), IME.handleKey(code)
 */
var IME = (function () {
  'use strict';

  var ROWS = [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '1', '2', '3'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '4', '5', '6'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', '7', '8', '9'],
    ['MODE', 'SPACE', 'DEL', 'CLEAR', '0', 'GO']
  ];
  var LABELS = { MODE: '中/EN', SPACE: '空格', DEL: '删除', CLEAR: '清空', GO: '确认' };
  var goLabel = LABELS.GO;   /* per-open: '搜索' in the search view, '确认' elsewhere */
  var MAX_CANDS = 10;

  var open = false;
  var chinese = true;
  var text = '';        /* committed text */
  var buf = '';         /* pinyin buffer (Chinese mode only) */
  var cands = [];       /* [{word, consume}] */
  var candPage = 0;
  var focusRow = 0;     /* -1 = candidate strip, 0..3 = key rows */
  var focusCol = 0;
  var candIdx = 0;
  var cb = {};
  var root, keysEl, candsEl, textEl, bufEl, pageEl;

  /* ---- phone-as-keyboard: a channel on the bridge, shown as a QR code next to the keys.
   * The id is kept in localStorage so the phone's bookmarked page keeps working across sessions. */
  var remoteId = '';
  var remoteSeq = 0;
  var remoteUrl = '';
  var polling = false;
  var pollGen = 0;

  function remoteStart() {
    var saved = '';
    try { saved = window.localStorage.getItem('moontv.remoteId') || ''; } catch (e) { /* ignore */ }
    API.remoteNew(saved).then(function (r) {
      if (!r || !r.id) return;
      remoteId = r.id; remoteSeq = r.seq || 0; remoteUrl = r.url || '';
      try { window.localStorage.setItem('moontv.remoteId', remoteId); } catch (e2) { /* ignore */ }
      renderRemote();
      remoteState();
      pollLoop(++pollGen);
    }, function () { remoteId = ''; renderRemote(); });
  }

  function remoteState() {
    if (!remoteId) return;
    API.remoteState(remoteId, { open: open, label: goLabel, value: open ? (text + buf) : '' });
  }

  function pollLoop(gen) {
    if (!open || gen !== pollGen || !remoteId) { polling = false; return; }
    polling = true;
    API.remotePoll(remoteId, remoteSeq).then(function (r) {
      if (!open || gen !== pollGen) { polling = false; return; }
      if (r && r.messages) {
        for (var i = 0; i < r.messages.length; i++) applyRemote(r.messages[i]);
        if (r.seq) remoteSeq = r.seq;
      }
      pollLoop(gen);
    }, function () {
      if (!open || gen !== pollGen) { polling = false; return; }
      setTimeout(function () { pollLoop(gen); }, 3000);   /* bridge hiccup: retry */
    });
  }

  function applyRemote(m) {
    var v = String(m.text || '');
    buf = '';
    text = v;
    recompute();
    notify();
    render();
    if (m.action === 'submit') submit();
    else UI.toast('已收到手机输入');
  }

  function renderRemote() {
    var box = $('ime-remote');
    if (!box) return;
    var img = $('ime-qr');
    if (remoteId) {
      img.src = API.remoteQr(remoteId) + '?v=' + remoteId;
      UI.removeClass(box, 'hidden');
      $('ime-remote-url').textContent = remoteUrl.replace(/^https?:\/\//, '');
    } else {
      UI.addClass(box, 'hidden');
    }
  }

  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------- data */
  /* Live title index from the bridge (/titles): {full:{py:[title]}, initials:{py:[title]}}.
   * Refreshed on app start and every hour; merged with top priority so new shows are typeable
   * without re-installing the app. */
  var live = { full: {}, initials: {} };
  var liveKeys = [];
  function setLive(data) {
    if (!data || !data.full) return;
    live = data;
    liveKeys = [];
    for (var k in live.full) if (live.full.hasOwnProperty(k)) liveKeys.push(k);
    liveKeys.sort();
  }
  function refreshLive() {
    if (typeof API === 'undefined' || !API.titles) return;
    API.titles().then(setLive, function () { /* offline: keep whatever we have */ });
  }

  /* Keys of PINYIN_DATA with >= 2 syllables (approx: length >= 4), sorted, for prefix completion.
   * Built once; lets "lanxiang" surface 兰香如故 (key "lanxiangrugu") before single chars. */
  var longKeys = null;
  function buildLongKeys() {
    longKeys = [];
    for (var k in PINYIN_DATA) if (PINYIN_DATA.hasOwnProperty(k) && k.length >= 4) longKeys.push(k);
    longKeys.sort();
  }
  function lowerBound(arr, x) {
    var lo = 0, hi = arr.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function lookup(b) {
    var out = [], seen = {}, i, w;
    function push(list, consume, limit) {
      for (i = 0; list && i < list.length && (!limit || i < limit); i++) {
        w = list[i];
        if (!seen[w]) { seen[w] = 1; out.push({ word: w, consume: consume }); }
      }
    }
    if (!b) return out;
    if (!longKeys) buildLongKeys();

    /* 0. live titles: exact, initials, then prefix completion (highest priority) */
    push(live.full[b], b.length);
    if (!/[aeiouv]/.test(b) && b.length >= 2) push(live.initials[b], b.length);
    if (b.length >= 3) {
      var lf = lowerBound(liveKeys, b), ladded = 0;
      for (var lj = lf; lj < liveKeys.length && liveKeys[lj].indexOf(b) === 0 && ladded < 4; lj++) {
        var lbefore = out.length;
        push(live.full[liveKeys[lj]], b.length, 2);
        ladded += out.length - lbefore;
      }
    }

    /* 1. exact full pinyin / initials */
    push(PINYIN_DATA[b], b.length);
    if (!/[aeiouv]/.test(b) && b.length >= 2) push(PINYIN_INITIALS[b], b.length);

    /* 2. longer keys that start with the buffer (completion): the whole word is committed and the
       buffer fully consumed. Limited so single-char candidates stay reachable. */
    if (b.length >= 3) {
      var from = lowerBound(longKeys, b), added = 0;
      for (var j = from; j < longKeys.length && longKeys[j].indexOf(b) === 0 && added < 6; j++) {
        var before = out.length;
        push(PINYIN_DATA[longKeys[j]], b.length, 2);
        added += out.length - before;
      }
    }

    /* 3. longest matching prefix ("lanx" still shows 兰/蓝 while the user keeps typing) */
    for (var n = b.length - 1; n >= 1 && out.length < MAX_CANDS * 3; n--) {
      var p = b.slice(0, n);
      if (PINYIN_DATA[p]) push(PINYIN_DATA[p], n);
    }
    return out;
  }

  function recompute() {
    cands = chinese ? lookup(buf) : [];
    candPage = 0;
    candIdx = 0;
  }

  /* ---------------------------------------------------------------- render */
  function build() {
    root = $('ime');
    keysEl = $('ime-keys');
    candsEl = $('ime-cands');
    textEl = $('ime-text');
    bufEl = $('ime-buf');
    pageEl = $('ime-cands-page');
    UI.empty(keysEl);
    for (var r = 0; r < ROWS.length; r++) {
      var rowEl = UI.el('div', 'ime-row');
      for (var c = 0; c < ROWS[r].length; c++) {
        var k = ROWS[r][c];
        var el = UI.text('div', 'ime-key' + (LABELS[k] ? ' fn ' + k.toLowerCase() : ''), LABELS[k] || k);
        el.setAttribute('data-k', k);
        rowEl.appendChild(el);
      }
      keysEl.appendChild(rowEl);
    }
  }

  function keyEl(r, c) {
    var row = keysEl.children[r];
    return row ? row.children[c] : null;
  }

  function render() {
    textEl.textContent = text;
    bufEl.textContent = buf;
    UI.toggleClass(root, 'en', !chinese);
    var modeKey = keyEl(3, 0);
    if (modeKey) modeKey.textContent = chinese ? '中' : 'EN';
    var goKey = keyEl(3, 5);
    if (goKey) goKey.textContent = goLabel;
    var hint = $('ime-hint');
    if (hint) hint.textContent = '数字键 选字 · 绿键 首选 · 红键 删除 · 黄键 中/EN · 蓝键 ' + goLabel + ' · 返回 删除/关闭';
    var placeholder = $('ime-placeholder');
    if (placeholder) UI.toggleClass(placeholder, 'hidden', !!(text || buf));

    /* candidates */
    UI.empty(candsEl);
    var start = candPage * MAX_CANDS;
    var page = cands.slice(start, start + MAX_CANDS);
    for (var i = 0; i < page.length; i++) {
      var ce = UI.text('div', 'ime-cand', (i + 1 === 10 ? 0 : i + 1) + ' ' + page[i].word);
      if (focusRow === -1 && i === candIdx) UI.addClass(ce, 'focus');
      candsEl.appendChild(ce);
    }
    var pages = Math.ceil(cands.length / MAX_CANDS);
    pageEl.textContent = pages > 1 ? (candPage + 1) + '/' + pages : '';
    UI.toggleClass($('ime-cands-wrap'), 'empty', !cands.length);

    /* key focus */
    var all = keysEl.querySelectorAll('.ime-key');
    for (var j = 0; j < all.length; j++) UI.removeClass(all[j], 'focus');
    if (focusRow >= 0) {
      var fe = keyEl(focusRow, focusCol);
      if (fe) UI.addClass(fe, 'focus');
    }
  }

  function notify() { if (cb.onChange) cb.onChange(text + buf); }

  /* ---------------------------------------------------------------- actions */
  function commitCand(i) {
    var c = cands[candPage * MAX_CANDS + i];
    if (!c) return;
    text += c.word;
    buf = buf.slice(c.consume);
    recompute();
    if (!buf) focusRow = Math.max(focusRow, 0);
    notify();
    render();
  }

  function typeChar(ch) {
    if (chinese && /^[a-z]$/.test(ch)) {
      buf += ch;
      recompute();
    } else {
      /* digits in Chinese mode, or anything in EN mode: commit directly (flush buffer as-is first) */
      if (buf) { text += buf; buf = ''; }
      text += ch;
      recompute();
    }
    notify();
    render();
  }

  function del() {
    if (buf) buf = buf.slice(0, -1);
    else if (text) text = text.slice(0, -1);
    recompute();
    notify();
    render();
  }

  function clearAll() {
    text = ''; buf = '';
    recompute();
    notify();
    render();
  }

  function submit() {
    if (buf) { text += buf; buf = ''; }
    var v = text;
    close();
    if (cb.onSubmit) cb.onSubmit(v);
  }

  function press(k) {
    switch (k) {
      case 'MODE': chinese = !chinese; if (buf) { text += buf; buf = ''; } recompute(); notify(); render(); break;
      case 'SPACE':
        if (chinese && cands.length) commitCand(0);     /* space = take first candidate, like a real IME */
        else typeChar(' ');
        break;
      case 'DEL': del(); break;
      case 'CLEAR': clearAll(); break;
      case 'GO': submit(); break;
      default: typeChar(k);
    }
  }

  /* ---------------------------------------------------------------- navigation */
  function moveRow(dir) {
    if (focusRow === -1) {
      if (dir > 0) focusRow = 0;
      return;
    }
    var nr = focusRow + dir;
    if (nr < 0) {
      if (cands.length) { focusRow = -1; candIdx = 0; }
      return;
    }
    if (nr >= ROWS.length) return;
    /* keep roughly the same horizontal position */
    var fromEl = keyEl(focusRow, focusCol);
    focusRow = nr;
    var best = 0, bestD = 1e9;
    if (fromEl) {
      var fx = fromEl.offsetLeft + fromEl.offsetWidth / 2;
      for (var c = 0; c < ROWS[nr].length; c++) {
        var e = keyEl(nr, c);
        var d = Math.abs(e.offsetLeft + e.offsetWidth / 2 - fx);
        if (d < bestD) { bestD = d; best = c; }
      }
    }
    focusCol = best;
  }

  function moveCol(dir) {
    if (focusRow === -1) {
      var pageLen = Math.min(MAX_CANDS, cands.length - candPage * MAX_CANDS);
      var ni = candIdx + dir;
      if (ni < 0) { if (candPage > 0) { candPage--; candIdx = MAX_CANDS - 1; } }
      else if (ni >= pageLen) { if ((candPage + 1) * MAX_CANDS < cands.length) { candPage++; candIdx = 0; } }
      else candIdx = ni;
      return;
    }
    var n = ROWS[focusRow].length;
    focusCol = (focusCol + dir + n) % n;
  }

  function handleKey(code) {
    if (!open) return false;
    switch (code) {
      case 37: moveCol(-1); render(); return true;
      case 39: moveCol(1); render(); return true;
      case 38: moveRow(-1); render(); return true;
      case 40: moveRow(1); render(); return true;
      case 13:
        if (focusRow === -1) commitCand(candIdx);
        else press(ROWS[focusRow][focusCol]);
        return true;
      case 461: case 27:            /* Back: delete one char; if empty, close keyboard */
        if (buf || text) del(); else close();
        return true;
      case 403: del(); return true;                 /* red = delete */
      case 404: press('SPACE'); return true;        /* green = first candidate / space */
      case 405: press('MODE'); return true;         /* yellow = 中/EN */
      case 406: submit(); return true;              /* blue = search */
      default:
        if (code >= 48 && code <= 57) {             /* number keys pick candidates 1..9,0 */
          var n = code - 48;
          if (cands.length) { commitCand(n === 0 ? 9 : n - 1); return true; }
          typeChar(String(n)); return true;
        }
        if (code >= 65 && code <= 90) {             /* physical letters (USB keyboard / some remotes) */
          typeChar(String.fromCharCode(code + 32)); return true;
        }
        return true;                                /* swallow everything else while open */
    }
  }

  /* ---------------------------------------------------------------- open / close */
  function openIme(opts) {
    cb = opts || {};
    if (!root) build();
    text = opts && opts.value ? String(opts.value) : '';
    buf = '';
    if (opts && opts.english !== undefined) chinese = !opts.english;
    goLabel = (opts && opts.submitLabel) || LABELS.GO;
    recompute();
    focusRow = 1; focusCol = 0;           /* start on 'a' */
    open = true;
    UI.addClass(root, 'show');
    render();
    remoteStart();
  }

  function close() {
    if (!open) return;
    open = false;
    pollGen++;
    remoteState();
    UI.removeClass(root, 'show');
    if (cb.onClose) cb.onClose(text + buf);
  }

  /* kick off the live title index once the page is up, then hourly */
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(refreshLive, 1500);                 /* let the home screen load first */
    setInterval(refreshLive, 60 * 60 * 1000);
  }, false);

  return { open: openIme, close: close, isOpen: function () { return open; }, handleKey: handleKey, refreshTitles: refreshLive };
})();
