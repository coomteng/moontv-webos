# MoonTV for LG webOS

A remote-control-friendly front end for [MoonTV / LunaTV](https://github.com/MoonTechLab/LunaTV) that runs on
**old LG webOS TVs (webOS 4.x, Chrome 53 WebView)** where the stock MoonTV web UI cannot run (it needs ES2018+).

![Home](docs/screenshots/01-home.jpg)

| Category browsing with filters | Built-in pinyin keyboard |
|---|---|
| ![Browse](docs/screenshots/02-browse.jpg) | ![Pinyin keyboard](docs/screenshots/03-pinyin-keyboard.jpg) |

## Features
- **Runs on Chrome 53** — plain ES5 + flexbox, no framework, no build step; an acorn `ecmaVersion: 5` gate keeps it that way.
- **Remote-first UI** — deterministic focus navigation, big type, dark theme; Back key (461) handled in JS.
- **Pinyin keyboard** — EU TVs ship no Chinese IME; the app includes one (full/abbreviated pinyin, prefix completion, live title index so new entries are typeable without reinstalling).
- **Multiple users** — accounts are remembered on the TV after the first login; the last user is logged in automatically at start; log out from the top bar to get a Netflix-style account picker (one OK press per user, red key removes one).
- **Browser simulator** — open `http://<bridge>:8788/` on any computer: a scaled 1920×1080 "TV" running the exact same app, plus an on-screen remote (keyboard mapped).

```
TV app (ES5 + flexbox, com.ting.moontv) ──JSON──▶ moontv-api (Python, Docker sidecar) ──▶ MoonTV :3000
```

| Dir | What |
|---|---|
| `app/` | The webOS app: home rows, category browse with filters, search with a **built-in pinyin keyboard**, detail view, player. See `app/README.md`. |
| `api/` | `moontv-api.py`: stdlib-only bridge that logs into MoonTV and exposes its API as CORS JSON for the TV (plus poster caching and a live title index for the keyboard). Dockerfile + compose snippet included. |
| `sim/` | Browser TV simulator page served by the bridge at `/sim` (`/` redirects there); the app itself is served at `/tv/`. |
| `tools/` | `gen_pinyin.py` builds `app/js/pinyin-data.js` from jieba + pypinyin. |
| `test/` | Headless Chrome walk-through (`walk.js`) used to verify the app at 1920×1080 without a TV. |

## Quick start
1. **Bridge** — copy `api/` next to your MoonTV `docker-compose.yml` as `moontv-api/`, merge `api/compose.snippet.yml`
   into the stack (same network as `moontv-core`), set `MOONTV_USER` / `MOONTV_PASS` (a MoonTV login), expose 8788.
   Standalone: `docker build -t moontv-api api && docker run -e MOONTV_UPSTREAM=http://<moontv>:3000 -e MOONTV_USER=… -e MOONTV_PASS=… -p 8788:8788 moontv-api`.
   Update after edits: `docker build -t moontv-api:local moontv-api && docker restart moontv-api`.
2. **App** — set `BASE` in `app/js/api.js` to `http://<bridge-host>:8788`, then
   `ares-package app -o dist && ares-install --device <tv> dist/*.ipk` (LG Developer Mode required). Details in `app/README.md`.

Testing without the TV: open `http://<bridge-host>:8788/` — the simulator loads the app from the same origin, so no
`BASE` edit is needed. On the TV the app is loaded from `file://` and uses the `BASE` constant instead.

Why a bridge: the app is loaded from `file://`, so it cannot carry MoonTV's `SameSite=lax` auth cookie; the bridge
logs in on its behalf. Only the Python stdlib is used (plus optional `pypinyin` for the live title index).

## Remote keys
←→↑↓ move · OK select · Back go back (in keyboard: delete/close) · keyboard: yellow 中/EN, red delete,
green first candidate, blue search, digits pick candidates.

## License
MIT
