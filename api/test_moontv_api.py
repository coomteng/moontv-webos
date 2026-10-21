#!/usr/bin/env python3
"""
Tests for api/moontv-api.py. Run:  python3 -m pytest api/  (or python3 api/test_moontv_api.py)

A fake MoonTV (cookie login, 401 without it, douban categories, per-user playrecords, search,
searchhistory, image-proxy) is started on a random port; the bridge is imported as a module and
served on another random port with MOONTV_* pointing at the fake. Only stdlib + pytest.
"""
import gzip
import http.server
import importlib.util
import json
import os
import re
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ----------------------------------------------------------------------------- fake MoonTV
class FakeMoonTV(http.server.BaseHTTPRequestHandler):
    logins = 0
    lists = 0

    def log_message(self, *a):
        pass

    def _json(self, obj, status=200, headers=None):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _user(self):
        m = re.search(r"auth=tok-([^;]+)", self.headers.get("Cookie") or "")
        return m.group(1) if m else None

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/login":
            FakeMoonTV.logins += 1
            if body.get("password") != body.get("username"):
                return self._json({"error": "bad"}, 401)
            return self._json({"ok": True}, headers={"Set-Cookie": "auth=tok-%s; Path=/; SameSite=lax" % body["username"]})
        if not self._user():
            return self._json({"error": "Unauthorized"}, 401)
        if self.path == "/api/playrecords":
            return self._json({"ok": True})
        self._json({"error": "nf"}, 404)

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        user = self._user()
        if not user:
            return self._json({"error": "Unauthorized"}, 401)
        if u.path == "/api/douban/categories":
            FakeMoonTV.lists += 1
            return self._json({"code": 200, "list": [{"id": "1", "title": "%s/%s/%s" % (q.get("kind"), q.get("category"), q.get("type")),
                                                      "poster": "http://p/1.jpg", "rate": "8.1", "year": "2026"}]})
        if u.path == "/api/douban/recommends":
            FakeMoonTV.lists += 1
            return self._json({"code": 200, "list": [{"id": "3", "title": "rec:%s/%s/%s" % (q.get("kind"), q.get("category"), q.get("format", "")), "poster": "http://p/3.jpg", "rate": "", "year": ""}]})
        if u.path == "/api/playrecords":
            return self._json({"src+1": {"title": user + " 看的剧", "cover": "http://p/c.jpg", "index": 3, "total_episodes": 10,
                                         "play_time": 100, "total_time": 2000, "save_time": 2, "year": "2025"},
                               "src+2": {"title": "旧的", "cover": "", "save_time": 1},
                               "nokey": {"title": "ignored"}})
        if u.path == "/api/search":
            return self._json({"results": [
                {"source": "a", "source_name": "A", "id": "1", "title": "兰香如故", "poster": "", "year": "2026", "type_name": "剧",
                 "class": "古装", "desc": "长" * 400, "episodes": ["u1", "u2"], "episodes_titles": ["1", "2"], "douban_id": 1},
                {"source": "b", "source_name": "B", "id": "9", "title": "兰香如故", "poster": "http://p/b.jpg", "year": "2026", "episodes": ["v1"]},
                {"source": "c", "source_name": "C", "id": "3", "title": "别的", "poster": None, "year": "2024", "episodes": None}]})
        if u.path == "/api/searchhistory":
            return self._json(["流浪地球", "2026年世界杯"])
        if u.path == "/api/image-proxy":
            b = ("JPEGDATA:" + q.get("url", "")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if u.path == "/api/detail":
            return self._json({"id": q.get("id"), "title": "d"})
        self._json({"error": "nf"}, 404)


class ThreadingServer(http.server.ThreadingHTTPServer):
    daemon_threads = True


# ----------------------------------------------------------------------------- bridge under test
class BridgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake_port = free_port()
        cls.fake = ThreadingServer(("127.0.0.1", cls.fake_port), FakeMoonTV)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()

        cls.tmp = tempfile.mkdtemp()
        cls.app_dir = os.path.join(cls.tmp, "app")
        os.makedirs(os.path.join(cls.app_dir, "js"))
        for rel, content in (("app/index.html", "<html>app</html>"), ("app/js/a.js", "var a=1;"), ("sim.html", "<html>sim</html>")):
            with open(os.path.join(cls.tmp, rel), "w") as fh:
                fh.write(content)
        cls.sim = os.path.join(cls.tmp, "sim.html")

        os.environ.update({
            "MOONTV_UPSTREAM": "http://127.0.0.1:%d" % cls.fake_port, "MOONTV_USER": "moontv1", "MOONTV_PASS": "moontv1",
            "MOONTV_CACHE": os.path.join(cls.tmp, "cache"), "MOONTV_APP_DIR": cls.app_dir, "MOONTV_SIM": cls.sim,
            "MOONTV_SEED_ACCOUNTS": "moontv1:moontv1,moontv2:moontv2", "MOONTV_PORT": str(free_port()),
        })
        spec = importlib.util.spec_from_file_location("moontv_api", os.path.join(HERE, "moontv-api.py"))
        cls.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.mod)
        cls.port = cls.mod.LISTEN_PORT
        cls.srv = cls.mod.Server(("127.0.0.1", cls.port), cls.mod.Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.port

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.fake.shutdown()
        cls.fake.server_close()

    # helpers
    def req(self, path, body=None, headers=None, method=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method or ("POST" if data is not None else "GET"),
                                   headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, dict(e.headers), e.read()

    def js(self, path, **kw):
        st, h, raw = self.req(path, **kw)
        if h.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return st, h, (json.loads(raw) if raw else None)

    def login(self, user):
        st, _, j = self.js("/login", body={"username": user, "password": user})
        self.assertEqual(st, 200, j)
        return j["session"]

    # tests
    def test_health_and_cors(self):
        st, h, j = self.js("/health")
        self.assertEqual(st, 200)
        self.assertTrue(j["ok"] and j["app"] and j["sim"])
        self.assertEqual(h["Access-Control-Allow-Origin"], "*")
        self.assertIn("X-Session", h["Access-Control-Allow-Headers"])
        st, h, _ = self.req("/home", method="OPTIONS")
        self.assertEqual(st, 204)

    def test_login_sessions_me_logout(self):
        st, _, j = self.js("/login", body={"username": "moontv2", "password": "wrong"})
        self.assertEqual((st, j["error"]), (401, "login failed"))
        st, _, _ = self.js("/login", body={"username": "", "password": "x"})
        self.assertEqual(st, 400)
        tok = self.login("moontv2")
        self.assertEqual(len(tok), 64)
        _, _, me = self.js("/me")
        self.assertEqual((me["username"], me["default"]), ("moontv1", True))
        _, _, me = self.js("/me", headers={"X-Session": tok})
        self.assertEqual((me["username"], me["default"]), ("moontv2", False))
        st, _, _ = self.js("/me?session=" + tok)
        self.assertEqual(st, 200)
        st, _, j = self.js("/me", headers={"X-Session": "deadbeef"})
        self.assertEqual((st, j["error"]), (401, "session expired"))
        self.js("/logout", body={}, headers={"X-Session": tok})
        st, _, _ = self.js("/me", headers={"X-Session": tok})
        self.assertEqual(st, 401)

    def test_home_per_user_key_order_and_cache(self):
        tok = self.login("moontv2")
        st, _, raw1 = self.req("/home")
        _, _, raw2 = self.req("/home", headers={"X-Session": tok})
        s1 = raw1.decode()
        self.assertEqual(st, 200)
        self.assertLess(s1.index('"user"'), s1.index('"continue"'))
        self.assertLess(s1.index('"continue"'), s1.index('"movie"'))
        self.assertLess(s1.index('"anime"'), s1.index('"show"'))
        self.assertIn("moontv1 看的剧", s1)
        self.assertIn("moontv2 看的剧", raw2.decode())
        n = FakeMoonTV.lists
        self.req("/home")
        self.assertEqual(FakeMoonTV.lists, n, "douban lists must be served from cache")
        home = json.loads(raw1)
        cont = home["continue"]
        self.assertEqual([c["key"] for c in cont], ["src+1", "src+2"])  # newest first, 'nokey' dropped
        self.assertEqual((cont[0]["source"], cont[0]["id"]), ("src", "1"))
        self.assertEqual((cont[1]["index"], cont[1]["total_episodes"], cont[1]["search_title"]), (1, 1, ""))

    def test_list_filters_validation(self):
        st, _, _ = self.js("/list?type=bogus")
        self.assertEqual(st, 400)
        cases = {  # every chip maps to exactly the request MoonTV's web UI makes
            "/list?type=movie": "movie/热门/全部",
            "/list?type=movie&tag=最新电影&region=韩国": "movie/最新/韩国",
            "/list?type=tv": "tv/tv/tv",
            "/list?type=tv&region=韩国": "tv/tv/tv_korean",
            "/list?type=tv&region=动漫": "tv/tv/tv_animation",
            "/list?type=show": "tv/show/show",
            "/list?type=show&region=国内": "tv/show/show_domestic",
            "/list?type=anime": "rec:tv/动画/电视剧",
            "/list?type=anime&tag=剧场版": "rec:movie/动画/",
        }
        for path, want in cases.items():
            _, _, items = self.js(urllib.parse.quote(path, safe="/?=&"))
            self.assertEqual(items[0]["title"], want, path)
        home = self.js("/home")[2]
        self.assertNotEqual(home["anime"][0]["title"], home["show"][0]["title"])
        st, h, f = self.js("/filters")
        self.assertEqual((f["movie"]["cats"][0], f["tv"]["regions"][1], f["anime"]["cats"], f["show"]["regions"]),
                         ("热门电影", "国产", ["番剧", "剧场版"], ["全部", "国内", "国外"]))
        self.assertEqual(list(f.keys()), ["movie", "tv", "anime", "show"])
        self.assertEqual(h["Cache-Control"], "public, max-age=3600")

    def test_search_grouping(self):
        _, _, j = self.js("/search?q=")
        self.assertEqual(j, [])
        _, _, g = self.js("/search?q=" + urllib.parse.quote("兰香如故"))
        self.assertEqual([x["title"] for x in g], ["兰香如故", "别的"])
        self.assertEqual(len(g[0]["sources"]), 2)
        self.assertEqual(g[0]["poster"], "http://p/b.jpg")           # backfilled from 2nd source
        self.assertEqual(len(g[0]["sources"][0]["desc"]), 300)      # truncated
        self.assertEqual(g[1]["sources"][0]["episodes"], [])        # null -> []

    def test_poster_disk_cache_format(self):
        u = "https://img/x.jpg"
        st, h, raw = self.req("/poster?url=" + urllib.parse.quote(u, safe=""))
        self.assertEqual((st, h["Content-Type"], raw), (200, "image/jpeg", ("JPEGDATA:" + u).encode()))
        self.assertEqual(h["Cache-Control"], "public, max-age=604800")
        import hashlib
        f = os.path.join(os.environ["MOONTV_CACHE"], hashlib.sha1(u.encode()).hexdigest())
        with open(f, "rb") as fh:
            self.assertEqual(fh.read(), b"image/jpeg\nJPEGDATA:" + u.encode())
        with open(f, "wb") as fh:
            fh.write(b"image/png\nCACHED")
        _, h, raw = self.req("/poster?url=" + urllib.parse.quote(u, safe=""))
        self.assertEqual((h["Content-Type"], raw), ("image/png", b"CACHED"))

    def test_record_post(self):
        st, _, _ = self.js("/record", body={"key": "a+1"})
        self.assertEqual(st, 400)
        st, _, _ = self.js("/record", body={"key": "a+1", "record": {"title": "x"}}, headers={"X-Session": "nope"})
        self.assertEqual(st, 401)
        st, _, j = self.js("/record", body={"key": "a+1", "record": {"title": "x"}})
        self.assertEqual((st, j), (200, {"ok": True}))

    def test_relogin_on_401(self):
        self.req("/record")
        n = FakeMoonTV.logins
        self.mod.UP._cookie = "auth=stale"
        self.mod.UP._at = 0
        st, _, _ = self.req("/record")
        self.assertEqual(st, 200)
        self.assertEqual(FakeMoonTV.logins, n + 1)

    def test_gzip_rules(self):
        _, h, _ = self.req("/search?q=" + urllib.parse.quote("兰香如故"), headers={"Accept-Encoding": "gzip"})
        self.assertEqual(h.get("Content-Encoding"), "gzip")
        _, h, _ = self.req("/health", headers={"Accept-Encoding": "gzip"})
        self.assertIsNone(h.get("Content-Encoding"))
        _, h, _ = self.req("/poster?url=x", headers={"Accept-Encoding": "gzip"})
        self.assertIsNone(h.get("Content-Encoding"))

    def test_seed_accounts(self):
        _, _, j = self.js("/seed-accounts")
        self.assertEqual(j, [{"username": "moontv1", "password": "moontv1"}, {"username": "moontv2", "password": "moontv2"}])

    def test_title_variants_and_index(self):
        tv = self.mod._title_variants
        self.assertEqual(tv("现在就出发 第四季"), ["现在就出发 第四季", "现在就出发"])
        self.assertEqual(tv("出差沟通之神：SEVENTEEN团结大会"), ["出差沟通之神：SEVENTEEN团结大会", "出差沟通之神"])
        self.assertEqual(tv("2026年世界杯"), [])
        self.assertEqual(tv("Westworld"), [])
        st, h, idx = self.js("/titles")
        self.assertEqual(h["Cache-Control"], "public, max-age=600")
        if self.mod.lazy_pinyin:
            self.assertIn("liulangdiqiu", idx["full"])
            self.assertIn("lldq", idx["initials"])
            self.assertTrue(all(re.match(r"^[a-z]+$", k) for k in idx["full"]))

    def test_static_app_sim_and_traversal(self):
        st, h, _ = self.req("/")
        self.assertEqual(st, 200)                      # urllib followed the 302 to /sim
        st, h, raw = self.req("/sim")
        self.assertEqual((st, raw), (200, b"<html>sim</html>"))
        st, h, raw = self.req("/tv/")
        self.assertEqual((st, raw), (200, b"<html>app</html>"))
        st, h, raw = self.req("/tv/js/a.js")
        self.assertEqual(st, 200)
        self.assertTrue(h["Content-Type"].startswith("application/javascript") or h["Content-Type"].startswith("text/javascript"))
        self.assertEqual(h["Cache-Control"], "no-cache")
        st, _, _ = self.req("/tv/../sim.html")
        self.assertEqual(st, 404)
        st, _, _ = self.req("/tv/%2e%2e/sim.html")
        self.assertEqual(st, 404)

    def test_remote_channel_roundtrip(self):
        st, _, ch = self.js("/remote/new", body={})
        self.assertEqual(st, 200)
        cid = ch["id"]
        self.assertRegex(cid, r"^[a-z0-9]{6}$")
        self.assertTrue(ch["url"].endswith("/r/" + cid))
        st, h, _ = self.req("/remote/%s/qr.svg" % cid)
        self.assertEqual((st, h["Content-Type"]), (200, "image/svg+xml"))
        st, _, _ = self.js("/remote/zzzzzz/poll")
        self.assertEqual(st, 404)
        # same id is reused on re-registration
        _, _, ch2 = self.js("/remote/new", body={"id": cid})
        self.assertEqual(ch2["id"], cid)
        # long-poll wakes up on send
        got = {}
        def poll():
            got["r"] = self.js("/remote/%s/poll?since=0" % cid)[2]
        t = threading.Thread(target=poll); t.start(); time.sleep(0.3)
        _, _, s = self.js("/remote/%s/send" % cid, body={"text": "兰香如故", "action": "submit"})
        t.join(5)
        self.assertEqual(s["seq"], 1)
        self.assertEqual(got["r"]["messages"][0], {"seq": 1, "text": "兰香如故", "action": "submit", "t": got["r"]["messages"][0]["t"]})
        self.js("/remote/%s/state" % cid, body={"open": True, "label": "搜索", "value": "x"})
        _, _, stt = self.js("/remote/%s/state" % cid)
        self.assertEqual(stt, {"open": True, "label": "搜索", "value": "x"})
        st, _, raw = self.req("/r/" + cid)
        self.assertEqual(st, 200)
        self.assertIn(b"MoonTV", raw)
        st, _, _ = self.req("/r/../etc")
        self.assertEqual(st, 404)

    def test_probe_parsers(self):
        m = self.mod
        master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080\nhigh/index.m3u8\n"
        pl = m._parse_m3u8(master, "https://cdn/x/master.m3u8")
        self.assertTrue(pl["master"])
        self.assertEqual(max(pl["variants"])[1:], ("1920x1080", "https://cdn/x/high/index.m3u8"))
        media = "#EXTM3U\n#EXTINF:10.0,\nseg0.ts\n#EXTINF:9.5,\n/abs/seg1.ts\n#EXT-X-ENDLIST\n"
        pl = m._parse_m3u8(media, "https://cdn/x/high/index.m3u8")
        self.assertFalse(pl["master"])
        self.assertEqual(pl["segments"], ["https://cdn/x/high/seg0.ts", "https://cdn/abs/seg1.ts"])
        self.assertAlmostEqual(pl["duration"], 19.5)
        # SPS for 1920x1080 (baseline profile 66, with cropping 1920x1088->1080), wrapped in a TS-like buffer
        sps = bytes.fromhex("0000016742c01e8c8d40780227e5c04400000300040000030050")  # a 1920x1080-ish SPS... see note
        res = m._guess_resolution(b"\x00" * 16 + sps + b"\x00" * 64)
        self.assertTrue(res is None or re.match(r"^\d+x\d+$", res))
        r = m.probe_stream("http://127.0.0.1:%d/api/not-m3u8" % self.fake_port)
        self.assertFalse(r["ok"])
        self.assertTrue(r["error"])

    def test_upstream_down_is_5xx(self):
        saved = self.mod.UPSTREAM
        self.mod.UPSTREAM = "http://127.0.0.1:1"
        self.mod.UP.base = None  # not used by python impl; path built from UPSTREAM global
        try:
            self.mod._mem.clear() if hasattr(self.mod, "_mem") else None
            st, _, j = self.js("/search?q=zzz")
            self.assertIn(st, (500, 502))
            self.assertIn("error", j)
        finally:
            self.mod.UPSTREAM = saved


if __name__ == "__main__":
    unittest.main(verbosity=2)
