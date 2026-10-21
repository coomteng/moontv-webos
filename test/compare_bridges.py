#!/usr/bin/env python3
"""
Differential test: fire the same requests at two bridge instances (e.g. Python and Go) and diff
the normalised responses. Usage:
    python3 test/compare_bridges.py http://127.0.0.1:8799 http://127.0.0.1:8798
Exit code 1 if any endpoint differs. Values that legitimately differ (timings, random ids,
session tokens, probe speeds) are masked before comparing.
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

A, B = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/")
Q = lambda s: urllib.parse.quote(s, safe="")  # noqa: E731


def call(base, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json", **(headers or {})},
                                 method="POST" if data is not None else "GET")
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw, st, h = r.read(), r.status, dict(r.headers)
    except urllib.error.HTTPError as e:
        with e:
            raw, st, h = e.read(), e.code, dict(e.headers)
    ms = (time.time() - t) * 1000
    ct = h.get("Content-Type", "")
    if ct.startswith("application/json"):
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = raw[:200]
    elif ct.startswith("text/") or ct.startswith("image/svg"):
        payload = ("<%s %d bytes>" % (ct.split(";")[0], len(raw)))
    else:
        payload = ("<%s %d bytes sha=%s>" % (ct.split(";")[0], len(raw), __import__("hashlib").sha1(raw).hexdigest()[:8]))
    keep = {k: h.get(k) for k in ("Content-Type", "Cache-Control", "Access-Control-Allow-Origin", "Content-Encoding")}
    return st, keep, payload, ms


VOLATILE = {"session", "latency_ms", "speed_kbps", "t", "url", "id", "seq", "count"}


def norm(x, path=""):
    """Mask volatile fields; sort dict keys; keep list order (order is part of the contract)."""
    if isinstance(x, dict):
        out = {}
        for k in sorted(x):
            if k in VOLATILE and (path.startswith("/login") or path.startswith("/remote") or path.startswith("/probe") or path.startswith("/titles")):
                out[k] = "<volatile>"
            else:
                out[k] = norm(x[k], path)
        return out
    if isinstance(x, list):
        return [norm(i, path) for i in x]
    return x


def main():
    sess = {}
    for base in (A, B):
        st, _, j, _ = call(base, "/login", {"username": "moontv2", "password": "moontv2"})
        sess[base] = j.get("session") if isinstance(j, dict) else None
    hdr = lambda base: {"X-Session": sess[base]} if sess[base] else {}  # noqa: E731

    cases = [
        ("GET", "/health", None, False),
        ("GET", "/filters", None, False),
        ("GET", "/seed-accounts", None, False),
        ("GET", "/me", None, False),
        ("GET", "/me", None, True),
        ("GET", "/home", None, False),
        ("GET", "/home", None, True),
        ("GET", "/record", None, True),
        ("GET", "/list?type=movie&tag=%s&region=%s&size=6" % (Q("豆瓣高分"), Q("日本")), None, False),
        ("GET", "/list?type=tv&tag=%s" % Q("韩剧"), None, False),
        ("GET", "/list?type=anime&size=5", None, False),
        ("GET", "/list?type=bogus", None, False),
        ("GET", "/search?q=", None, False),
        ("GET", "/search?q=%s" % Q("兰香如故"), None, False),
        ("GET", "/detail?source=ruyi&id=86003", None, False),
        ("GET", "/detail?source=ruyi", None, False),
        ("GET", "/titles", None, False),
        ("GET", "/poster?url=%s" % Q("https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2933326871.jpg"), None, False),
        ("GET", "/poster", None, False),
        ("GET", "/probe?url=%s" % Q("https://svip.ryiplay18.com/20260911/10912_731691a4/index.m3u8"), None, False),
        ("GET", "/me?session=deadbeef", None, False),
        ("GET", "/nope", None, False),
        ("GET", "/tv/js/api.js", None, False),
        ("GET", "/tv/../go.mod", None, False),
        ("GET", "/sim", None, False),
        ("GET", "/r/abcd12", None, False),
        ("GET", "/r/..", None, False),
        ("POST", "/login", {"username": "moontv1", "password": "nope"}, False),
        ("POST", "/login", {"username": ""}, False),
        ("POST", "/record", {"key": "x+1"}, False),
        ("POST", "/probe", {"items": []}, False),
        ("POST", "/remote/new", {}, False),
        ("POST", "/remote/zzzzzz/send", {"text": "x"}, False),
    ]
    diffs = 0
    print("%-70s %-6s %-6s %8s %8s" % ("case", "A", "B", "A ms", "B ms"))
    for method, path, body, with_session in cases:
        ra = call(A, path, body, hdr(A) if with_session else None)
        rb = call(B, path, body, hdr(B) if with_session else None)
        same = (ra[0] == rb[0]) and (ra[1] == rb[1]) and (norm(ra[2], path) == norm(rb[2], path))
        flag = "" if same else "  <-- DIFF"
        print("%-70s %-6s %-6s %7.0f %8.0f%s" % ((method + " " + path)[:70] + (" [sess]" if with_session else ""), ra[0], rb[0], ra[3], rb[3], flag))
        if not same:
            diffs += 1
            na, nb = norm(ra[2], path), norm(rb[2], path)
            if ra[1] != rb[1]:
                print("      headers A:", ra[1], "\n      headers B:", rb[1])
            sa, sb = json.dumps(na, ensure_ascii=False)[:400], json.dumps(nb, ensure_ascii=False)[:400]
            if sa != sb:
                print("      A:", sa, "\n      B:", sb)
    print("\n%d case(s) differ" % diffs)
    sys.exit(1 if diffs else 0)


if __name__ == "__main__":
    main()
