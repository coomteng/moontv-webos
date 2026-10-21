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
  /login (POST {username,password}) -> {session}; send it back as X-Session header. /logout, /me
  /seed-accounts               accounts from MOONTV_SEED_ACCOUNTS, imported by a TV on first start
  /remote/new (POST), /remote/<id>/{qr.svg,poll,state,send}, /r/<id>   phone-as-keyboard for the TV
  /probe   (POST {items:[{source,source_name,url}], fresh?})  HLS speed/quality probe, cached 15 min;
                               fresh:true re-measures (the TV's 重新测速 button)
  /health

Python 3 stdlib only.
"""
import concurrent.futures
import random
import gzip
import hashlib
import http.server
import json
import mimetypes
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
# Optional: serve the TV app itself (for the browser simulator). Empty = disabled.
APP_DIR = os.environ.get("MOONTV_APP_DIR", "")
# Optional: accounts pre-provisioned to TVs on their first start, "user:pass,user2:pass2".
# Only served on the LAN by this bridge; the TV stores them locally and never asks again.
SEED_ACCOUNTS = [a.split(":", 1) for a in os.environ.get("MOONTV_SEED_ACCOUNTS", "").split(",") if ":" in a]
SIM_FILE = os.environ.get("MOONTV_SIM", "")


def log(msg):
    sys.stderr.write("[moontv-api] %s\n" % msg)
    sys.stderr.flush()


# --------------------------------------------------------------------------- upstream
class Upstream:
    """One MoonTV login (cookie) for one set of credentials."""

    def __init__(self, username, password):
        self.username = username
        self._password = password
        self._lock = threading.Lock()
        self._cookie = None
        self._at = 0.0

    def _login(self):
        body = json.dumps({"username": self.username, "password": self._password}).encode()
        req = urllib.request.Request(UPSTREAM + "/api/login", data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            for c in r.headers.get_all("Set-Cookie") or []:
                kv = c.split(";", 1)[0].strip()
                if kv.startswith("auth="):
                    log("login ok (%s)" % self.username)
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


UP = Upstream(USERNAME, PASSWORD)   # default account: shared/public data + TVs that never logged in


class AuthError(Exception):
    pass


class Sessions:
    """Opaque session tokens for TVs that logged in as another MoonTV user.

    Tokens live in memory (a bridge restart logs everyone out; the app then falls back to the
    default account and shows the login page again). Credentials are kept only to re-login
    when MoonTV's cookie expires; they never leave the process."""

    def __init__(self):
        self._lock = threading.Lock()
        self._by_token = {}

    def login(self, username, password):
        up = Upstream(username, password)
        try:
            up.cookie(force=True)           # validates the credentials against MoonTV now
        except urllib.error.HTTPError as e:
            raise AuthError("HTTP %d" % e.code)
        except Exception as e:  # noqa: BLE001
            raise AuthError(str(e) or type(e).__name__)
        token = hashlib.sha256(os.urandom(32)).hexdigest()
        with self._lock:
            self._by_token[token] = up
        return token

    def get(self, token):
        if not token:
            return UP
        with self._lock:
            return self._by_token.get(token)

    def logout(self, token):
        with self._lock:
            self._by_token.pop(token, None)


SESSIONS = Sessions()

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
# Filters and upstream requests mirror MoonTV's own web UI (/douban?type=…) exactly — same chip labels,
# same API calls — recorded by driving the web UI and logging its requests:
#   movie: categories?kind=movie&category=<热门|最新|豆瓣高分|冷门佳片>&type=<全部|华语|欧美|韩国|日本>
#   tv:    categories?kind=tv&category=tv&type=<tv|tv_domestic|tv_american|tv_japanese|tv_korean|tv_animation|tv_documentary>
#   show:  categories?kind=tv&category=show&type=<show|show_domestic|show_foreign>
#   anime: 番剧 recommends?kind=tv&category=动画&format=电视剧&…   剧场版 recommends?kind=movie&category=动画&format=&…
#          (the web's third tab 每日放送 is a bangumi calendar, not a list; not offered here)
# The TV app shows row 1 as "cats" and row 2 as "regions"; the labels below are the web's labels.
FILTERS = {
    "movie": {"cats": ["热门电影", "最新电影", "豆瓣高分", "冷门佳片"], "regions": ["全部", "华语", "欧美", "韩国", "日本"]},
    "tv":    {"cats": ["最近热门"], "regions": ["全部", "国产", "欧美", "日本", "韩国", "动漫", "纪录片"]},
    "anime": {"cats": ["番剧", "剧场版"], "regions": []},
    "show":  {"cats": ["最近热门"], "regions": ["全部", "国内", "国外"]},
}
MOVIE_CAT = {"热门电影": "热门", "最新电影": "最新", "豆瓣高分": "豆瓣高分", "冷门佳片": "冷门佳片"}
TV_TYPE = {"全部": "tv", "国产": "tv_domestic", "欧美": "tv_american", "日本": "tv_japanese", "韩国": "tv_korean",
           "动漫": "tv_animation", "纪录片": "tv_documentary"}
SHOW_TYPE = {"全部": "show", "国内": "show_domestic", "国外": "show_foreign"}


def upstream_list_path(kind, tag, region, start, size):
    """The exact request MoonTV's web UI would make for a chip combination."""
    if kind == "movie":
        return "/api/douban/categories?kind=movie&category=%s&type=%s&limit=%d&start=%d" % (
            q(MOVIE_CAT.get(tag, "热门")), q(region or "全部"), size, start)
    if kind == "tv":
        return "/api/douban/categories?kind=tv&category=tv&type=%s&limit=%d&start=%d" % (TV_TYPE.get(region, "tv"), size, start)
    if kind == "show":
        return "/api/douban/categories?kind=tv&category=show&type=%s&limit=%d&start=%d" % (SHOW_TYPE.get(region, "show"), size, start)
    if tag == "剧场版":
        return "/api/douban/recommends?kind=movie&limit=%d&start=%d&category=%s&format=&region=all&year=all&platform=all&sort=T&label=all" % (size, start, q("动画"))
    return "/api/douban/recommends?kind=tv&limit=%d&start=%d&category=%s&format=%s&region=all&year=all&platform=all&sort=T&label=all" % (size, start, q("动画"), q("电视剧"))


def douban_list(kind, tag, region, start, size):
    tag = tag or FILTERS[kind]["cats"][0]
    region = region or (FILTERS[kind]["regions"][0] if FILTERS[kind]["regions"] else "")

    def fetch():
        res = UP.call(upstream_list_path(kind, tag, region, start, size))
        return slim_douban((res or {}).get("list"))
    return mem_cached("douban:%s:%s:%s:%d:%d" % (kind, tag, region, start, size), LIST_TTL, fetch)


def continue_watching(up, limit=20):
    recs = up.call("/api/playrecords") or {}
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

try:
    import qrcode
    import qrcode.image.svg
except ImportError:  # pragma: no cover
    qrcode = None

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
        for r in continue_watching(UP, limit=200):
            add(r.get("title"), 3)
    except Exception as e:  # noqa: BLE001
        log("titles: records failed %r" % (e,))
    try:
        for q_ in UP.call("/api/searchhistory") or []:
            add(q_, 3)
    except Exception as e:  # noqa: BLE001
        log("titles: history failed %r" % (e,))
    for kind, tag, region in (("movie", "热门电影", "全部"), ("movie", "最新电影", "全部"), ("tv", "最近热门", "全部"),
                              ("tv", "最近热门", "国产"), ("tv", "最近热门", "欧美"), ("tv", "最近热门", "韩国"), ("tv", "最近热门", "日本"),
                              ("anime", "番剧", None), ("show", "最近热门", "全部")):
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


# --------------------------------------------------------------------------- remote input (phone -> TV)
# The TV's on-screen keyboard registers a channel and shows a QR code pointing at /r/<id>.
# The phone opens that page, types, and POSTs to /remote/<id>/send; the TV long-polls
# /remote/<id>/poll. Everything is in memory and LAN-only.
REMOTE_TTL = 24 * 3600
_ID_RE = re.compile(r"^[A-Za-z0-9]{4,16}$")


class Remote:
    def __init__(self):
        self._lock = threading.Lock()
        self._ch = {}

    def _new_id(self):
        alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
        return "".join(random.SystemRandom().choice(alphabet) for _ in range(6))

    def channel(self, cid=None, create=True):
        with self._lock:
            now = time.time()
            for k in [k for k, v in self._ch.items() if now - v["t"] > REMOTE_TTL]:
                del self._ch[k]
            ch = self._ch.get(cid) if cid else None
            if ch is None and create:
                if not (cid and _ID_RE.match(cid)):
                    cid = self._new_id()
                    while cid in self._ch:
                        cid = self._new_id()
                ch = {"id": cid, "seq": 0, "msgs": [], "cond": threading.Condition(), "state": {}, "t": now}
                self._ch[cid] = ch
            if ch:
                ch["t"] = now
            return ch

    def send(self, ch, text, action):
        with ch["cond"]:
            ch["seq"] += 1
            ch["msgs"].append({"seq": ch["seq"], "text": text, "action": action, "t": time.time()})
            ch["msgs"] = ch["msgs"][-20:]
            ch["cond"].notify_all()

    def poll(self, ch, since, timeout=25.0):
        deadline = time.time() + timeout
        with ch["cond"]:
            while True:
                pending = [m for m in ch["msgs"] if m["seq"] > since]
                if pending or time.time() >= deadline:
                    return {"seq": ch["seq"], "messages": pending}
                ch["cond"].wait(max(0.0, deadline - time.time()))


REMOTE = Remote()


def qr_svg(data):
    if not qrcode:
        return None
    img = qrcode.make(data, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    return img.to_string()


PHONE_PAGE = """<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>MoonTV 电视输入</title>
<style>
body{font-family:-apple-system,"Segoe UI","Noto Sans",sans-serif;background:#0f1117;color:#e8e8ec;margin:0;padding:22px}
h1{font-size:22px;color:#fad778;margin:0 0 6px}#ctx{color:#8f94a3;font-size:14px;min-height:20px;margin-bottom:14px}
textarea{width:100%;box-sizing:border-box;font-size:20px;padding:12px;border-radius:12px;border:2px solid #2a2f40;background:#1a1d28;color:#fff;min-height:120px;outline:none}
textarea:focus{border-color:#fad778}button{width:100%;font-size:20px;padding:15px;margin-top:12px;border-radius:12px;border:0}
.send{background:#2a2f40;color:#e8e8ec}.go{background:#fad778;color:#111;font-weight:600}#msg{margin-top:12px;color:#8f94a3;font-size:14px;min-height:20px}
</style></head><body>
<h1>MoonTV 电视输入</h1><div id="ctx">连接电视中…</div>
<textarea id="t" autofocus placeholder="在手机上打字，发送到电视"></textarea>
<button class="send" onclick="send('input')">发送到电视（填入）</button>
<button class="go" id="go" onclick="send('submit')">确认</button>
<div id="msg"></div>
<script>
var ID=__ID__;
function st(){fetch('/remote/'+ID+'/state').then(function(r){return r.ok?r.json():null}).then(function(s){
  var go=document.getElementById('go'),c=document.getElementById('ctx');
  if(!s||!s.open){go.textContent='确认';c.textContent='电视当前没有打开键盘（在电视上进入搜索或登录页）';return}
  go.textContent=s.label||'确认';c.textContent='电视正在等待输入 · 按钮 = 电视上的「'+(s.label||'确认')+'」'+(s.value?'　当前：'+s.value:'');
}).catch(function(){document.getElementById('ctx').textContent='无法连接桥接服务'})}
st();setInterval(st,4000);
function send(a){var v=document.getElementById('t').value;
 fetch('/remote/'+ID+'/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:v,action:a})})
 .then(function(r){document.getElementById('msg').textContent=r.ok?'已发送 ✓':(r.status===404?'电视未连接，请在电视上重新打开键盘':'发送失败');if(r.ok&&a==='submit')document.getElementById('t').value='';})
 .catch(function(){document.getElementById('msg').textContent='发送失败'})}
</script></body></html>"""


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


# --------------------------------------------------------------------------- static (app + simulator)
def static_file(root, rel):
    """Return (bytes, content-type) for rel inside root, or None if missing / outside root."""
    if not root:
        return None
    base = os.path.realpath(root)
    full = os.path.realpath(os.path.join(base, rel.lstrip("/")))
    if full != base and not full.startswith(base + os.sep):
        return None
    if os.path.isdir(full):
        full = os.path.join(full, "index.html")
    if not os.path.isfile(full):
        return None
    ctype, _ = mimetypes.guess_type(full)
    if ctype and ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
        ctype += "; charset=utf-8"
    with open(full, "rb") as fh:
        return fh.read(), ctype or "application/octet-stream"


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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Session")

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

    def _session(self):
        """Upstream for this request: X-Session header (or ?session=) -> logged-in user, else default."""
        token = self.headers.get("X-Session") or urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("session", [None])[0]
        up = SESSIONS.get(token)
        if up is None:
            raise AuthError("session expired")
        return up

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        p = u.path.rstrip("/") or "/"
        qs = urllib.parse.parse_qs(u.query)
        g = lambda k, d=None: (qs.get(k) or [d])[0]  # noqa: E731
        try:
            if p == "/" and SIM_FILE:
                self.send_response(302)
                self._cors()
                self.send_header("Location", "/sim")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None
            if p == "/sim" and SIM_FILE and os.path.isfile(SIM_FILE):
                with open(SIM_FILE, "rb") as fh:
                    return self._send(200, fh.read(), "text/html; charset=utf-8")
            if p == "/tv" or p.startswith("/tv/"):
                hit = static_file(APP_DIR, p[3:] or "/")
                if not hit:
                    return self._error(404, "not found")
                data, ctype = hit
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(data)
                return None
            if p == "/health":
                return self._json({"ok": True, "upstream": UPSTREAM, "app": bool(APP_DIR), "sim": bool(SIM_FILE)})
            if p.startswith("/r/"):
                cid = p[3:]
                if not _ID_RE.match(cid):
                    return self._error(404, "not found")
                return self._send(200, PHONE_PAGE.replace("__ID__", json.dumps(cid)).encode("utf-8"), "text/html; charset=utf-8")
            if p.startswith("/remote/"):
                parts = p.split("/")          # ['', 'remote', '<id>', '<op>']
                if len(parts) != 4:
                    return self._error(404, "not found")
                ch = REMOTE.channel(parts[2], create=False)
                if ch is None:
                    return self._error(404, "no such channel")
                if parts[3] == "qr.svg":
                    svg = qr_svg("http://%s/r/%s" % (self.headers.get("Host", "localhost:%d" % LISTEN_PORT), ch["id"]))
                    if svg is None:
                        return self._error(501, "qrcode not installed")
                    return self._send(200, svg, "image/svg+xml", cache=86400)
                if parts[3] == "poll":
                    return self._json(REMOTE.poll(ch, int(g("since", 0) or 0)))
                if parts[3] == "state":
                    return self._json(ch["state"])
                return self._error(404, "not found")
            if p == "/seed-accounts":
                return self._json([{"username": u, "password": pw} for u, pw in SEED_ACCOUNTS])
            if p == "/me":
                up = self._session()
                return self._json({"username": up.username, "default": up is UP})
            if p == "/home":
                up = self._session()
                return self._json({
                    "user": up.username,
                    "continue": continue_watching(up),
                    "movie": douban_list("movie", "热门电影", "全部", 0, 20),
                    "tv": douban_list("tv", "最近热门", "全部", 0, 20),
                    "anime": douban_list("anime", "番剧", None, 0, 20),
                    "show": douban_list("show", "最近热门", "全部", 0, 20),
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
                return self._json(continue_watching(self._session(), limit=200))
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
        except AuthError as e:
            return self._error(401, str(e))
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
            if p == "/remote/new":
                ch = REMOTE.channel((body.get("id") or "").strip(), create=True)
                host = self.headers.get("Host", "localhost:%d" % LISTEN_PORT)
                return self._json({"id": ch["id"], "seq": ch["seq"], "url": "http://%s/r/%s" % (host, ch["id"])})
            if p.startswith("/remote/"):
                parts = p.split("/")
                ch = REMOTE.channel(parts[2], create=False) if len(parts) == 4 else None
                if ch is None:
                    return self._error(404, "no such channel")
                if parts[3] == "send":
                    text = str(body.get("text") or "")[:500]
                    action = body.get("action") if body.get("action") in ("input", "submit") else "input"
                    REMOTE.send(ch, text, action)
                    return self._json({"ok": True, "seq": ch["seq"]})
                if parts[3] == "state":
                    ch["state"] = {"open": bool(body.get("open")), "label": str(body.get("label") or "")[:20], "value": str(body.get("value") or "")[:100]}
                    return self._json({"ok": True})
                return self._error(404, "not found")
            if p == "/login":
                user, pw = (body.get("username") or "").strip(), body.get("password") or ""
                if not user or not pw:
                    return self._error(400, "username and password required")
                try:
                    token = SESSIONS.login(user, pw)
                except AuthError as e:
                    log("login failed for %s: %s" % (user, e))
                    return self._error(401, "login failed")
                return self._json({"ok": True, "session": token, "username": user})
            if p == "/logout":
                SESSIONS.logout(self.headers.get("X-Session") or body.get("session"))
                return self._json({"ok": True})
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
                self._session().call("/api/playrecords", method="POST", body={"key": key, "record": rec})
                return self._json({"ok": True})
            return self._error(404, "not found")
        except AuthError as e:
            return self._error(401, str(e))
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
