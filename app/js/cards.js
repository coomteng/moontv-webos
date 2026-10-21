/* cards.js — poster card builders shared by home / browse / search (ES5 only). */
var Cards = (function () {
  'use strict';

  function posterBox(url) {
    var box = UI.el('div', 'poster');
    if (url) {
      var img = UI.el('img');
      img.alt = '';
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
      img.src = API.poster(url);
      box.appendChild(img);
    }
    return box;
  }

  /* Douban item: {id, title, poster, rate, year} → card with pink rating badge. */
  function douban(item) {
    var c = UI.el('div', 'card card-douban');
    c.appendChild(posterBox(item.poster));
    if (item.rate) c.appendChild(UI.text('div', 'badge rate', item.rate));
    c.appendChild(UI.text('div', 'title', item.title));
    c.appendChild(UI.text('div', 'sub', item.year || ''));
    c.setAttribute('title', item.title || '');
    return c;
  }

  /* Play record: {title, poster, index, total_episodes, play_time, total_time, source_name} */
  function record(rec) {
    var c = UI.el('div', 'card card-record');
    c.appendChild(posterBox(rec.poster));
    var total = rec.total_episodes || 1;
    if (total > 1 || rec.index > 1) c.appendChild(UI.text('div', 'badge eps', (rec.index || 1) + '/' + total));
    var prog = UI.el('div', 'progress');
    var bar = UI.el('div', 'bar');
    var pct = rec.total_time > 0 ? Math.min(100, Math.round(100 * rec.play_time / rec.total_time)) : 0;
    bar.style.width = pct + '%';
    prog.appendChild(bar);
    c.appendChild(prog);
    c.appendChild(UI.text('div', 'title', rec.title));
    c.appendChild(UI.text('div', 'sub source', rec.source_name || ''));
    return c;
  }

  /* Search group: {title, year, poster, type_name, sources:[Result]} */
  function group(g) {
    var c = UI.el('div', 'card card-group');
    c.appendChild(posterBox(g.poster));
    if (g.year) c.appendChild(UI.text('div', 'badge year', g.year));
    var eps = 0;
    for (var i = 0; i < g.sources.length; i++) {
      var n = (g.sources[i].episodes || []).length;
      if (n > eps) eps = n;
    }
    if (eps > 1) c.appendChild(UI.text('div', 'badge eps', eps + '集'));
    c.appendChild(UI.text('div', 'title', g.title));
    c.appendChild(UI.text('div', 'sub', (g.type_name ? g.type_name + ' · ' : '') + g.sources.length + ' 个源'));
    return c;
  }

  return { douban: douban, record: record, group: group };
})();
