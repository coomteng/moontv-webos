/* Headless walk-through of the webOS app at 1920x1080 with puppeteer-core.
 * Run: NODE_PATH=/tmp/moontv-shots/node_modules node test/walk.js
 * Screenshots are written next to this file. Exits non-zero on any failed assertion or page error. */
const path = require('path');
const puppeteer = require('puppeteer-core');

const APP = 'file://' + require('path').resolve(__dirname, '..', 'app', 'index.html');
const OUT = __dirname;
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
    return { tag: el.tagName, cls: el.className, text: (el.textContent || '').slice(0, 30),
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      view: (document.querySelector('.view.active') || {}).id };
  });
}

async function step(page, name, opts = {}) {
  await sleep(opts.wait || 400);
  const info = await focusedInfo(page);
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  console.log('[' + name + '] view=' + (info && info.view) + ' focus=' + JSON.stringify(info && { cls: info.cls, text: info.text, x: info.x, y: info.y, w: info.w, h: info.h }));
  if (!opts.noFocus) assert(!!info, name + ': focused element exists');
  if (info && !opts.noFocus) {
    assert(info.x >= 0 && info.y >= 0 && info.x + info.w <= 1920 && info.y + info.h <= 1080, name + ': focused element inside viewport');
  }
  if (opts.view) assert(info && info.view === opts.view, name + ': active view is ' + opts.view);
  return info;
}

async function key(page, k, times = 1) {
  for (let i = 0; i < times; i++) {
    if (k === 'Back') {
      await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 461, which: 461, bubbles: true })));
    } else {
      await page.keyboard.press(k);
    }
    await sleep(120);
  }
}

async function waitFor(page, fn, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return true;
    await sleep(200);
  }
  return false;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1080', '--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  page.on('pageerror', (e) => { pageErrors.push(String(e)); console.log('PAGEERROR ' + e); });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console.' + m.type() + ': ' + m.text()); });

  await page.goto(APP, { waitUntil: 'load', timeout: 60000 });

  /* ---- home ---- */
  console.log('home: waiting for /home data');
  assert(await waitFor(page, () => document.querySelectorAll('#home-rows .card').length > 20), 'home rows rendered');
  await waitFor(page, () => { let n = 0; for (const i of document.images) if (i.complete) n++; return n > 20; }, 20000);
  await step(page, '01-home', { view: 'home' });
  const nImg = await page.evaluate(() => document.images.length);
  assert(nImg > 10, 'document.images.length > 10 (' + nImg + ')');

  await key(page, 'ArrowRight', 3);
  await step(page, '02-home-right3', { view: 'home' });
  await key(page, 'ArrowDown', 2);
  await key(page, 'ArrowRight', 1);
  const homeFocus = await step(page, '03-home-down2-right', { view: 'home' });
  const pickedTitle = homeFocus && homeFocus.text;
  await key(page, 'ArrowUp', 3);
  await step(page, '04-home-tabs', { view: 'home' });
  assert((await focusedInfo(page)).cls.indexOf('tab') >= 0, 'up x3 from row 3 reaches the tabs');
  await key(page, 'ArrowDown', 1);
  await key(page, 'ArrowDown', 2);
  await key(page, 'ArrowRight', 1);

  /* ---- OK on douban card → search prefilled ---- */
  await key(page, 'Enter');
  await step(page, '05-search-loading', { view: 'search', noFocus: true, wait: 300 });
  console.log('search: waiting for results / detail');
  assert(await waitFor(page, () => !/搜索中/.test(document.getElementById('search-status').textContent), 90000), 'search finished');
  await sleep(500);
  let v = await page.evaluate(() => document.querySelector('.view.active').id);
  const q = await page.evaluate(() => document.getElementById('search-input').value);
  console.log('search query=' + q + ' view after search=' + v);
  assert(q === pickedTitle, 'search input prefilled with card title');
  if (v === 'search') {
    await step(page, '06-search-results', { view: 'search' });
    const nres = await page.evaluate(() => document.querySelectorAll('#search-grid .card').length);
    if (nres > 0) { await key(page, 'Enter'); }
    else {
      /* no result for this title: fall back to a known query */
      console.log('no results for "' + q + '", falling back to 兰香如故');
      await page.evaluate(() => { document.getElementById('search-input').value = '兰香如故'; });
      await key(page, 'ArrowUp', 2); await key(page, 'ArrowRight'); await key(page, 'Enter');
      await waitFor(page, () => document.querySelectorAll('#search-grid .card').length > 0, 90000);
      await sleep(400);
      await key(page, 'Enter');
    }
  } else {
    await step(page, '06-search-autoopen', { view: 'detail' });
  }

  /* ---- detail ---- */
  await step(page, '07-detail', { view: 'detail' });
  const nEp = await page.evaluate(() => document.querySelectorAll('#detail-episodes .ep').length);
  assert(nEp > 0, 'detail has episodes (' + nEp + ')');
  const detTitle = await page.evaluate(() => document.getElementById('detail-title').textContent);
  console.log('detail title=' + detTitle + ' episodes=' + nEp);
  await key(page, 'ArrowDown', 1);
  await key(page, 'ArrowRight', 2);
  await key(page, 'ArrowUp', 2);
  await step(page, '08-detail-sources', { view: 'detail' });
  /* back to episode 1 */
  await key(page, 'ArrowDown', 1);
  await waitFor(page, () => { const f = document.querySelector('.focus'); return f && f.className.indexOf('ep') >= 0; }, 2000);
  await page.evaluate(() => { /* make sure we're on ep 1 */ });
  await key(page, 'ArrowLeft', 12);
  await step(page, '09-detail-ep1', { view: 'detail' });

  /* ---- player ---- */
  await key(page, 'Enter');
  await sleep(1500);
  await step(page, '10-player', { view: 'player', noFocus: true });
  const src = await page.evaluate(() => document.getElementById('video').getAttribute('src') || document.getElementById('video').src);
  assert(/m3u8/.test(src), 'video src is an m3u8 (' + src + ')');
  await key(page, 'ArrowRight');
  await sleep(200);
  await step(page, '11-player-osd', { view: 'player', noFocus: true });
  const osdShown = await page.evaluate(() => document.getElementById('osd').className.indexOf('show') >= 0);
  assert(osdShown, 'OSD visible after a key press');
  await key(page, 'ArrowDown');
  await step(page, '12-player-epstrip', { view: 'player' });
  await key(page, 'ArrowRight', 2);
  await step(page, '13-player-epstrip-right', { view: 'player' });
  await key(page, 'ArrowUp');

  /* ---- back → detail → back → search → back → home ---- */
  await key(page, 'Back');
  await step(page, '14-back-detail', { view: 'detail' });
  await key(page, 'Back');
  await sleep(300);
  v = await page.evaluate(() => document.querySelector('.view.active').id);
  console.log('after 2nd back view=' + v);
  if (v === 'search') { await step(page, '15-back-search', { view: 'search' }); await key(page, 'Back'); }
  await step(page, '16-back-home', { view: 'home' });

  /* ---- browse: all four types via the tabs ---- */
  const types = [['movie', 2], ['tv', 3], ['anime', 4], ['show', 5]];
  for (const [t, tabIdx] of types) {
    await key(page, 'ArrowUp', 6);
    await key(page, 'ArrowLeft', 8);
    await key(page, 'ArrowRight', tabIdx);
    await key(page, 'Enter');
    assert(await waitFor(page, () => document.querySelector('.view.active').id === 'browse' && document.querySelectorAll('#browse-grid .card').length > 0, 30000), 'browse ' + t + ' loaded');
    await waitFor(page, () => { let n = 0; for (const i of document.querySelectorAll('#browse-grid img')) if (i.complete) n++; return n >= 14; }, 15000);
    await step(page, '20-browse-' + t, { view: 'browse' });
    const cnt = await page.evaluate(() => document.querySelectorAll('#browse-grid .card').length);
    console.log('browse ' + t + ' cards=' + cnt);
    if (t === 'movie') {
      /* walk down to trigger paging, then chips */
      await key(page, 'ArrowDown', 4);
      await sleep(800);
      await waitFor(page, () => document.querySelectorAll('#browse-grid .card').length > 24, 20000);
      await step(page, '21-browse-movie-page2', { view: 'browse' });
      const cnt2 = await page.evaluate(() => document.querySelectorAll('#browse-grid .card').length);
      assert(cnt2 > 24, 'browse movie paged (' + cnt2 + ' cards)');
      await key(page, 'ArrowUp', 6);
      await step(page, '22-browse-movie-chips', { view: 'browse' });
      const fi = await focusedInfo(page);
      assert(fi && fi.cls.indexOf('chip') >= 0, 'up from grid reaches chips');
      await key(page, 'ArrowDown'); await key(page, 'ArrowRight'); await key(page, 'Enter');  /* region 华语 */
      assert(await waitFor(page, () => document.querySelectorAll('#browse-grid .card').length > 0 && document.getElementById('loading').className.indexOf('show') < 0, 30000), 'browse movie 华语 reloaded');
      await step(page, '23-browse-movie-huayu', { view: 'browse' });
    }
    await key(page, 'Back');
    await step(page, '24-back-home-' + t, { view: 'home' });
  }

  /* ---- search view with query 兰香如故 ---- */
  await key(page, 'ArrowUp', 6);
  await key(page, 'ArrowLeft', 8);
  await key(page, 'ArrowRight', 1);
  await key(page, 'Enter');
  await step(page, '30-search-empty', { view: 'search' });
  await key(page, 'Enter'); /* open IME → input focused */
  const inputFocused = await page.evaluate(() => document.activeElement === document.getElementById('search-input'));
  assert(inputFocused, 'OK on the input gives it DOM focus (IME)');
  await page.evaluate(() => { document.getElementById('search-input').value = ''; });
  await page.keyboard.type('兰香如故');
  await step(page, '31-search-typed', { view: 'search' });
  await page.keyboard.press('Enter');
  assert(await waitFor(page, () => document.querySelectorAll('#search-grid .card').length > 0, 90000), 'search 兰香如故 returned results');
  await waitFor(page, () => { let n = 0; for (const i of document.querySelectorAll('#search-grid img')) if (i.complete) n++; return n >= 1; }, 10000);
  await step(page, '32-search-lanxiang', { view: 'search' });
  const grp = await page.evaluate(() => {
    const cards = document.querySelectorAll('#search-grid .card');
    return { n: cards.length, text: cards[0] ? cards[0].textContent : '' };
  });
  console.log('search groups=' + grp.n + ' first=' + grp.text);
  assert(grp.n === 1, 'exactly 1 group for 兰香如故');
  await key(page, 'Enter');
  await step(page, '33-detail-lanxiang', { view: 'detail' });
  const det = await page.evaluate(() => ({
    eps: document.querySelectorAll('#detail-episodes .ep').length,
    srcs: document.querySelectorAll('#detail-sources .chip').length,
    title: document.getElementById('detail-title').textContent
  }));
  console.log('detail ' + JSON.stringify(det));
  assert(det.eps === 47, '47 episodes (' + det.eps + ')');
  assert(det.srcs >= 10, '>=10 sources (' + det.srcs + ')');
  await key(page, 'ArrowDown', 4);
  await step(page, '34-detail-eps-scrolled', { view: 'detail' });
  await key(page, 'Enter');
  await sleep(1500);
  await step(page, '35-player-lanxiang', { view: 'player', noFocus: true });
  await key(page, 'Back');
  await step(page, '36-detail-after-player', { view: 'detail' });
  await key(page, 'Back');
  await step(page, '37-search-after-back', { view: 'search' });
  const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('moontv.searchHistory') || '[]'));
  console.log('history=' + JSON.stringify(hist));
  assert(hist.length >= 1 && hist[0] === '兰香如故', 'search history persisted');
  await key(page, 'Back');
  await step(page, '38-home-final', { view: 'home' });

  await browser.close();
  console.log('\npage errors: ' + pageErrors.length);
  pageErrors.forEach((e) => console.log('  ' + e));
  console.log('failures: ' + failures.length);
  failures.forEach((f) => console.log('  ' + f));
  process.exit(failures.length || pageErrors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
