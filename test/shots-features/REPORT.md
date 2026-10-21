# Worker report — web-UI-parity features for the webOS app

## Completed

All five features implemented in the ES5 app (no api-go/ or api/ changes), verified with the ES5 gate
and a puppeteer walk-through against a local bridge (`/tmp/moontv-api-go` on :8798 → upstream 192.168.0.9:3000).

1. **browse.js — 全部 advanced tab.** On movie/tv/show the first row is `[全部 | 热门电影 | …]` (anime has no 全部).
   Selecting 全部 fetches `API.advancedFilters(type)` once per type and renders one chip row per group
   (排序/类型/地区/年代, +平台 on tv/show); first option is current by default (综合排序 for sort). Chip rows in
   this mode are non-wrapping strips (`.chips.strip` inside `.chips-wrap`) translated with `Nav.scrollX` so the focused
   chip stays visible (地区 has 23 chips; verified scrolling to 丹麦). Chips re-query `API.advancedList(type, {sort,
   category, region, year, platform}, start, 24)` with the same paging/prefetch (`onDownExit`, last-two-rows prefetch).
   Per-type state (`adv`, `advParams`, items, page) survives tab switches: movie → tv → anime → movie restored
   全部/近期热度/日本. Selecting a normal category chip while in 全部 switches back to the 分类/地区 rows.
2. **Favourites.** `App.Favorites` cache in app.js (load after login in both app.js boot and accounts.js login; reset
   on user change/logout; `set/has/findByKey/put/remove`). detail.js: `收藏`/`已收藏` button in the actions row (after
   继续观看, before 重新测速), OK toggles via `API.addFavorite(key, {title, cover, source_name, year, total_episodes,
   save_time, search_title})` / `API.removeFavorite(key)` with key = `source+'+'+id` of the current source; GREEN (404)
   toggles anywhere in the detail view; button re-renders when the source changes. home.js: row
   `{key:'favorites', title:'我的收藏', kind:'fav'}` right after 继续观看, rendered with new `Cards.fav` (poster, title,
   source_name, `N集` badge when total_episodes>1, no progress bar). OK on a favourite opens detail via the same
   `openRecord` path (detail only — no player push since a favourite has no index). Home now re-renders 继续观看/我的收藏
   from the caches on every re-enter so a toggle on the detail page is reflected immediately.
3. **新番放送.** Row `{key:'bangumi', title:'新番放送', kind:'bangumi'}` between 热门剧集 and 热门动漫; `Cards.bangumi`
   = poster via `API.poster`, weekday badge top-left (`.badge.day`), pink rating badge top-right when rate non-empty.
   OK → `App.go('search', {q: title, auto: true, autoOpen: true})`.
4. **清空 继续观看.** RED (403) with focus in `row-continue`: first press toasts "再按红键清空继续观看" (5 s), second press
   within 5 s calls `API.clearRecords()`, then `App.Records.set([])` and re-render. RED elsewhere is ignored; the arm is
   reset on leave/reset. Hint on the row title: "按确认键继续播放 · 红键 清空".
5. **player.js — skip intro/outro.** On enter, `API.skipConfig(source+id)`; if `enable && intro_time>0` and no resume
   position, seek to intro_time once after loadedmetadata (also if the config arrives slightly later, while still within
   the first 5 s) and toast "已跳过片头". If `enable && outro_time>0`, in `timeupdate` once per episode when
   `currentTime >= duration - outro_time` → toast "已跳过片尾" + existing `nextEpisode()`. YELLOW (405) saves
   `{enable, intro_time: floor(currentTime), outro_time: existing}`; BLUE (406) saves
   `outro_time = floor(duration - currentTime)`; both become `enable:false` when both are 0. Toasts show the saved
   values. OSD hint line added (right-aligned, same row as the existing hint):
   "跳过片头片尾：黄键 设为片头结束点 · 蓝键 设为片尾开始点".
6. **CSS** for `.badge.day`, `.card-fav .badge.eps`, `.chips-wrap`/`.chips.strip`, `#detail-actions .btn.fav(.on)`,
   `#osd-hint-skip` — gold focus ring, dark cards, -webkit- flex only.

## Files changed

- `app/js/app.js` — `App.Favorites` cache (load/set/has/findByKey/put/remove), loaded after auto-login, reset on user change / logout; exported.
- `app/js/accounts.js` — `App.Favorites.load()` after an explicit login.
- `app/js/cards.js` — `Cards.fav`, `Cards.bangumi`.
- `app/js/browse.js` — 全部 chip, advanced rows (`advGroups`, `advParams`, `switchMode`, `advQuery`, horizontally scrolling strip rows), `/list/advanced` paging, per-type state restore.
- `app/js/home.js` — ROWS order (continue, favorites, movie, tv, bangumi, anime, show), `buildCard`, favourites cache sync from `/home`, RED two-press 清空, `refreshContinue` on every re-enter, favourite OK → detail.
- `app/js/detail.js` — 收藏/已收藏 button (`favKey/isFav/toggleFav`), GREEN key, actions re-render on source change.
- `app/js/player.js` — skip config load/apply (`loadSkip/maybeSkipIntro/maybeSkipOutro/saveSkip/setIntroHere/setOutroHere`), YELLOW/BLUE keys, per-episode guards.
- `app/index.html` — `#osd-hint-skip` line.
- `app/css/app.css` — styles listed above.
- `test/walk-features.js` (new) — puppeteer walk-through for these features (writes `test/shots-features/`).
- `test/shots-features/*.png` (new, 24 screenshots).

Not touched: `api-go/`, `api/`, `app/js/api.js` (was already modified in the worktree before this task). No ares-install.

## ES5 gate

```
cd /tmp/cdp && for f in /srv/pi-shared/ting/webos-moontv/app/js/*.js; do node -e "require('acorn').parse(require('fs').readFileSync('$f','utf8'),{ecmaVersion:5})" || echo FAIL $f; done
```
Output: (nothing) — pass.

## Puppeteer walk-through

`NODE_PATH=/tmp/moontv-shots/node_modules BRIDGE=http://127.0.0.1:8798 node test/walk-features.js` → **ALL OK**, 129 assertions,
**page errors: 0** (only console noise is Chrome's automatic `/favicon.ico` 404, pre-existing). Screenshots in
`/srv/pi-shared/ting/webos-moontv/test/shots-features/`:

- (a) `11-browse-movie-all.png` (全部 selected, 5 rows), `12-browse-movie-all-sort-hot.png` (近期热度),
  `13-browse-movie-all-japan.png` (地区 = 日本, grid loaded: 千与千寻 / 你的名字 / 哈尔的移动城堡 …),
  `14-browse-movie-all-region-end.png` (地区 strip scrolled to 丹麦), `15-browse-movie-all-page2.png` (paging >24),
  `16-browse-tv.png` (tv first row [全部 | 最近热门]), `17-browse-movie-restored.png` (state restored after tab switch),
  `18-browse-movie-normal-again.png` (back to normal rows).
- (b) `40-home-favorites.png` (我的收藏 row with the fav card: 47集 badge, no progress bar), `41-home-bangumi.png`
  (新番放送 row with 星期四 + rating badges), `42-search-from-bangumi.png` (OK → search prefilled), `61-home-final.png`.
- (c) `21-detail-before-fav.png`, `22-detail-favorited.png` (已收藏 button focused + toast), `23-detail-green-toggled.png`
  (GREEN removed + re-added), `60-detail-from-favorite.png` (opened from the 我的收藏 card, shows 已收藏).
- (d) `30-player-osd-skip-hint.png` (OSD with the skip hint line), `31-player-yellow.png`.
- (4) `50-home-red-armed.png` (first RED → toast "再按红键清空继续观看", records intact; second press deliberately not sent).
- Extra skip-behaviour run (`/tmp/skip-check*.js`, temporary configs restored afterwards): `32-player-intro-skipped.png`
  (intro_time=30 → currentTime 30, toast 已跳过片头; resume at 120 s not overridden), `33-player-outro-next.png`
  (outro reached → 第02集 + toast 已跳过片尾), `34-player-yellow-intro-set.png` (YELLOW @97 s → `{enable:true,intro_time:96}`),
  `35-player-blue-outro-set.png` (BLUE @ dur-196 s → `outro_time:197`, toast "已保存：片头 01:36，片尾前 03:17").

User data left as found on the upstream: favourites `[]` (test favourite removed), play records `['zy360+68966']`
(the test record created by the player walk was deleted), skip config for `zy360+105464` restored to
`{enable:false,intro_time:0,outro_time:0}` (its pre-existing value).

## Not verified / residual risks

- Real LG TV / webOS native HLS not run (desktop Chrome via hls.js shim; no ares-install per instructions).
- 清空 second press (actual `DELETE /record`) not exercised end-to-end to avoid wiping the user's 继续观看; the first-press
  arm/toast and the ignore-outside-row paths were. The API call itself is the pre-existing `API.clearRecords()`.
- Skip outro uses the hls.js duration in the simulator; on native HLS `duration` may be Infinity for live-style
  playlists, in which case outro skipping and BLUE are (deliberately) inert.
- The favourite row shows at most 20 items (same cap as 继续观看 in `refreshContinue`); `/home` itself returns all.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "All requested features implemented only in app/ (js/css/html) plus a new test walk script; api-go/, api/ and api.js untouched; ES5 gate prints nothing; test/walk-features.js ALL OK with 129 assertions and 0 page errors; screenshots in test/shots-features/."
    }
  ],
  "changedFiles": [
    "app/js/app.js",
    "app/js/accounts.js",
    "app/js/cards.js",
    "app/js/browse.js",
    "app/js/home.js",
    "app/js/detail.js",
    "app/js/player.js",
    "app/index.html",
    "app/css/app.css",
    "test/walk-features.js",
    "test/shots-features/ (24 png)"
  ],
  "testsAddedOrUpdated": [
    "test/walk-features.js"
  ],
  "commandsRun": [
    {
      "command": "cd api-go && CGO_ENABLED=0 go build -o /tmp/moontv-api-go . && MOONTV_PORT=8798 ... /tmp/moontv-api-go",
      "result": "passed",
      "summary": "local bridge built and serving app at http://127.0.0.1:8798/tv/"
    },
    {
      "command": "cd /tmp/cdp && for f in app/js/*.js; do node -e \"require('acorn').parse(...,{ecmaVersion:5})\" || echo FAIL $f; done",
      "result": "passed",
      "summary": "no output (all files parse as ES5)"
    },
    {
      "command": "NODE_PATH=/tmp/moontv-shots/node_modules BRIDGE=http://127.0.0.1:8798 node test/walk-features.js",
      "result": "passed",
      "summary": "ALL OK, 129 ok assertions, page errors: 0, user data restored"
    },
    {
      "command": "NODE_PATH=/tmp/moontv-shots/node_modules node /tmp/skip-check.js && node /tmp/skip-check2.js",
      "result": "passed",
      "summary": "intro seek to 30s + toast, resume not overridden, outro auto-next to 第02集, YELLOW/BLUE save correct values; configs restored"
    }
  ],
  "validationOutput": [
    "ES5 gate: (empty)",
    "walk-features: ALL OK / page errors: 0",
    "upstream after run: favorites [], records ['zy360+68966'], skip zy360+105464 {enable:false,intro_time:0,outro_time:0}"
  ],
  "residualRisks": [
    "Not run on a real webOS TV (desktop Chrome + hls.js shim only; no ares-install)",
    "Second RED press (actual clearRecords) deliberately not exercised to keep the user's 继续观看 data",
    "Native HLS with Infinity duration makes outro skip / BLUE inert by design"
  ],
  "noStagedFiles": true,
  "diffSummary": "9 app files changed (+391/-38): Favorites cache, 全部 advanced browse with scrolling chip strips, 我的收藏 + 新番放送 home rows and cards, RED 清空 two-press, detail 收藏 button + GREEN, player skip intro/outro with YELLOW/BLUE and OSD hint, CSS; new puppeteer walk test + screenshots",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "Local bridge left running on :8798 (pid via pgrep moontv-api-go) for the parent's own inspection; kill it when done. api-go/ and app/js/api.js were already modified in the worktree before this task and were not touched."
}
```
