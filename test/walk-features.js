/* Headless walk-through of the web-UI-parity features (全部 tab, 我的收藏, 新番放送, 清空, skip hint)
 * against a local bridge serving the app at /tv/.
 * Run: NODE_PATH=/tmp/moontv-shots/node_modules BRIDGE=http://127.0.0.1:8798 node test/walk-features.js
 * Screenshots go to test/shots-features/. Exits non-zero on any failed assertion or page error. */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const BRIDGE = process.env.BRIDGE || 'http://127.0.0.1:8798';
const APP = BRIDGE + '/tv/index.html';
const OUT = path.join(__dirname, 'shots-features');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const pageErrors = [];

function assert(cond, msg) {
  if (!cond) { failures.push(msg); console.log('  FAIL ' + msg); } else { console.log('  ok   ' + msg); }
}

async function focusedInfo(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.focus');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    let rowIdx = -1;
    const fr = el.closest('.filter-row');
    if (fr) rowIdx = Array.from(document.querySelectorAll('#browse-filters .filter-row')).indexOf(fr);
    return { tag: el.tagName, cls: el.className, text: (el.textContent || '').slice(0, 30), rowIdx,
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      view: (document.querySelector('.view.active') || {}).id };
  });
}

async function activeView(page) { return page.evaluate(() => (document.querySelector('.view.active') || {}).id || null); }

async function step(page, name, opts = {}) {
  await sleep(opts.wait || 400);
  const info = await focusedInfo(page);
  const view = await activeView(page);
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  console.log('[' + name + '] view=' + view + ' focus=' + JSON.stringify(info && { cls: info.cls, text: info.text, x: info.x, y: info.y, w: info.w, h: info.h }));
  if (!opts.noFocus) assert(!!info, name + ': focused element exists');
  if (info && !opts.noFocus) {
    assert(info.x >= 0 && info.y >= 0 && info.x + info.w <= 1920 && info.y + info.h <= 1080, name + ': focused element inside viewport');
  }
  if (opts.view) assert(view === opts.view, name + ': active view is ' + opts.view);
  return info;
}

const CODES = { Left: 37, Up: 38, Right: 39, Down: 40, Enter: 13, Back: 461, Red: 403, Green: 404, Yellow: 405, Blue: 406 };
async function key(page, k, times = 1) {
  for (let i = 0; i < times; i++) {
    await page.evaluate((c) => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: c, which: c, bubbles: true })), CODES[k]);
    await sleep(140);
  }
}

async function waitFor(page, fn, timeout = 30000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn, arg)) return true;
    await sleep(200);
  }
  return false;
}

async function focusUntil(page, k, pred, max = 40) {
  for (let i = 0; i < max; i++) {
    const info = await focusedInfo(page);
    if (info && pred(info)) return info;
    await key(page, k);
  }
  return null;
}

async function goTab(page, tabIdx) {
  const t = await focusUntil(page, 'Up', (i) => i.cls.indexOf('tab') >= 0, 20);
  if (!t) throw new Error('could not reach the tabs');
  await key(page, 'Left', 8);
  await key(page, 'Right', tabIdx);
  await key(page, 'Enter');
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1080', '--autoplay-policy=no-user-gesture-required']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  page.on('pageerror', (e) => { pageErrors.push(String(e)); console.log('PAGEERROR ' + e); });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console.' + m.type() + ': ' + m.text()); });

  await page.goto(APP, { waitUntil: 'load', timeout: 60000 });

  /* ---- home ---- */
  console.log('home: waiting for /home data');
  assert(await waitFor(page, () => document.querySelectorAll('#home-rows .card').length > 20, 60000), 'home rows rendered');
  await waitFor(page, () => { let n = 0; for (const i of document.images) if (i.complete) n++; return n > 20; }, 20000);
  const rowTitles = await page.evaluate(() => Array.from(document.querySelectorAll('#home-rows .row-title')).map((e) => e.firstChild.textContent));
  console.log('home rows: ' + rowTitles.join(' | '));
  assert(rowTitles.indexOf('新番放送') >= 0, 'home has 新番放送 row');
  const favBefore = await page.evaluate(() => App.Favorites.list.length);
  const recKeysBefore = await page.evaluate(() => App.Records.list.map((r) => r.key));
  console.log('favourites before: ' + favBefore + ', records before: ' + recKeysBefore.join(','));
  await step(page, '00-home-initial', { view: 'home' });

  /* ---- (a) movie page → 全部 → sort=近期热度 → 地区 scrolled to 日本 ---- */
  await goTab(page, 2);
  assert(await waitFor(page, () => document.querySelector('.view.active').id === 'browse' && document.querySelectorAll('#browse-grid .card').length > 0, 30000), 'browse movie loaded');
  await step(page, '10-browse-movie', { view: 'browse' });
  let fi = await focusUntil(page, 'Up', (i) => i.cls.indexOf('chip') >= 0, 4);
  assert(fi && fi.cls.indexOf('chip') >= 0, 'up from grid reaches chip rows');
  await key(page, 'Up');   /* first chip row (分类) */
  fi = await focusUntil(page, 'Left', (i) => i.cls.indexOf('chip') >= 0 && i.text === '全部', 12);
  assert(fi && fi.text === '全部', 'first chip of the first row is 全部 (' + (fi && fi.text) + ')');
  const firstRowChips = await page.evaluate(() => Array.from(document.querySelectorAll('#browse-filters .filter-row')[0].querySelectorAll('.chip')).map((c) => c.textContent));
  console.log('first row chips: ' + firstRowChips.join(' | '));
  assert(firstRowChips[0] === '全部' && firstRowChips[1] === '热门电影', 'first row = [全部 | 热门电影 | …]');
  await key(page, 'Enter');
  assert(await waitFor(page, () => document.querySelectorAll('#browse-filters .filter-row').length >= 5 && document.querySelectorAll('#browse-grid .card').length > 0 && document.getElementById('loading').className.indexOf('show') < 0, 60000), '全部 mode: advanced rows + grid loaded');
  const advLabels = await page.evaluate(() => Array.from(document.querySelectorAll('#browse-filters .filter-label')).map((e) => e.textContent));
  console.log('adv rows: ' + advLabels.join(' | '));
  assert(advLabels.join(',') === '分类,排序,类型,地区,年代', 'advanced rows are 分类/排序/类型/地区/年代');
  await step(page, '11-browse-movie-all', { view: 'browse' });
  fi = await focusedInfo(page);
  assert(fi && fi.text === '全部' && fi.cls.indexOf('current') >= 0, 'focus stays on 全部 and it is current');

  /* sort row → 近期热度 */
  await key(page, 'Down');
  fi = await focusedInfo(page);
  assert(fi && fi.text === '综合排序', 'sort row default is 综合排序 (' + (fi && fi.text) + ')');
  await key(page, 'Right');
  await key(page, 'Enter');
  assert(await waitFor(page, () => document.querySelectorAll('#browse-grid .card').length > 0 && document.getElementById('loading').className.indexOf('show') < 0, 60000), 'sort=近期热度 reloaded');
  await step(page, '12-browse-movie-all-sort-hot', { view: 'browse' });
  fi = await focusedInfo(page);
  assert(fi && fi.text === '近期热度' && fi.cls.indexOf('current') >= 0, 'focus on 近期热度 after reload, chip current');

  /* 地区 row: scroll to 日本 */
  await key(page, 'Down', 2);
  fi = await focusedInfo(page);
  assert(fi && fi.text === '全部', '地区 row starts at 全部 (' + (fi && fi.text) + ')');
  fi = await focusUntil(page, 'Right', (i) => i.text === '日本', 30);
  assert(fi && fi.text === '日本', 'reached 日本 in 地区 row');
  await key(page, 'Enter');
  assert(await waitFor(page, () => document.querySelectorAll('#browse-grid .card').length > 0 && document.getElementById('loading').className.indexOf('show') < 0, 60000), 'region=日本 reloaded');
  await waitFor(page, () => { let n = 0; for (const i of document.querySelectorAll('#browse-grid img')) if (i.complete) n++; return n >= 10; }, 15000);
  await step(page, '13-browse-movie-all-japan', { view: 'browse' });
  fi = await focusedInfo(page);
  assert(fi && fi.text === '日本' && fi.x >= 0 && fi.x + fi.w <= 1920, '日本 chip focused and inside viewport');
  const nJp = await page.evaluate(() => document.querySelectorAll('#browse-grid .card').length);
  assert(nJp > 0, 'grid loaded for 日本 (' + nJp + ' cards)');
  /* keep scrolling to the end of the 地区 row to prove horizontal scrolling */
  fi = await focusUntil(page, 'Right', (i) => i.text === '丹麦', 30);
  assert(fi && fi.text === '丹麦' && fi.x + fi.w <= 1920, '地区 row scrolls horizontally to the last chip 丹麦');
  const tx = await page.evaluate(() => UI.getTx(document.querySelectorAll('#browse-filters .chips.strip')[2]));
  assert(tx < 0, '地区 strip translated (' + tx + 'px)');
  await step(page, '14-browse-movie-all-region-end', { view: 'browse' });
  /* grid down → paging still works in 全部 mode */
  await key(page, 'Down', 2);
  await waitFor(page, () => document.querySelector('.focus.card'), 3000);
  await key(page, 'Down', 4);
  await sleep(500);
  assert(await waitFor(page, () => document.querySelectorAll('#browse-grid .card').length > 24, 30000), '全部 mode pages (prefetch > 24 cards)');
  await step(page, '15-browse-movie-all-page2', { view: 'browse' });

  /* per-type state: go to tv then back to movie, 全部 + 日本 restored */
  await goTab(page, 3);
  assert(await waitFor(page, () => document.querySelector('.view.active').id === 'browse' && document.getElementById('browse-title').textContent === '剧集' && document.querySelectorAll('#browse-grid .card').length > 0, 30000), 'browse tv loaded');
  const tvFirst = await page.evaluate(() => Array.from(document.querySelectorAll('#browse-filters .filter-row')[0].querySelectorAll('.chip')).map((c) => c.textContent).slice(0, 2));
  assert(tvFirst[0] === '全部' && tvFirst[1] === '最近热门', 'tv first row = [全部 | 最近热门]');
  await step(page, '16-browse-tv', { view: 'browse' });
  await goTab(page, 4);
  assert(await waitFor(page, () => document.getElementById('browse-title').textContent === '动漫' && document.querySelectorAll('#browse-grid .card').length > 0, 30000), 'browse anime loaded');
  const animeFirst = await page.evaluate(() => Array.from(document.querySelectorAll('#browse-filters .filter-row')[0].querySelectorAll('.chip')).map((c) => c.textContent)[0]);
  assert(animeFirst !== '全部', 'anime has no 全部 chip (' + animeFirst + ')');
  await goTab(page, 2);
  assert(await waitFor(page, () => document.getElementById('browse-title').textContent === '电影' && document.querySelectorAll('#browse-grid .card').length > 0, 30000), 'browse movie re-entered');
  const restored = await page.evaluate(() => Array.from(document.querySelectorAll('#browse-filters .chip.current')).map((c) => c.textContent));
  console.log('movie restored current chips: ' + restored.join(' | '));
  assert(restored[0] === '全部' && restored[1] === '近期热度' && restored.indexOf('日本') >= 0, 'movie 全部 state restored after tab switch');
  await step(page, '17-browse-movie-restored', { view: 'browse' });
  /* back to normal mode: 热门电影 */
  fi = await focusUntil(page, 'Up', (i) => i.cls.indexOf('chip') >= 0 && i.rowIdx === 0, 8);
  await key(page, 'Left', 6);
  fi = await focusUntil(page, 'Right', (i) => i.text === '热门电影', 5);
  assert(fi && fi.text === '热门电影', 'focused 热门电影 in the first row');
  await key(page, 'Enter');
  assert(await waitFor(page, () => document.querySelectorAll('#browse-filters .filter-row').length === 2 && document.querySelectorAll('#browse-grid .card').length > 0 && document.getElementById('loading').className.indexOf('show') < 0, 60000), 'back to normal rows via 热门电影');
  await step(page, '18-browse-movie-normal-again', { view: 'browse' });

  /* ---- (c) detail with 收藏 → 已收藏 ---- */
  await key(page, 'Back');
  await step(page, '20-home-back', { view: 'home' });
  /* find the 继续观看 or a douban row and open a card; use search for a deterministic title */
  await goTab(page, 1);
  await waitFor(page, () => document.querySelector('.view.active').id === 'search', 5000);
  await page.evaluate(() => { document.getElementById('search-input').value = '兰香如故'; });
  await key(page, 'Right'); await key(page, 'Enter');
  assert(await waitFor(page, () => document.querySelectorAll('#search-grid .card').length > 0 || document.querySelector('.view.active').id === 'detail', 90000), 'search 兰香如故 finished');
  if (await page.evaluate(() => document.querySelector('.view.active').id) === 'search') { await key(page, 'Down'); await key(page, 'Enter'); }
  assert(await waitFor(page, () => document.querySelector('.view.active').id === 'detail' && document.querySelectorAll('#detail-episodes .ep').length > 0, 30000), 'detail opened with episodes');
  await sleep(800);
  const favBtn0 = await page.evaluate(() => { const b = document.querySelector('#detail-actions .btn.fav'); return b && b.textContent; });
  assert(favBtn0 === '收藏' || favBtn0 === '已收藏', 'detail has 收藏 button (' + favBtn0 + ')');
  const detKey = await page.evaluate(() => { const b = document.querySelector('#detail-actions .btn.fav'); return b ? 1 : 0; });
  const wasFav = favBtn0 === '已收藏';
  await step(page, '21-detail-before-fav', { view: 'detail' });
  /* focus the actions row and the 收藏 button, toggle with OK */
  fi = await focusUntil(page, 'Up', (i) => i.cls.indexOf('btn') >= 0, 6);
  assert(fi && fi.cls.indexOf('btn') >= 0, 'reached the actions row');
  await key(page, 'Left', 4);
  fi = await focusUntil(page, 'Right', (i) => i.cls.indexOf('fav') >= 0, 4);
  assert(fi && fi.cls.indexOf('btn fav') >= 0, 'focused the 收藏 button');
  if (!wasFav) {
    await key(page, 'Enter');
    assert(await waitFor(page, () => { const b = document.querySelector('#detail-actions .btn.fav'); return b && b.textContent === '已收藏'; }, 20000), 'OK on 收藏 → 已收藏');
  }
  await sleep(300);
  await step(page, '22-detail-favorited', { view: 'detail' });
  fi = await focusedInfo(page);
  assert(fi && fi.text === '已收藏', 'focus remains on the (now) 已收藏 button');
  const favKeyNow = await page.evaluate(() => App.Favorites.list.length ? App.Favorites.list[0].key : '');
  console.log('favourite key: ' + favKeyNow);
  /* GREEN toggles too: remove then re-add so the next home shows it */
  await key(page, 'Green');
  assert(await waitFor(page, () => { const b = document.querySelector('#detail-actions .btn.fav'); return b && b.textContent === '收藏'; }, 20000), 'GREEN → 收藏 (removed)');
  await key(page, 'Green');
  assert(await waitFor(page, () => { const b = document.querySelector('#detail-actions .btn.fav'); return b && b.textContent === '已收藏'; }, 20000), 'GREEN → 已收藏 (re-added)');
  await step(page, '23-detail-green-toggled', { view: 'detail' });

  /* ---- (d) player OSD with skip hint ---- */
  fi = await focusUntil(page, 'Down', (i) => /(^| )ep( |$)/.test(i.cls), 14);
  assert(fi && fi.cls.indexOf('ep') >= 0, 'reached the episode grid');
  await key(page, 'Left', 12);
  await key(page, 'Enter');
  assert(await waitFor(page, () => document.querySelector('.view.active').id === 'player', 10000), 'player opened');
  await sleep(1500);
  /* remember the skip config of this title so the YELLOW test can restore it (user data left as found) */
  const skipBefore = await page.evaluate((k) => API.skipConfig(k).then(null, () => null), favKeyNow);
  /* OK = pause → OSD sticky (no seeking, so no play record gets written for this walk) */
  await key(page, 'Enter');
  await sleep(300);
  const osd = await page.evaluate(() => ({ show: document.getElementById('osd').className.indexOf('show') >= 0, hint: document.getElementById('osd-hint-skip').textContent, skip: document.getElementById('osd-hint-skip').getBoundingClientRect().right }));
  assert(osd.show, 'OSD visible');
  assert(/黄键 设为片头结束点/.test(osd.hint) && /蓝键 设为片尾开始点/.test(osd.hint), 'OSD skip hint present: ' + osd.hint);
  assert(osd.skip <= 1920, 'skip hint inside viewport');
  await step(page, '30-player-osd-skip-hint', { view: 'player', noFocus: true });
  /* YELLOW at position 0 → intro 0 + outro 0 → saved as enable:false; then restore the previous config */
  const cur0 = await page.evaluate(() => Math.floor(document.getElementById('video').currentTime || 0));
  await key(page, 'Yellow');
  await sleep(1500);
  const toast1 = await page.evaluate(() => document.getElementById('toast').textContent);
  console.log('after YELLOW (t=' + cur0 + ') toast: ' + toast1);
  assert(/已关闭跳过片头片尾|已保存|保存失败/.test(toast1), 'YELLOW produced a save toast (' + toast1 + ')');
  await step(page, '31-player-yellow', { view: 'player', noFocus: true });
  const skipAfter = await page.evaluate((k) => API.skipConfig(k), favKeyNow);
  console.log('skip config after YELLOW: ' + JSON.stringify(skipAfter) + ' (before: ' + JSON.stringify(skipBefore) + ')');
  assert(skipAfter && skipAfter.enable === false && skipAfter.intro_time === cur0, 'YELLOW stored intro_time=' + cur0 + ', enable:false');
  await page.evaluate((k, c) => API.saveSkipConfig(k, c && c.enable !== undefined ? c : { enable: false, intro_time: 0, outro_time: 0 }), favKeyNow, skipBefore);
  await key(page, 'Back');
  assert(await waitFor(page, () => document.querySelector('.view.active').id === 'detail', 5000), 'back to detail');

  /* ---- (b) home with 我的收藏 + 新番放送 ---- */
  await goTab(page, 0);
  assert(await waitFor(page, () => document.querySelector('.view.active').id === 'home' && document.querySelectorAll('#home-rows .card').length > 20, 30000), 'home re-entered');
  await sleep(600);
  const rows2 = await page.evaluate(() => Array.from(document.querySelectorAll('#home-rows .row-title')).map((e) => e.firstChild.textContent));
  console.log('home rows now: ' + rows2.join(' | '));
  assert(rows2.indexOf('我的收藏') >= 0, 'home shows 我的收藏 row');
  assert(rows2.indexOf('新番放送') >= 0, 'home shows 新番放送 row');
  const expectOrder = ['继续观看', '我的收藏', '热门电影', '热门剧集', '新番放送', '热门动漫', '热门综艺'].filter((t) => rows2.indexOf(t) >= 0);
  assert(rows2.join(',') === expectOrder.join(','), 'home row order is continue, favorites, movie, tv, bangumi, anime, show');
  /* 我的收藏 row: fav cards */
  const favCards = await page.evaluate(() => Array.from(document.querySelectorAll('#home-rows .card-fav')).map((c) => ({ t: c.querySelector('.title').textContent, s: c.querySelector('.sub').textContent, eps: (c.querySelector('.badge.eps') || {}).textContent, prog: !!c.querySelector('.progress') })));
  console.log('fav cards: ' + JSON.stringify(favCards));
  assert(favCards.length > 0 && !favCards[0].prog, 'fav card rendered without progress bar');
  /* focus the 我的收藏 row */
  fi = await focusUntil(page, 'Down', (i) => i.cls.indexOf('card-fav') >= 0, 6);
  assert(fi && fi.cls.indexOf('card-fav') >= 0, 'focus lands in 我的收藏 row');
  await waitFor(page, () => { let n = 0; for (const i of document.images) if (i.complete) n++; return n > 30; }, 15000);
  await step(page, '40-home-favorites', { view: 'home' });
  /* 新番放送 row: bangumi cards with day + rate badges */
  fi = await focusUntil(page, 'Down', (i) => i.cls.indexOf('card-bangumi') >= 0, 6);
  assert(fi && fi.cls.indexOf('card-bangumi') >= 0, 'focus lands in 新番放送 row');
  const bg = await page.evaluate(() => { const c = document.querySelector('#home-rows .card-bangumi'); return { day: (c.querySelector('.badge.day') || {}).textContent, rate: (c.querySelector('.badge.rate') || {}).textContent, title: c.querySelector('.title').textContent, img: !!c.querySelector('img') }; });
  console.log('bangumi first card: ' + JSON.stringify(bg));
  assert(/^星期/.test(bg.day || ''), 'bangumi card has weekday badge');
  await step(page, '41-home-bangumi', { view: 'home' });
  /* OK on a bangumi card → search by title */
  await key(page, 'Enter');
  assert(await waitFor(page, () => document.querySelector('.view.active').id === 'search', 5000), 'OK on bangumi card opens search');
  const q = await page.evaluate(() => document.getElementById('search-input').value);
  assert(q === bg.title, 'search prefilled with bangumi title (' + q + ')');
  await step(page, '42-search-from-bangumi', { view: 'search', noFocus: true });
  await key(page, 'Back');
  await sleep(300);
  if (await page.evaluate(() => document.querySelector('.view.active').id) !== 'home') await key(page, 'Back');
  assert(await waitFor(page, () => document.querySelector('.view.active').id === 'home', 5000), 'back on home');

  /* ---- (4) RED on 继续观看: first press arms with a toast (do NOT confirm: keep the user's data) ---- */
  const hasContinue = rows2.indexOf('继续观看') >= 0;
  if (hasContinue) {
    fi = await focusUntil(page, 'Up', (i) => i.cls.indexOf('card-record') >= 0, 8);
    assert(fi && fi.cls.indexOf('card-record') >= 0, 'focus in 继续观看 row');
    await key(page, 'Red');
    await sleep(300);
    const t = await page.evaluate(() => document.getElementById('toast').textContent + '|' + document.getElementById('toast').className);
    assert(/再按红键清空继续观看/.test(t) && /show/.test(t), 'first RED shows confirm toast (' + t + ')');
    const nRec = await page.evaluate(() => document.querySelectorAll('#home-rows .card-record').length);
    assert(nRec > 0, 'records still present after first RED');
    await step(page, '50-home-red-armed', { view: 'home' });
    /* RED outside the 继续观看 row does nothing */
    await key(page, 'Down');
    await key(page, 'Red');
    await sleep(200);
    const nRec2 = await page.evaluate(() => document.querySelectorAll('#home-rows .card-record').length);
    assert(nRec2 === nRec, 'RED outside 继续观看 is ignored');
    await sleep(5200); /* let the arm expire */
  } else {
    console.log('no 继续观看 row: RED clear not exercised');
  }

  /* ---- cleanup: remove the favourite we added (leave data as found) ---- */
  if (!wasFav) {
    fi = await focusUntil(page, 'Up', (i) => i.cls.indexOf('card-fav') >= 0, 8);
    assert(fi && fi.cls.indexOf('card-fav') >= 0, 'focus back on 我的收藏 card');
    await key(page, 'Enter');
    assert(await waitFor(page, () => document.querySelector('.view.active').id === 'detail' && document.querySelectorAll('#detail-episodes .ep').length > 0, 30000), 'OK on favourite card opens detail');
    await sleep(500);
    assert(await page.evaluate(() => { const b = document.querySelector('#detail-actions .btn.fav'); return b && b.textContent === '已收藏'; }), 'detail from favourite shows 已收藏');
    await step(page, '60-detail-from-favorite', { view: 'detail' });
    await key(page, 'Green');
    assert(await waitFor(page, () => { const b = document.querySelector('#detail-actions .btn.fav'); return b && b.textContent === '收藏'; }, 20000), 'cleanup: favourite removed');
    await key(page, 'Back');
    assert(await waitFor(page, () => document.querySelector('.view.active').id === 'home', 5000), 'back on home after cleanup');
    await sleep(500);
    const favRowsAfter = await page.evaluate(() => Array.from(document.querySelectorAll('#home-rows .row-title')).map((e) => e.firstChild.textContent));
    const nFavAfter = await page.evaluate(() => App.Favorites.list.length);
    assert(nFavAfter === favBefore, 'favourites count back to ' + favBefore + ' (' + nFavAfter + ')');
    if (favBefore === 0) assert(favRowsAfter.indexOf('我的收藏') < 0, '我的收藏 row hidden again when empty');
    await step(page, '61-home-final', { view: 'home' });
  }

  /* cleanup: drop the play record the player walk created (if the title was not in 继续观看 before) */
  const newRecs = await page.evaluate((before) => App.Records.list.map((r) => r.key).filter((k) => before.indexOf(k) < 0), recKeysBefore);
  for (const k of newRecs) {
    console.log('cleanup: removing play record ' + k);
    await page.evaluate((key) => API.removeRecord(key).then(() => { App.Records.set(App.Records.list.filter((r) => r.key !== key)); }), k);
  }
  const recKeysAfter = await page.evaluate(() => API.records().then((l) => l.map((r) => r.key)));
  assert(recKeysAfter.join(',') === recKeysBefore.join(','), 'play records left as found (' + recKeysAfter.join(',') + ')');

  console.log('\npage errors: ' + pageErrors.length);
  assert(pageErrors.length === 0, 'no page errors');
  await browser.close();
  console.log('\n' + (failures.length ? failures.length + ' FAILURE(S):\n  ' + failures.join('\n  ') : 'ALL OK'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
