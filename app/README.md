# MoonTV for LG webOS (com.ting.moontv)

TV-native front-end for MoonTV, built for the Chrome 53 WebView of webOS 4.x (ES5 + flexbox only).
Data comes from the bridge service `../api/moontv-api.py`, which logs into MoonTV and exposes CORS-enabled JSON
plus cached posters (see `../README.md` for deployment).

## Configure
Set `BASE` in `js/api.js` to your bridge URL, e.g. `http://192.168.1.10:8788`.

## Build & install
```bash
npm install -g @webos-tools/cli
ares-setup-device            # register your TV (Developer Mode app: Key Server ON)
ares-package app -o dist
ares-install --device <tv> dist/com.ting.moontv_<ver>_all.ipk
ares-launch  --device <tv> com.ting.moontv
ares-inspect --device <tv> --app com.ting.moontv      # Chrome DevTools tunnel
```
Bump `"version"` in `appinfo.json` when changing files (the ipk filename follows it).

## Local checks (no TV needed)
- Browser simulator with on-screen remote: `http://<bridge-host>:8788/` (served by the bridge; same app, hls.js for playback).
- ES5 gate: `for f in app/js/*.js; do node -e "require('acorn').parse(require('fs').readFileSync('$f','utf8'),{ecmaVersion:5})"; done`
- Headless walk-through with puppeteer-core + Chrome (screenshots to `test/`): `node test/walk.js`

## Pinyin keyboard vocabulary
1. **Live titles (automatic)** — fetched from the bridge `GET /titles` on start and hourly; built from MoonTV hot
   lists, your play records and search history (cached 30 min on the bridge). New shows become typeable with no reinstall.
2. **Built-in table (`js/pinyin-data.js`, ~530 KB)** — 3500 chars + 20k words from jieba frequencies plus
   `tools/titles.txt` boosted to the top. Rebuild occasionally: `pip install pypinyin jieba && python3 tools/gen_pinyin.py`.

## Remote keys
←→↑↓ move focus · OK select / play-pause · Back (461) go back / exit · in player ←→ seek ±10 s, ↑↓ episode strip ·
yellow = re-probe sources (detail) / 中-EN (keyboard) · keyboard: red delete, green first candidate, blue search, digits pick.
