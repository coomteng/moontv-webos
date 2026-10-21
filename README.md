# MoonTV for LG webOS

A remote-control-friendly front end for [MoonTV / LunaTV](https://github.com/MoonTechLab/LunaTV) that runs on
**old LG webOS TVs (webOS 4.x, Chrome 53 WebView)** where the stock MoonTV web UI cannot run (it needs ES2018+).

```
TV app (ES5 + flexbox, com.ting.moontv) ──JSON──▶ moontv-api (Python, Docker sidecar) ──▶ MoonTV :3000
                                     └── <video src=m3u8> plays HLS natively
```

| Dir | What |
|---|---|
| `app/` | The webOS app: home rows, category browse with filters, search with a **built-in pinyin keyboard**, detail with **per-source speed/resolution probing**, HLS player with resume. See `app/README.md`. |
| `api/` | `moontv-api.py`: stdlib-only bridge that logs into MoonTV, exposes CORS JSON (`/home /list /search /detail /record /poster /probe /titles`), caches posters, probes stream quality. Dockerfile + compose snippet included. |
| `tools/` | `gen_pinyin.py` builds `app/js/pinyin-data.js` from jieba + pypinyin. |
| `test/` | Headless Chrome walk-through (`walk.js`) used to verify the app at 1920×1080 without a TV. |

## Quick start
1. **Bridge** — copy `api/` next to your MoonTV `docker-compose.yml` as `moontv-api/`, merge `api/compose.snippet.yml`
   into the stack (same network as `moontv-core`), set `MOONTV_USER` / `MOONTV_PASS` (a MoonTV login), expose 8788.
   Standalone: `docker build -t moontv-api api && docker run -e MOONTV_UPSTREAM=http://<moontv>:3000 -e MOONTV_USER=… -e MOONTV_PASS=… -p 8788:8788 moontv-api`.
   Update after edits: `docker build -t moontv-api:local moontv-api && docker restart moontv-api`.
2. **App** — set `BASE` in `app/js/api.js` to `http://<bridge-host>:8788`, then
   `ares-package app -o dist && ares-install --device <tv> dist/*.ipk` (LG Developer Mode required). Details in `app/README.md`.

Why a bridge: the app is loaded from `file://`, so it cannot carry MoonTV's `SameSite=lax` auth cookie; the bridge
logs in on its behalf. Only the Python stdlib is used (plus optional `pypinyin` for the live title index).

## Remote keys
←→↑↓ move · OK select / play-pause · Back go back (in player: exit; in keyboard: delete/close) · in player ←→ seek ±10 s ·
yellow = re-probe sources (detail) / 中-EN (keyboard) · red/green/blue in keyboard = delete / first candidate / search ·
digits pick candidates.

## License
MIT
