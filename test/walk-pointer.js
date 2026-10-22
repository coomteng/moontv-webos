/* Magic Remote (pointer) walk-through: hover focuses, click activates, wheel scrolls/seeks.
   Usage: node test/walk-pointer.js [http://127.0.0.1:8798]   (needs puppeteer-core in /tmp/moontv-shots) */
const puppeteer = require('/tmp/moontv-shots/node_modules/puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = process.argv[2] || 'http://127.0.0.1:8798';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1920,1080'] });
  const p = await b.newPage(); await p.setViewport({ width: 1920, height: 1080 });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + '/tv/index.html', { waitUntil: 'networkidle2', timeout: 60000 }); await sleep(3000);
  const focusText = () => p.evaluate(() => (document.querySelector('.focus') || {}).textContent || '');
  const center = async (sel, nth = 0) => p.evaluate((sel, nth) => { const el = document.querySelectorAll(sel)[nth]; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, t: el.textContent }; }, sel, nth);

  // 1. hover a card in the 2nd row → it gets focus (zone switch)
  let c = await center('#home-rows .row:nth-child(2) .card', 3);
  await p.mouse.move(c.x, c.y); await sleep(300);
  ok((await focusText()) === c.t, 'hover focuses card in another row: ' + c.t.slice(0, 20));
  ok(await p.evaluate(() => document.body.classList.contains('pointer')), 'body.pointer set while pointer active');
  // 1b. hovering a card in a lower row must NOT scroll the page (only wheel/keys scroll)
  const tyBefore = await p.evaluate(() => parseInt(document.getElementById('home-rows').getAttribute('data-ty') || '0', 10));
  const lastRow = await p.evaluate(() => { const rows = [...document.querySelectorAll('#home-rows .row')]; let best = null; rows.forEach(r => { const b = r.getBoundingClientRect(); if (b.top < 1080 && b.bottom > 300) best = r; }); const card = best.querySelectorAll('.card')[1]; const b = card.getBoundingClientRect(); return { x: b.left + b.width / 2, y: Math.min(b.top + 40, 1060), t: card.textContent }; });
  await p.mouse.move(lastRow.x, lastRow.y); await sleep(400);
  const tyAfter = await p.evaluate(() => parseInt(document.getElementById('home-rows').getAttribute('data-ty') || '0', 10));
  ok((await focusText()) === lastRow.t, 'hover focuses a card in the lowest visible row');
  ok(tyAfter === tyBefore, 'hover does not scroll the page (ty ' + tyBefore + ' -> ' + tyAfter + ')');
  // 2. wheel down on home → next row
  const before = await p.evaluate(() => [...document.querySelectorAll('#home-rows .row')].findIndex(r => r.querySelector('.focus')));
  await p.mouse.wheel({ deltaY: 120 }); await sleep(400);
  const after = await p.evaluate(() => [...document.querySelectorAll('#home-rows .row')].findIndex(r => r.querySelector('.focus')));
  ok(after === before + 1, 'wheel down moves to next row (' + before + ' -> ' + after + ')');
  // 3. click a top tab → view changes
  c = await center('#topbar .tab', 2); await p.mouse.click(c.x, c.y); await sleep(2500);
  ok((await p.evaluate(() => App.currentName())) === 'browse', 'click on 电影 tab opens browse');
  // 4. click a filter chip → becomes current
  c = await center('#browse-filters .chip', 2); await p.mouse.click(c.x, c.y); await sleep(2500);
  ok(await p.evaluate(() => document.querySelectorAll('#browse-filters .chip')[2].classList.contains('current')), 'click on chip selects it: ' + c.t);
  // 5. wheel on a horizontal chip strip? skip; wheel on grid moves rows
  c = await center('#browse-grid .card', 1); await p.mouse.move(c.x, c.y); await sleep(200);
  await p.mouse.wheel({ deltaY: 120 }); await sleep(400);
  ok((await p.evaluate(() => Nav.current().index)) === 1 + 7, 'wheel in grid moves one row down (index 1 -> 8)');
  // 6. click a card → search → detail
  c = await center('#browse-grid .card', 0); await p.mouse.click(c.x, c.y);
  await p.waitForFunction(() => App.currentName() === 'detail', { timeout: 90000 }).catch(() => {});
  ok((await p.evaluate(() => App.currentName())) === 'detail', 'click on poster opens detail (via search)');
  await p.waitForFunction(() => /可用 \d+/.test(document.getElementById('detail-sources-title').textContent), { timeout: 60000 }).catch(() => {});
  // 7. click an episode → player; click on video pauses; click on bar seeks; wheel seeks
  await p.evaluate(() => new Promise(res => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js'; s.onload = () => { let inst = null; window.HLS_SHIM = { attach: (v, u) => { if (inst) inst.destroy(); inst = new Hls(); inst.loadSource(u); inst.attachMedia(v); } }; res(); }; s.onerror = res; document.head.appendChild(s); }));
  c = await center('#detail-episodes .ep', 0); await p.mouse.click(c.x, c.y); await sleep(1500);
  ok((await p.evaluate(() => App.currentName())) === 'player', 'click on episode opens player');
  await p.waitForFunction(() => document.getElementById('video').currentTime > 3, { timeout: 60000 }).catch(() => {});
  const playing = await p.evaluate(() => !document.getElementById('video').paused);
  await p.mouse.move(960, 500); await sleep(200);
  ok(await p.evaluate(() => document.getElementById('osd').classList.contains('show')), 'pointer move shows OSD');
  await p.mouse.click(960, 500); await sleep(500);
  ok(playing && (await p.evaluate(() => document.getElementById('video').paused)), 'click on video pauses');
  await p.mouse.click(960, 500); await sleep(500);
  const bar = await p.evaluate(() => { const r = document.getElementById('osd-bar').getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height / 2 }; });
  await p.mouse.click(bar.x, bar.y); await sleep(800);
  const t1 = await p.evaluate(() => ({ t: document.getElementById('video').currentTime, d: document.getElementById('video').duration }));
  ok(Math.abs(t1.t / t1.d - 0.5) < 0.05, 'click at 50% of the bar seeks to ~50% (' + Math.round(t1.t) + '/' + Math.round(t1.d) + ')');
  await p.mouse.wheel({ deltaY: 120 }); await sleep(600);
  const t2 = await p.evaluate(() => document.getElementById('video').currentTime);
  ok(t2 > t1.t + 5, 'wheel seeks forward (' + Math.round(t1.t) + ' -> ' + Math.round(t2) + ')');
  // 8. keyboard overlay: click keys and a candidate
  await p.evaluate(() => { App.goRoot('search', {}); }); await sleep(500);
  await p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 13 }))); await sleep(800);
  for (const k of ['l', 'a', 'n']) { c = await center('.ime-key[data-k="' + k + '"]'); await p.mouse.click(c.x, c.y); await sleep(120); }
  ok((await p.evaluate(() => document.getElementById('ime-buf').textContent)) === 'lan', 'clicking keyboard keys types "lan"');
  const beforeText = await p.evaluate(() => document.getElementById('ime-text').textContent);
  c = await center('.ime-cand', 2); const candWord = c.t.replace(/^\d+\s*/, '');
  await p.mouse.click(c.x, c.y); await sleep(200);
  const typed = await p.evaluate(() => ({ t: document.getElementById('ime-text').textContent, b: document.getElementById('ime-buf').textContent }));
  ok(typed.t === beforeText + candWord && typed.b === '', 'clicking a candidate commits it: +' + candWord);
  console.log('pageerrors:', errs.length ? errs : 'none');
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
