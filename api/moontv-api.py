#!/usr/bin/env python3
"""
moontv-api: thin JSON bridge between the LG TV app and MoonTV.

The TV app runs from file:// and cannot carry MoonTV's auth cookie, so this
service logs in on its behalf, calls MoonTV, and returns compact JSON with
permissive CORS. Posters are cached on disk.

Endpoints (all GET unless noted):
  /home                        continue-watching + hot movies + hot tv + hot anime + hot show
  /search?q=                   MoonTV /api/search, results grouped by title
  /detail?source=&id=          MoonTV /api/detail
  /list?type=movie|tv|anime|show&tag=热门&start=0&size=24   douban lists
  /poster?url=                 image, cached 7 days
  /record  (GET)               all play records
  /record  (POST {key,record}) save a play record
  /probe   (POST {items:[{source,source_name,url}], fresh?})  HLS speed/quality probe, cached 15 min;
                               fresh:true re-measures (the TV's 重新测速 button)
  /health

Python 3 stdlib only.
"""
import concurrent.futures
import gzip
import hashlib
import http.server
import json
import os
import re
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

UPSTREAM = os.environ.get("MOONTV_UPSTREAM", "http://moontv-core:3000")
USERNAME = os.environ.get("MOONTV_USER", "")
PASSWORD = os.environ.get("MOONTV_PASS", "")
LISTEN_HOST = os.environ.get("MOONTV_LISTEN", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("MOONTV_PORT", "8788"))
CACHE_DIR = os.environ.get("MOONTV_CACHE", os.path.expanduser("~/.cache/moontv-api"))
POSTER_TTL = 7 * 24 * 3600
LIST_TTL = 10 * 60  # douban lists change slowly; cache in memory 10 min


def log(msg):
    sys.stderr.write("[moontv-api] %s\n" % msg)
    sys.stderr.flush()


# --------------------------------------------------------------------------- upstream
class Upstream:
    def __init__(self):
        self._lock = threading.Lock()
        self._cookie = None
        self._at = 0.0

    def _login(self):
        body = json.dumps({"username": USERNAME, "password": PASSWORD}).encode()
        req = urllib.request.Request(UPSTREAM + "/api/login", data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            for c in r.headers.get_all("Set-Cookie") or []:
                kv = c.split(";", 1)[0].strip()
                if kv.startswith("auth="):
                    log("login ok")
                    return kv
        raise RuntimeError("login response had no auth cookie")

    def cookie(self, force=False):
        with self._lock:
            if self._cookie and not force:
                return self._cookie
            if force and self._cookie and time.time() - self._at < 2:
                return self._cookie
            self._cookie = self._login()
            self._at = time.time()
            return self._cookie

    def call(self, path, method="GET", body=None, raw=False, timeout=60):
        """Call MoonTV with auth; retry once on 401. Returns parsed JSON (or bytes, ctype if raw)."""
        data = json.dumps(body).encode() if body is not None else None
        for attempt in (0, 1):
            headers = {"Cookie": self.cookie(force=attempt == 1), "Accept-Encoding": "identity"}
            if data is not None:
                headers["Content-Type"] = "application/json"
            req = urllib.request.Request(UPSTREAM + path, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    payload = r.read()
                    if raw:
                        return payload, r.headers.get("Content-Type", "application/octet-stream")
                    return json.loads(payload) if payload else None
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 0:
                    log("401 on %s, re-login" % path)
                    continue
                raise
        raise RuntimeError("unreachable")


UP = Upstream()

# --------------------------------------------------------------------------- caches
_mem = {}
_mem_lock = threading.Lock()


def mem_cached(key, ttl, fn):
    with _mem_lock:
        hit = _mem.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
    val = fn()
    with _mem_lock:
        _mem[key] = (time.time(), val)
    return val


def poster_cached(url):
    os.makedirs(CACHE_DIR, exist_ok=True)
    f = os.path.join(CACHE_DIR, hashlib.sha1(url.encode()).hexdigest())
    try:
        if time.time() - os.path.getmtime(f) < POSTER_TTL:
            with open(f, "rb") as fh:
                ctype = fh.readline().decode().strip()
                return fh.read(), ctype
    except OSError:
        pass
    data, ctype = UP.call("/api/image-proxy?url=" + urllib.parse.quote(url, safe=""), raw=True, timeout=30)
    tmp = f + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(ctype.encode() + b"\n" + data)
    os.replace(tmp, f)
    return data, ctype


# --------------------------------------------------------------------------- shaping
def q(s):
    return urllib.parse.quote(s, safe="")


def slim_douban(items):
    return [{"id": i.get("id"), "title": i.get("title"), "poster": i.get("poster"),
             "rate": i.get("rate"), "year": i.get("year")} for i in items or []]


# Filter chips offered to the TV app, mirroring MoonTV's web UI.
# Each entry: label -> upstream request builder args.
#   movie: /api/douban/categories?kind=movie&category=<cat>&type=<region>
#   tv:    /api/douban/categories?kind=tv&category=最近热门&type=<type>
#   anime/show: same tv categories endpoint with fixed type
FILTERS = {
    "movie": {"cats": ["热门", "最新", "豆瓣高分", "冷门佳片"], "regions": ["全部", "华语", "欧美", "韩国", "日本"]},
    "tv":    {"cats": ["全部", "国产剧", "欧美剧", "韩剧", "日剧", "港剧"], "regions": []},
    "anime": {"cats": ["动画"], "regions": []},
    "show":  {"cats": ["综艺"], "regions": []},
}
TV_TYPE = {"全部": "tv", "国产剧": "国产剧", "欧美剧": "欧美剧", "韩剧": "韩剧", "日剧": "日剧", "港剧": "港剧",
           "动画": "动画", "综艺": "综艺"}


def douban_list(kind, tag, region, start, size):
    tag = tag or FILTERS[kind]["cats"][0]
    region = region or "全部"

    def fetch():
        if kind == "movie":
            path = "/api/douban/categories?kind=movie&category=%s&type=%s&limit=%d&start=%d" % (q(tag), q(region), size, start)
        else:
            path = "/api/douban/categories?kind=tv&category=%s&type=%s&limit=%d&start=%d" % (q("最近热门"), q(TV_TYPE.get(tag, tag)), size, start)
        res = UP.call(path)
        return slim_douban((res or {}).get("list"))
    return mem_cached("douban:%s:%s:%s:%d:%d" % (kind, tag, region, start, size), LIST_TTL, fetch)


def continue_watching(limit=20):
    recs = UP.call("/api/playrecords") or {}
    items = []
    for key, r in recs.items():
        if "+" not in key:
            continue
        source, vid = key.split("+", 1)
        items.append({
            "key": key, "source": source, "id": vid,
            "title": r.get("title"), "poster": r.get("cover"), "year": r.get("year"),
            "source_name": r.get("source_name"), "index": r.get("index", 1),
            "total_episodes": r.get("total_episodes", 1),
            "play_time": r.get("play_time", 0), "total_time": r.get("total_time", 0),
            "save_time": r.get("save_time", 0), "search_title": r.get("search_title", ""),
        })
    items.sort(key=lambda x: x["save_time"], reverse=True)
    return items[:limit]


def search(query):
    res = UP.call("/api/search?q=" + q(query), timeout=90) or {}
    out = []
    for r in res.get("results", []):
        out.append({
            "source": r.get("source"), "source_name": r.get("source_name"), "id": r.get("id"),
            "title": r.get("title"), "poster": r.get("poster"), "year": r.get("year"),
            "type_name": r.get("type_name"), "class": r.get("class"), "desc": (r.get("desc") or "")[:300],
            "episodes": r.get("episodes") or [], "episodes_titles": r.get("episodes_titles") or [],
            "douban_id": r.get("douban_id"),
        })
    # group by (title, year): one card per title, listing all sources
    groups, order = {}, []
    for r in out:
        gk = (r["title"], r["year"])
        if gk not in groups:
            groups[gk] = {"title": r["title"], "year": r["year"], "poster": r["poster"],
                          "type_name": r["type_name"], "sources": []}
            order.append(gk)
        g = groups[gk]
        if not g["poster"] and r["poster"]:
            g["poster"] = r["poster"]
        g["sources"].append(r)
    return [groups[k] for k in order]


# --------------------------------------------------------------------------- title index for the TV IME
try:
    from pypinyin import lazy_pinyin  # optional; /titles returns [] without it
except ImportError:  # pragma: no cover
    lazy_pinyin = None

TITLES_TTL = 30 * 60
_HAN_RE = re.compile(r"[\u4e00-\u9fff]")


def _title_variants(t):
    """'现在就出发 第四季' -> ['现在就出发 第四季', '现在就出发']; keep only titles with CJK chars."""
    t = (t or "").strip()
    # must start with a CJK char: pinyin of "2026年..." would be indexed under "nian", which is misleading
    if not t or not _HAN_RE.match(t[0]):
        return []
    out = [t]
    base = re.split(r"\s+|第[\d一-十百]+[季部集]|[：:·\-—(（]", t)[0].strip()
    if base and base != t and len(base) >= 2:
        out.append(base)
    return out


def build_titles():
    """Collect titles from hot lists, play records and search history; return {pinyin: [title,...]} plus initials."""
    if not lazy_pinyin:
        return {"full": {}, "initials": {}, "count": 0}
    weight = {}  # title -> weight (records/history first)

    def add(t, w):
        for v in _title_variants(t):
            weight[v] = max(weight.get(v, 0), w)

    try:
        for r in continue_watching(limit=200):
            add(r.get("title"), 3)
    except Exception as e:  # noqa: BLE001
        log("titles: records failed %r" % (e,))
    try:
        for q_ in UP.call("/api/searchhistory") or []:
            add(q_, 3)
    except Exception as e:  # noqa: BLE001
        log("titles: history failed %r" % (e,))
    for kind, tag, region in (("movie", "热门", "全部"), ("movie", "最新", "全部"), ("tv", "全部", None),
                              ("tv", "国产剧", None), ("tv", "欧美剧", None), ("tv", "韩剧", None), ("tv", "日剧", None),
                              ("anime", "动画", None), ("show", "综艺", None)):
        for start in (0, 24, 48):
            try:
                for it in douban_list(kind, tag, region, start, 24):
                    add(it.get("title"), 1)
            except Exception as e:  # noqa: BLE001
                log("titles: list %s/%s failed %r" % (kind, tag, e))
                break
    full, initials = {}, {}
    for t, w in weight.items():
        syl = lazy_pinyin(t)
        syl = [s for s in syl if re.match(r"^[a-z]+$", s)]
        if not syl:
            continue
        full.setdefault("".join(syl), []).append((w, t))
        if len(syl) >= 2:
            initials.setdefault("".join(s[0] for s in syl), []).append((w, t))

    def finish(d):
        return {k: [t for _, t in sorted(v, key=lambda x: -x[0])][:6] for k, v in d.items()}
    return {"full": finish(full), "initials": finish(initials), "count": len(weight)}


# --------------------------------------------------------------------------- stream probe
PROBE_UA = "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.34 Safari/537.36"
PROBE_SAMPLE_BYTES = 1536 * 1024   # download up to 1.5 MB of the first segment for speed
PROBE_TIMEOUT = 8
PROBE_TTL = 15 * 60


def _fetch(url, limit=None, timeout=PROBE_TIMEOUT):
    """GET url; returns (bytes, first_byte_ms, total_ms, final_url)."""
    req = urllib.request.Request(url, headers={"User-Agent": PROBE_UA, "Accept": "*/*"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        first = r.read(1)
        ttfb = (time.time() - t0) * 1000
        if limit:
            rest = r.read(limit - 1)
        else:
            rest = r.read()
        return first + rest, ttfb, (time.time() - t0) * 1000, r.geturl()


def _parse_m3u8(text, base):
    """Return dict: master? variants [(bandwidth, resolution, url)], segments [url], duration."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    out = {"master": False, "variants": [], "segments": [], "duration": 0.0}
    pending = None
    for i, l in enumerate(lines):
        if l.startswith("#EXT-X-STREAM-INF"):
            out["master"] = True
            bw = re.search(r"BANDWIDTH=(\d+)", l)
            res = re.search(r"RESOLUTION=(\d+x\d+)", l)
            pending = (int(bw.group(1)) if bw else 0, res.group(1) if res else None)
        elif l.startswith("#EXTINF"):
            try:
                out["duration"] += float(l[8:].split(",")[0])
            except ValueError:
                pass
        elif not l.startswith("#"):
            u = urllib.parse.urljoin(base, l)
            if pending is not None:
                out["variants"].append((pending[0], pending[1], u))
                pending = None
            else:
                out["segments"].append(u)
    return out


def probe_stream(url):
    """Measure one HLS url. Never raises; returns a dict with ok flag."""
    res = {"url": url, "ok": False, "latency_ms": None, "speed_kbps": None,
           "resolution": None, "bandwidth_kbps": None, "duration_s": None, "segments": None, "error": None}
    try:
        body, ttfb, _, final = _fetch(url)
        res["latency_ms"] = int(ttfb)
        text = body.decode("utf-8", "ignore")
        if "#EXTM3U" not in text[:200]:
            res["error"] = "not an m3u8"
            return res
        pl = _parse_m3u8(text, final)
        if pl["master"] and pl["variants"]:
            best = max(pl["variants"], key=lambda v: v[0])
            res["bandwidth_kbps"] = best[0] // 1000 if best[0] else None
            res["resolution"] = best[1]
            body2, _, _, final2 = _fetch(best[2])
            pl = _parse_m3u8(body2.decode("utf-8", "ignore"), final2)
        res["duration_s"] = int(pl["duration"])
        res["segments"] = len(pl["segments"])
        if not pl["segments"]:
            res["error"] = "empty playlist"
            return res
        # speed: time a bounded read of the first segment (skip tiny ad/intro segments if possible)
        seg = pl["segments"][min(1, len(pl["segments"]) - 1)]
        t0 = time.time()
        data, _, _, _ = _fetch(seg, limit=PROBE_SAMPLE_BYTES, timeout=PROBE_TIMEOUT + 4)
        dt = max(time.time() - t0, 0.001)
        res["speed_kbps"] = int(len(data) * 8 / dt / 1000)
        res["ok"] = len(data) > 0
        if not res["resolution"] and len(data) > 376:
            res["resolution"] = _guess_resolution(data)
    except urllib.error.HTTPError as e:
        res["error"] = "HTTP %d" % e.code
    except Exception as e:  # noqa: BLE001
        res["error"] = type(e).__name__ + (": " + str(e) if str(e) else "")
    return res


def _guess_resolution(ts):
    """Best-effort H.264 SPS scan in a TS sample to find coded width/height. Returns 'WxH' or None."""
    try:
        i = ts.find(b"\x00\x00\x01\x67")
        if i < 0:
            return None
        sps = ts[i + 4:i + 4 + 64]
        # strip emulation prevention bytes
        sps = sps.replace(b"\x00\x00\x03", b"\x00\x00")
        bits = "".join("{:08b}".format(b) for b in sps)
        pos = [8]  # skip profile_idc; then constraint flags + level
        pos[0] = 24

        def ue():
            z = 0
            while bits[pos[0]] == "0":
                z += 1
                pos[0] += 1
            pos[0] += 1
            v = int(bits[pos[0]:pos[0] + z], 2) if z else 0
            pos[0] += z
            return (1 << z) - 1 + v

        def se():
            k = ue()
            return (k + 1) // 2 if k % 2 else -(k // 2)

        profile = sps[0]
        ue()  # seq_parameter_set_id
        if profile in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
            cf = ue()
            if cf == 3:
                pos[0] += 1
            ue(); ue(); pos[0] += 1
            if bits[pos[0] - 1] == "1":
                for _ in range(8 if cf != 3 else 12):
                    if bits[pos[0]] == "1":
                        return None  # scaling lists: too complex for a guess
                    pos[0] += 1
        ue()  # log2_max_frame_num
        poc = ue()
        if poc == 0:
            ue()
        elif poc == 1:
            pos[0] += 1; se(); se()
            for _ in range(ue()):
                se()
        ue(); pos[0] += 1
        w = (ue() + 1) * 16
        h = (ue() + 1) * 16
        frame_mbs_only = bits[pos[0]]; pos[0] += 1
        if frame_mbs_only == "0":
            pos[0] += 1
            h *= 2
        pos[0] += 1
        if bits[pos[0]] == "1":
            pos[0] += 1
            l, r_, t, b = ue(), ue(), ue(), ue()
            w -= (l + r_) * 2
            h -= (t + b) * 2 * (1 if frame_mbs_only == "1" else 2)
        if 64 <= w <= 8192 and 64 <= h <= 8192:
            return "%dx%d" % (w, h)
    except Exception:  # noqa: BLE001
        pass
    return None


def probe_many(items, workers=8, fresh=False):
    """items: [{source, source_name, url}] -> same list with probe results merged. Cached per url
    for PROBE_TTL; fresh=True drops the cached rows first (the TV's 重新测速 button)."""
    if fresh:
        with _mem_lock:
            for it in items:
                _mem.pop("probe:" + str(it.get("url")), None)
    def one(it):
        url = it.get("url")
        if not url:
            return dict(it, ok=False, error="no url")
        r = mem_cached("probe:" + url, PROBE_TTL, lambda: probe_stream(url))
        out = dict(it)
        out.update(r)
        return out
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(one, items))


# --------------------------------------------------------------------------- http
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "moontv-api/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("MOONTV_VERBOSE"):
            http.server.BaseHTTPRequestHandler.log_message(self, fmt, *args)

    # -- helpers
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, status, data, ctype="application/json; charset=utf-8", cache=None):
        if "gzip" in (self.headers.get("Accept-Encoding") or "") and len(data) > 1024 \
                and (ctype.startswith("application/json") or ctype.startswith("text/")):
            data = gzip.compress(data, 5)
            enc = "gzip"
        else:
            enc = None
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", ctype)
        if enc:
            self.send_header("Content-Encoding", enc)
        if cache:
            self.send_header("Cache-Control", "public, max-age=%d" % cache)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, obj, status=200, cache=None):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode(), cache=cache)

    def _error(self, status, msg):
        self._json({"error": msg}, status)

    # -- routes
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        p = u.path.rstrip("/") or "/"
        qs = urllib.parse.parse_qs(u.query)
        g = lambda k, d=None: (qs.get(k) or [d])[0]  # noqa: E731
        try:
            if p == "/health":
                return self._json({"ok": True, "upstream": UPSTREAM})
            if p == "/home":
                return self._json({
                    "continue": continue_watching(),
                    "movie": douban_list("movie", "热门", "全部", 0, 20),
                    "tv": douban_list("tv", "全部", None, 0, 20),
                    "anime": douban_list("anime", "动画", None, 0, 20),
                    "show": douban_list("show", "综艺", None, 0, 20),
                })
            if p == "/filters":
                return self._json(FILTERS, cache=3600)
            if p == "/titles":
                return self._json(mem_cached("titles", TITLES_TTL, build_titles), cache=600)
            if p == "/list":
                kind = g("type", "movie")
                if kind not in FILTERS:
                    return self._error(400, "bad type")
                return self._json(douban_list(kind, g("tag"), g("region"), int(g("start", 0)), int(g("size", 24))))
            if p == "/search":
                query = (g("q") or "").strip()
                if not query:
                    return self._json([])
                return self._json(search(query))
            if p == "/detail":
                src, vid = g("source"), g("id")
                if not src or not vid:
                    return self._error(400, "source and id required")
                return self._json(UP.call("/api/detail?source=%s&id=%s" % (q(src), q(vid))))
            if p == "/record":
                return self._json(continue_watching(limit=200))
            if p == "/probe":
                url = g("url")
                if not url:
                    return self._error(400, "url required")
                return self._json(probe_many([{"url": url}])[0])
            if p == "/poster":
                url = g("url")
                if not url:
                    return self._error(400, "url required")
                data, ctype = poster_cached(url)
                return self._send(200, data, ctype, cache=POSTER_TTL)
            return self._error(404, "not found")
        except urllib.error.HTTPError as e:
            log("upstream HTTP %s for %s" % (e.code, self.path))
            return self._error(502, "upstream HTTP %s" % e.code)
        except Exception as e:  # noqa: BLE001
            log("error on %s: %r" % (self.path, e))
            return self._error(500, repr(e))

    def do_POST(self):
        p = urllib.parse.urlsplit(self.path).path.rstrip("/")
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._error(400, "invalid json")
        try:
            if p == "/probe":
                items = body.get("items") if isinstance(body, dict) else body
                if not isinstance(items, list) or not items:
                    return self._error(400, "items[] required")
                fresh = bool(body.get("fresh")) if isinstance(body, dict) else False
                return self._json(probe_many(items[:40], fresh=fresh))
            if p == "/record":
                key, rec = body.get("key"), body.get("record")
                if not key or not isinstance(rec, dict):
                    return self._error(400, "key and record required")
                rec.setdefault("save_time", int(time.time() * 1000))
                UP.call("/api/playrecords", method="POST", body={"key": key, "record": rec})
                return self._json({"ok": True})
            return self._error(404, "not found")
        except urllib.error.HTTPError as e:
            return self._error(502, "upstream HTTP %s" % e.code)
        except Exception as e:  # noqa: BLE001
            log("error on %s: %r" % (self.path, e))
            return self._error(500, repr(e))

    do_HEAD = do_GET


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    if not USERNAME or not PASSWORD:
        log("MOONTV_USER and MOONTV_PASS must be set")
        sys.exit(2)
    log("listening on %s:%d -> %s" % (LISTEN_HOST, LISTEN_PORT, UPSTREAM))
    try:
        UP.cookie()
    except Exception as e:  # noqa: BLE001
        log("initial login failed (will retry on demand): %r" % (e,))
    Server((LISTEN_HOST, LISTEN_PORT), Handler).serve_forever()
