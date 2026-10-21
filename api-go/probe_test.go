package main

import (
	"bytes"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseM3U8MasterAndMedia(t *testing.T) {
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nlow/index.m3u8\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080\nhigh/index.m3u8\n" +
		"#EXT-X-STREAM-INF:CODECS=\"avc1\"\n//other.cdn/abs.m3u8\n"
	pl := parseM3U8(master, "https://cdn/x/master.m3u8")
	if !pl.master {
		t.Fatal("expected master playlist")
	}
	want := []m3u8Variant{
		{800000, "1280x720", "https://cdn/x/low/index.m3u8"},
		{2500000, "1920x1080", "https://cdn/x/high/index.m3u8"},
		{0, "", "https://other.cdn/abs.m3u8"},
	}
	if !reflect.DeepEqual(pl.variants, want) {
		t.Fatalf("variants = %+v", pl.variants)
	}
	if len(pl.segments) != 0 {
		t.Fatalf("master should have no segments: %v", pl.segments)
	}

	media := "#EXTM3U\r\n#EXT-X-TARGETDURATION:10\r\n#EXTINF:10.0,\r\nseg0.ts\r\n#EXTINF:9.5, title\r\n/abs/seg1.ts\r\n" +
		"#EXTINF:bogus,\r\n../up/seg2.ts?x=1\r\n\r\n#EXT-X-ENDLIST\r\n"
	pl = parseM3U8(media, "https://cdn/x/high/index.m3u8")
	if pl.master {
		t.Fatal("media playlist flagged as master")
	}
	wantSegs := []string{"https://cdn/x/high/seg0.ts", "https://cdn/abs/seg1.ts", "https://cdn/x/up/seg2.ts?x=1"}
	if !reflect.DeepEqual(pl.segments, wantSegs) {
		t.Fatalf("segments = %v", pl.segments)
	}
	if pl.duration < 19.49 || pl.duration > 19.51 {
		t.Fatalf("duration = %v", pl.duration)
	}
}

// SPS fixtures generated with a tiny bit-writer and verified against the Python
// _guess_resolution (see report); every value below is what the Python function returns.
func TestGuessResolutionSPS(t *testing.T) {
	cases := []struct {
		name, hex, want string
	}{
		// baseline, 120x68 MBs, frame_crop bottom=4 -> 1920x1080; contains 00 00 03 EP byte
		{"baseline_ep_crop", "42000003032f403c0113f2a0", "1920x1080"},
		// main profile, interlaced (frame_mbs_only=0, 45x18 MBs -> 720x576), crop bottom 2 -> 576-2*2*2
		{"main_interlaced", "4d001e032f405a123ed0", "720x568"},
		// baseline, pic_order_cnt_type=1 path, 40x30 MBs -> 640x480
		{"poc1", "42000003032d34440501ec80", "640x480"},
		// 2x2 MBs = 32x32: outside the 64..8192 sanity window -> unknown
		{"tiny", "42000003032f44b2", ""},
		// real x264 High 1080p SPS (with EP bytes and 1088->1080 cropping)
		{"x264_high_1080p", "67640028acd94078022 7e5c0440000030004000003 00f03c60c658", "1920x1080"},
		// real x264 High 720p
		{"x264_high_720p", "6764001facd9405005bb016a0202028000000300800000 1e078c18cb", "1280x720"},
		// real x264 High 640x360
		{"x264_high_360p", "6764001eacd940a02ff961000003000100000300320f162d96", "640x360"},
		// x264 High 1920x800 (crop 1920x816 -> 800)
		{"x264_high_1920x800", "67640029acd98078065b0110000003001000000303c0f1831960", "1920x800"},
	}
	for _, c := range cases {
		raw, err := hex.DecodeString(strings.ReplaceAll(c.hex, " ", ""))
		if err != nil {
			t.Fatal(err)
		}
		if raw[0] != 0x67 {
			raw = append([]byte{0x67}, raw...)
		}
		ts := append([]byte{0x47, 0x40, 0x11, 0x10, 0, 0, 0, 1, 0x09, 0xf0}, 0, 0, 1)
		ts = append(ts, raw...)
		ts = append(ts, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80)
		if got := guessResolution(ts); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
	if got := guessResolution(bytes.Repeat([]byte{0x47}, 400)); got != "" {
		t.Errorf("no SPS: got %q", got)
	}
	// truncated SPS must not panic and yields unknown
	if got := guessResolution([]byte{0, 0, 1, 0x67, 0x42}); got != "" {
		t.Errorf("truncated: got %q", got)
	}
}

// hlsOrigin serves a master -> media -> segments tree and counts requests.
func hlsOrigin(t *testing.T) (*httptest.Server, *int32) {
	t.Helper()
	var hits int32
	seg := bytes.Repeat([]byte{0x47, 0x00}, 100*1024) // 200 KB, no SPS
	mux := http.NewServeMux()
	mux.HandleFunc("/live/master.m3u8", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Write([]byte("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080\nhigh/index.m3u8\n"))
	})
	mux.HandleFunc("/live/high/index.m3u8", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Write([]byte("#EXTM3U\n#EXTINF:10.0,\nseg0.ts\n#EXTINF:9.5,\nseg1.ts\n#EXTINF:3.25,\n../seg2.ts\n#EXT-X-ENDLIST\n"))
	})
	mux.HandleFunc("/live/media-only.m3u8", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Write([]byte("#EXTM3U\n#EXTINF:4,\nhigh/seg0.ts\n#EXT-X-ENDLIST\n"))
	})
	mux.HandleFunc("/live/empty.m3u8", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Write([]byte("#EXTM3U\n#EXT-X-ENDLIST\n"))
	})
	mux.HandleFunc("/live/redirect.m3u8", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		http.Redirect(w, r, "/live/high/index.m3u8", 302)
	})
	mux.HandleFunc("/live/high/", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Write(seg)
	})
	mux.HandleFunc("/live/seg2.ts", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Write(seg)
	})
	mux.HandleFunc("/html", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Write([]byte("<html>nope</html>"))
	})
	mux.HandleFunc("/missing.m3u8", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		http.Error(w, "gone", 404)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &hits
}

func TestProbeStreamMasterMediaAndErrors(t *testing.T) {
	srv, _ := hlsOrigin(t)

	r := probeStream(srv.URL + "/live/master.m3u8")
	if !r.OK || r.Error != nil {
		t.Fatalf("master probe failed: %+v err=%v", r, nilOrStr(r.Error))
	}
	if r.Resolution == nil || *r.Resolution != "1920x1080" || r.BandwidthKbps == nil || *r.BandwidthKbps != 2500 {
		t.Fatalf("best variant not picked: res=%v bw=%v", nilOrStr(r.Resolution), nilOrInt(r.BandwidthKbps))
	}
	if r.DurationS == nil || *r.DurationS != 22 || r.Segments == nil || *r.Segments != 3 {
		t.Fatalf("duration/segments wrong: %v %v", nilOrInt(r.DurationS), nilOrInt(r.Segments))
	}
	if r.SpeedKbps == nil || *r.SpeedKbps <= 0 || r.LatencyMs == nil || *r.LatencyMs < 0 {
		t.Fatalf("speed/latency missing: %v %v", nilOrInt(r.SpeedKbps), nilOrInt(r.LatencyMs))
	}

	// media-only playlist: resolution unknown (segment has no SPS), bandwidth null
	r = probeStream(srv.URL + "/live/media-only.m3u8")
	if !r.OK || r.Resolution != nil || r.BandwidthKbps != nil || *r.Segments != 1 || *r.DurationS != 4 {
		t.Fatalf("media-only: %+v", r)
	}

	// redirect: segments resolved against the final URL
	r = probeStream(srv.URL + "/live/redirect.m3u8")
	if !r.OK || *r.Segments != 3 {
		t.Fatalf("redirect: ok=%v err=%v", r.OK, nilOrStr(r.Error))
	}

	for _, c := range []struct{ path, want string }{
		{"/html", "not an m3u8"},
		{"/live/empty.m3u8", "empty playlist"},
		{"/missing.m3u8", "HTTP 404"},
	} {
		r = probeStream(srv.URL + c.path)
		if r.OK || r.Error == nil || *r.Error != c.want {
			t.Errorf("%s: ok=%v err=%v want %q", c.path, r.OK, nilOrStr(r.Error), c.want)
		}
	}
	// Python: _fetch raises HTTPError before latency is assigned -> latency_ms stays None
	r = probeStream(srv.URL + "/missing.m3u8")
	if r.LatencyMs != nil {
		t.Errorf("latency should be null on HTTP error, got %v", *r.LatencyMs)
	}

	// connection refused: error text starts with the Python exception family name
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()
	r = probeStream(deadURL + "/x.m3u8")
	if r.OK || r.Error == nil || !strings.HasPrefix(*r.Error, "URLError: ") {
		t.Errorf("dead host: %v", nilOrStr(r.Error))
	}
}

func TestProbeManyMergesCachesAndFresh(t *testing.T) {
	srv, hits := hlsOrigin(t)
	a := newApp(Config{Upstream: "http://127.0.0.1:9", User: "u", Pass: "p", CacheDir: t.TempDir()})

	items := []map[string]interface{}{
		{"source": "s1", "source_name": "One", "url": srv.URL + "/live/master.m3u8"},
		{"source": "s2", "source_name": "Two"},
		{"source": "s3", "url": srv.URL + "/html"},
	}
	out := a.probeMany(items, false)
	if len(out) != 3 {
		t.Fatalf("len = %d", len(out))
	}
	// input keys preserved, probe keys merged, order kept
	if out[0]["source"] != "s1" || out[0]["source_name"] != "One" || out[0]["ok"] != true || out[0]["url"] != items[0]["url"] {
		t.Fatalf("row0 = %v", out[0])
	}
	for _, k := range []string{"url", "ok", "latency_ms", "speed_kbps", "resolution", "bandwidth_kbps", "duration_s", "segments", "error"} {
		if _, has := out[0][k]; !has {
			t.Errorf("row0 missing key %s", k)
		}
	}
	if out[0]["error"] != nil || out[0]["resolution"] != "1920x1080" {
		t.Errorf("row0 error/res = %v / %v", out[0]["error"], out[0]["resolution"])
	}
	// no url: Python returns dict(it, ok=False, error="no url") with no other probe keys
	if out[1]["ok"] != false || out[1]["error"] != "no url" || out[1]["source"] != "s2" {
		t.Errorf("row1 = %v", out[1])
	}
	if _, has := out[1]["latency_ms"]; has {
		t.Errorf("row1 should not carry probe keys: %v", out[1])
	}
	if out[2]["ok"] != false || out[2]["error"] != "not an m3u8" || out[2]["segments"] != nil {
		t.Errorf("row2 = %v", out[2])
	}
	// JSON shape: ints not floats, nulls present
	js := string(marshal(out[2]))
	if !strings.Contains(js, `"segments":null`) || !strings.Contains(js, `"error":"not an m3u8"`) {
		t.Errorf("json = %s", js)
	}

	// cached: a second call makes no new requests
	before := atomic.LoadInt32(hits)
	out2 := a.probeMany(items, false)
	if atomic.LoadInt32(hits) != before {
		t.Fatalf("cache miss: hits %d -> %d", before, atomic.LoadInt32(hits))
	}
	if !reflect.DeepEqual(out2[0], out[0]) {
		t.Fatalf("cached row differs: %v vs %v", out2[0], out[0])
	}
	// fresh=true re-measures
	a.probeMany(items, true)
	if atomic.LoadInt32(hits) <= before {
		t.Fatal("fresh did not re-probe")
	}
	// cache entry lives under "probe:"+url with the 15-min TTL
	if _, err := a.mem.get("probe:"+items[0]["url"].(string), probeTTL, func() (interface{}, error) { t.Fatal("should be cached"); return nil, nil }); err != nil {
		t.Fatal(err)
	}
	// and expires: force an old timestamp
	a.mem.mu.Lock()
	it := a.mem.items["probe:"+items[0]["url"].(string)]
	it.at = time.Now().Add(-probeTTL - time.Second)
	a.mem.items["probe:"+items[0]["url"].(string)] = it
	a.mem.mu.Unlock()
	before = atomic.LoadInt32(hits)
	a.probeMany(items[:1], false)
	if atomic.LoadInt32(hits) == before {
		t.Fatal("expired entry was served")
	}
}

func TestProbeManyConcurrencyBound(t *testing.T) {
	var cur, peak int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&cur, 1)
		for {
			p := atomic.LoadInt32(&peak)
			if n <= p || atomic.CompareAndSwapInt32(&peak, p, n) {
				break
			}
		}
		time.Sleep(60 * time.Millisecond)
		atomic.AddInt32(&cur, -1)
		w.Write([]byte("<html>"))
	}))
	defer srv.Close()
	a := newApp(Config{Upstream: "http://127.0.0.1:9", User: "u", Pass: "p", CacheDir: t.TempDir()})
	items := make([]map[string]interface{}, 24)
	for i := range items {
		items[i] = map[string]interface{}{"url": srv.URL + "/" + string(rune('a'+i))}
	}
	start := time.Now()
	out := a.probeMany(items, false)
	el := time.Since(start)
	if len(out) != 24 {
		t.Fatal("len")
	}
	if p := atomic.LoadInt32(&peak); p > 8 || p < 2 {
		t.Fatalf("peak concurrency = %d, want 2..8", p)
	}
	if el > 2*time.Second {
		t.Fatalf("too slow (%v): workers not parallel", el)
	}
}

func TestProbeEndpoints(t *testing.T) {
	origin, _ := hlsOrigin(t)
	_, srv, _ := testApp(t)

	st, _, body := get(t, srv.URL+"/probe", nil)
	if st != 400 || !strings.Contains(string(body), "url required") {
		t.Fatalf("GET /probe no url: %d %s", st, body)
	}
	st, _, body = get(t, srv.URL+"/probe?url="+origin.URL+"/live/master.m3u8", nil)
	var one map[string]interface{}
	decode(t, body, &one)
	if st != 200 || one["ok"] != true || one["resolution"] != "1920x1080" {
		t.Fatalf("GET /probe: %d %s", st, body)
	}

	st, body = post(t, srv.URL+"/probe", `{"items":[{"source":"a","url":"`+origin.URL+`/live/media-only.m3u8"}],"fresh":true}`, nil)
	var many []map[string]interface{}
	decode(t, body, &many)
	if st != 200 || len(many) != 1 || many[0]["ok"] != true || many[0]["source"] != "a" {
		t.Fatalf("POST /probe: %d %s", st, body)
	}
	st, body = post(t, srv.URL+"/probe", `[{"url":"`+origin.URL+`/html"}]`, nil)
	decode(t, body, &many)
	if st != 200 || len(many) != 1 || many[0]["error"] != "not an m3u8" {
		t.Fatalf("POST /probe bare list: %d %s", st, body)
	}
	st, body = post(t, srv.URL+"/probe", `{"items":[]}`, nil)
	if st != 400 || !strings.Contains(string(body), "items[] required") {
		t.Fatalf("POST /probe empty: %d %s", st, body)
	}
}
