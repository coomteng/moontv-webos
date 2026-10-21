# MoonTV for LG webOS (com.ting.moontv)

TV-native front-end for MoonTV, built for the Chrome 53 WebView of webOS 4.x (ES5 + flexbox only).
Data comes from the bridge service in `../api-go/`, which logs into MoonTV and exposes CORS-enabled JSON
plus cached posters (see `../README.md` for deployment).

## Configure
`js/api.js` has `BASE = 'http://BRIDGE_HOST:8788'`; `tools/build_ipk.sh` replaces the placeholder with `BRIDGE_BASE`
from `local.env` at package time. When the app is served by the bridge itself (`/tv/`, used by the simulator) it
uses the same origin and needs no configuration.

## Build & install
```bash
npm install -g @webos-tools/cli
ares-setup-device            # register your TV (Developer Mode app: Key Server ON)
echo 'BRIDGE_BASE=http://<bridge-host>:8788' > local.env   # git-ignored
tools/build_ipk.sh           # substitutes the bridge address and runs ares-package → dist/
# (or edit BASE in app/js/api.js by hand and run: ares-package app -o dist)
ares-install --device <tv> dist/com.ting.moontv_<ver>_all.ipk
ares-launch  --device <tv> com.ting.moontv
ares-inspect --device <tv> --app com.ting.moontv      # Chrome DevTools tunnel
```
Bump `"version"` in `appinfo.json` when changing files (the ipk filename follows it).

## Local checks (no TV needed)
- Browser simulator with on-screen remote: `http://<bridge-host>:8788/` (served by the bridge; same app, hls.js for playback).
- ES5 gate: `for f in app/js/*.js; do node -e "require('acorn').parse(require('fs').readFileSync('$f','utf8'),{ecmaVersion:5})"; done`
- Headless walk-throughs with puppeteer-core + Chrome: `node test/walk.js` (core flows) and `node test/walk-features.js`
  (全部 filters, favourites, 新番放送, clear history, skip intro/outro; 129 assertions, screenshots to `test/shots-features/`).

## Pinyin keyboard vocabulary
1. **Live titles (automatic)** — fetched from the bridge `GET /titles` on start and hourly; built from MoonTV hot
   lists, your play records and search history (cached 30 min on the bridge). New shows become typeable with no reinstall.
2. **Built-in table (`js/pinyin-data.js`, ~530 KB)** — 3500 chars + 20k words from jieba frequencies plus
   `tools/titles.txt` boosted to the top. Rebuild occasionally: `pip install pypinyin jieba && python3 tools/gen_pinyin.py`.

## Accounts
The bridge logs in with its default account (`MOONTV_USER`). A TV can additionally log in as any MoonTV user:
`POST /login {username,password}` returns a session token, sent as `X-Session` on every request; per-user data
(play records, 继续观看) then comes from that account. Credentials are remembered in the TV's `localStorage`
(obfuscated, not encrypted) so they are entered once; on bridge restart the app re-logs in silently.
To pre-provision accounts on every TV's first start, set `MOONTV_SEED_ACCOUNTS="user:pass,user2:pass2"` on the bridge
(served at `/seed-accounts` to the LAN; the TV imports them once and logs in as the first).

## Views
- **Home** — rows in the web's order: 继续观看 (red key twice clears it), 我的收藏, 热门电影, 热门剧集, 新番放送, 热门动漫, 热门综艺.
- **Browse** (电影 / 剧集 / 动漫 / 综艺) — the web's chips, from `/filters`; the 全部 chip switches to the advanced
  groups from `/filters/advanced` (排序 / 类型 / 地区 / 年代 / 平台) and queries `/list/advanced`. Grid pages in via `start`.
- **Search** — pinyin keyboard (or phone), results grouped by title, OK opens detail.
- **Detail** — sources are probed via `/probe` (latency, speed, resolution) and sorted; the best working one is
  preselected unless you picked one or are resuming on a source that still works. Buttons: 继续观看, 收藏/已收藏
  (also green key), 重新测速 (also yellow key). Episode grid below.
- **Player** — native HLS. OSD on any key. Skip config from `/skip` is applied (seek past the intro when starting
  from 0; auto-next at the outro point). Yellow = set intro end at the current position, blue = set outro start.
- **Login** — account picker with remembered users, add-user form, red key twice removes a user. See Accounts.

## Phone as keyboard
When the on-screen keyboard opens, the app registers a channel on the bridge (`POST /remote/new`, id persisted in
`localStorage` so a bookmarked phone page keeps working) and shows a QR code for `http://<bridge>:8788/r/<id>`.
The phone page POSTs text to `/remote/<id>/send` (`action: input|submit`); the TV long-polls `/remote/<id>/poll`.
Channels are in-memory, LAN-only, ids are random; needs `qrcode` on the bridge (in the Dockerfile).

## Remote keys
| Key | Home | Detail | Player | Keyboard | Login picker |
|---|---|---|---|---|---|
| ←→↑↓ | move | move | seek ±10 s / episode strip | move | move |
| OK | open | play / toggle button | play-pause | type / pick | log in |
| Back (461) | exit app | back | back (saves position) | delete / close | exit app |
| Red (403) | ×2 clear 继续观看 | — | — | delete | ×2 remove user |
| Green (404) | — | favourite / unfavourite | — | first candidate | — |
| Yellow (405) | — | re-probe sources | set intro end here | 中/EN | — |
| Blue (406) | — | — | set outro start here | submit | — |
| Digits | — | — | — | pick candidate | — |
| Play / Pause / Stop / FF / RW | — | — | as labelled (FF/RW ±60 s) | — | — |
