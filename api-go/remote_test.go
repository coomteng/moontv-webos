package main

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestRemoteNewSendPollRoundtrip(t *testing.T) {
	_, srv, _ := testApp(t)

	st, body := post(t, srv.URL+"/remote/new", `{}`, nil)
	var ch map[string]interface{}
	decode(t, body, &ch)
	if st != 200 {
		t.Fatalf("/remote/new: %d %s", st, body)
	}
	cid, _ := ch["id"].(string)
	if !regexp.MustCompile(`^[abcdefghjkmnpqrstuvwxyz23456789]{6}$`).MatchString(cid) {
		t.Fatalf("bad id %q", cid)
	}
	if ch["seq"] != float64(0) {
		t.Fatalf("seq = %v", ch["seq"])
	}
	host := strings.TrimPrefix(srv.URL, "http://")
	if ch["url"] != "http://"+host+"/r/"+cid {
		t.Fatalf("url = %v", ch["url"])
	}

	// same id is reused on re-registration (with surrounding whitespace stripped)
	_, body = post(t, srv.URL+"/remote/new", `{"id":" `+cid+` "}`, nil)
	var ch2 map[string]interface{}
	decode(t, body, &ch2)
	if ch2["id"] != cid {
		t.Fatalf("re-registration changed id: %v", ch2["id"])
	}
	// unknown-but-valid id is adopted as-is (the TV re-registers its stored id after a bridge restart)
	_, body = post(t, srv.URL+"/remote/new", `{"id":"ZZtop99"}`, nil)
	decode(t, body, &ch2)
	if ch2["id"] != "ZZtop99" || ch2["seq"] != float64(0) {
		t.Fatalf("valid id not adopted: %v", ch2)
	}
	if st, _, _ := get(t, srv.URL+"/remote/ZZtop99/state", nil); st != 200 {
		t.Fatalf("adopted channel not reachable: %d", st)
	}
	// invalid id -> generated
	_, body = post(t, srv.URL+"/remote/new", `{"id":"../x"}`, nil)
	decode(t, body, &ch2)
	if len(ch2["id"].(string)) != 6 {
		t.Fatalf("invalid id not replaced: %v", ch2["id"])
	}

	// empty state before the TV reports -> {}
	st, _, body = get(t, srv.URL+"/remote/"+cid+"/state", nil)
	if st != 200 || strings.TrimSpace(string(body)) != "{}" {
		t.Fatalf("initial state: %d %s", st, body)
	}

	// poll with nothing pending returns immediately when seq already covers it? No: it waits.
	// So test the wakeup: start a long-poll, then send.
	type pollRes struct {
		st   int
		body []byte
		dur  time.Duration
	}
	done := make(chan pollRes, 1)
	go func() {
		t0 := time.Now()
		s, _, b := get(t, srv.URL+"/remote/"+cid+"/poll?since=0", nil)
		done <- pollRes{s, b, time.Since(t0)}
	}()
	time.Sleep(300 * time.Millisecond)
	select {
	case <-done:
		t.Fatal("poll returned before any message")
	default:
	}
	text := strings.Repeat("兰香如故", 200) // 800 runes -> truncated to 500
	st, body = post(t, srv.URL+"/remote/"+cid+"/send", `{"text":`+string(marshal(text))+`,"action":"submit"}`, nil)
	var sres map[string]interface{}
	decode(t, body, &sres)
	if st != 200 || sres["ok"] != true || sres["seq"] != float64(1) {
		t.Fatalf("send: %d %s", st, body)
	}
	var pr pollRes
	select {
	case pr = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("long-poll did not wake up on send")
	}
	if pr.dur > 3*time.Second {
		t.Fatalf("poll took %v, should wake immediately", pr.dur)
	}
	var poll struct {
		Seq      int               `json:"seq"`
		Messages []json.RawMessage `json:"messages"`
	}
	decode(t, pr.body, &poll)
	if pr.st != 200 || poll.Seq != 1 || len(poll.Messages) != 1 {
		t.Fatalf("poll: %d %s", pr.st, pr.body)
	}
	var m map[string]interface{}
	decode(t, poll.Messages[0], &m)
	if m["seq"] != float64(1) || m["action"] != "submit" || len([]rune(m["text"].(string))) != 500 || m["t"] == nil {
		t.Fatalf("message = %s", poll.Messages[0])
	}
	// key order of a message matches Python: seq, text, action, t
	if s := string(poll.Messages[0]); !regexp.MustCompile(`^\{"seq":1,"text":".*","action":"submit","t":[0-9.e+]+\}$`).MatchString(s) {
		t.Fatalf("message key order: %s", s)
	}

	// since=1: nothing pending -> waits; since=0: returns pending immediately
	t0 := time.Now()
	st, _, body = get(t, srv.URL+"/remote/"+cid+"/poll?since=0", nil)
	if st != 200 || time.Since(t0) > time.Second || !strings.Contains(string(body), `"seq":1`) {
		t.Fatalf("poll since=0 replay: %d %s", st, body)
	}

	// bad action falls back to input; non-string text is str()'d like Python
	st, body = post(t, srv.URL+"/remote/"+cid+"/send", `{"text":123,"action":"delete"}`, nil)
	decode(t, body, &sres)
	if st != 200 || sres["seq"] != float64(2) {
		t.Fatalf("send 2: %d %s", st, body)
	}
	st, _, body = get(t, srv.URL+"/remote/"+cid+"/poll?since=1", nil)
	decode(t, body, &poll)
	if st != 200 || poll.Seq != 2 || len(poll.Messages) != 1 {
		t.Fatalf("poll since=1: %d %s", st, body)
	}
	decode(t, poll.Messages[0], &m)
	if m["text"] != "123" || m["action"] != "input" {
		t.Fatalf("message 2 = %v", m)
	}

	// state POST/GET: truncation and key set
	st, body = post(t, srv.URL+"/remote/"+cid+"/state", `{"open":1,"label":"`+strings.Repeat("搜", 30)+`","value":"`+strings.Repeat("v", 150)+`"}`, nil)
	if st != 200 || strings.TrimSpace(string(body)) != `{"ok":true}` {
		t.Fatalf("state post: %d %s", st, body)
	}
	st, _, body = get(t, srv.URL+"/remote/"+cid+"/state", nil)
	var stt map[string]interface{}
	decode(t, body, &stt)
	if st != 200 || stt["open"] != true || len([]rune(stt["label"].(string))) != 20 || len(stt["value"].(string)) != 100 || len(stt) != 3 {
		t.Fatalf("state get: %d %s", st, body)
	}
	if !strings.HasPrefix(string(body), `{"open":true,"label":`) {
		t.Fatalf("state key order: %s", body)
	}
	st, body = post(t, srv.URL+"/remote/"+cid+"/state", `{}`, nil)
	st, _, body = get(t, srv.URL+"/remote/"+cid+"/state", nil)
	if strings.TrimSpace(string(body)) != `{"open":false,"label":"","value":""}` {
		t.Fatalf("empty state post: %s", body)
	}
}

func TestRemotePollTimeoutAndMessageWindow(t *testing.T) {
	rm := newRemote()
	ch := rm.channel("", true)
	t0 := time.Now()
	res := rm.poll(ch, 0, 150*time.Millisecond)
	if d := time.Since(t0); d < 140*time.Millisecond || d > 2*time.Second {
		t.Fatalf("poll timeout took %v", d)
	}
	if res["seq"] != 0 || len(res["messages"].([]remoteMsg)) != 0 {
		t.Fatalf("empty poll = %v", res)
	}
	for i := 0; i < 25; i++ {
		rm.send(ch, "m", "input")
	}
	res = rm.poll(ch, 0, time.Second)
	msgs := res["messages"].([]remoteMsg)
	if res["seq"] != 25 || len(msgs) != 20 || msgs[0].Seq != 6 || msgs[19].Seq != 25 {
		t.Fatalf("window: seq=%v n=%d first=%d", res["seq"], len(msgs), msgs[0].Seq)
	}
	// idle channel expires after remoteTTL
	ch.t = time.Now().Add(-remoteTTL - time.Minute)
	if rm.channel(ch.id, false) != nil {
		t.Fatal("expired channel still served")
	}
	// generated ids are unique-ish and use the restricted alphabet
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		id := rm.newID()
		if len(id) != 6 || seen[id] || strings.ContainsAny(id, "01iol") {
			t.Fatalf("bad generated id %q", id)
		}
		seen[id] = true
	}
}

func TestRemote404sAndIDValidation(t *testing.T) {
	_, srv, _ := testApp(t)
	for _, c := range []struct {
		method, path, want string
		status             int
	}{
		{"GET", "/remote/zzzzzz/poll", "no such channel", 404},
		{"GET", "/remote/zzzzzz/state", "no such channel", 404},
		{"GET", "/remote/zzzzzz/qr.svg", "no such channel", 404},
		{"GET", "/remote/zzzzzz", "not found", 404},
		{"GET", "/remote/a/b/c", "not found", 404},
		{"POST", "/remote/zzzzzz/send", "no such channel", 404},
		{"POST", "/remote/zzzzzz/state", "no such channel", 404},
		{"POST", "/remote/zzzzzz", "no such channel", 404},
		{"GET", "/r/abc", "not found", 404},               // too short
		{"GET", "/r/abcdefghijklmnopq", "not found", 404}, // too long
		{"GET", "/r/ab-cd", "not found", 404},             // bad char
		{"GET", "/r/../etc", "not found", 404},            // traversal-looking
	} {
		var st int
		var body []byte
		if c.method == "GET" {
			st, _, body = get(t, srv.URL+c.path, nil)
		} else {
			st, body = post(t, srv.URL+c.path, `{}`, nil)
		}
		if st != c.status || strings.TrimSpace(string(body)) != `{"error":"`+c.want+`"}` {
			t.Errorf("%s %s: %d %s", c.method, c.path, st, body)
		}
	}

	// existing channel, unknown op
	_, body := post(t, srv.URL+"/remote/new", `{}`, nil)
	var ch map[string]interface{}
	decode(t, body, &ch)
	cid := ch["id"].(string)
	st, _, body := get(t, srv.URL+"/remote/"+cid+"/bogus", nil)
	if st != 404 || !strings.Contains(string(body), `"not found"`) {
		t.Errorf("GET bogus op: %d %s", st, body)
	}
	st, body = post(t, srv.URL+"/remote/"+cid+"/bogus", `{}`, nil)
	if st != 404 || !strings.Contains(string(body), `"not found"`) {
		t.Errorf("POST bogus op: %d %s", st, body)
	}

	// phone page: id embedded as JSON, served as HTML, verbatim template
	st, h, body := get(t, srv.URL+"/r/"+cid, nil)
	if st != 200 || h.Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("/r/<id>: %d %s", st, h.Get("Content-Type"))
	}
	if !strings.Contains(string(body), `var ID="`+cid+`";`) || !strings.Contains(string(body), "MoonTV 电视输入") || strings.Contains(string(body), "__ID__") {
		t.Fatalf("phone page body: %.200s", body)
	}
	// any syntactically valid id renders, even if no channel exists yet (Python behaviour)
	st, _, _ = get(t, srv.URL+"/r/ABCD1234", nil)
	if st != 200 {
		t.Fatalf("/r/ valid-but-unknown: %d", st)
	}

	// QR: SVG with a path, white background, cache header, encodes http://<Host>/r/<id>
	st, h, body = get(t, srv.URL+"/remote/"+cid+"/qr.svg", nil)
	if st != 200 || h.Get("Content-Type") != "image/svg+xml" || h.Get("Cache-Control") != "public, max-age=86400" {
		t.Fatalf("qr.svg: %d %v", st, h)
	}
	s := string(body)
	if !strings.HasPrefix(s, "<svg ") || !strings.Contains(s, `<path d="M`) || !strings.Contains(s, `fill="#ffffff"`) || !strings.HasSuffix(s, "</svg>") {
		t.Fatalf("qr.svg body: %.200s", s)
	}
	svg1, err := qrSVG("http://tv.local:8788/r/" + cid)
	if err != nil {
		t.Fatal(err)
	}
	svg2, _ := qrSVG("http://tv.local:8788/r/other1")
	if string(svg1) == string(svg2) {
		t.Fatal("qr does not depend on content")
	}
	m := regexp.MustCompile(`^<svg width="(\d+)mm" height="(\d+)mm" version="1.1" viewBox="0 0 (\d+) (\d+)"`).FindStringSubmatch(string(svg1))
	if m == nil || m[1] != m[2] || m[1] != m[3] || m[1] != m[4] {
		t.Fatalf("svg header: %.120s", svg1)
	}
	// go-qrcode version 1 is 21 modules; with border 2 the canvas is at least 25 units
	if n := atoi(m[1], 0); n < 25 || n%2 == 0 {
		t.Fatalf("svg dimension %d looks wrong", n)
	}
}
