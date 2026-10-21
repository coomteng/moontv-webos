package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fakeMoonTV is a minimal stand-in for MoonTV's API: cookie login, 401 without it,
// douban categories, playrecords (per user), search, searchhistory, image-proxy.
type counters struct {
	logins, lists  int
	lastMethodPath string
	lastBody       map[string]interface{}
}

func fakeMoonTV(t *testing.T) (*httptest.Server, *counters) {
	t.Helper()
	counters := &counters{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/login", func(w http.ResponseWriter, r *http.Request) {
		var b map[string]string
		json.NewDecoder(r.Body).Decode(&b)
		counters.logins++
		if b["password"] != b["username"] { // convention: password == username is valid
			w.WriteHeader(401)
			w.Write([]byte(`{"error":"bad"}`))
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "auth", Value: "tok-" + b["username"], Path: "/"})
		w.Write([]byte(`{"ok":true}`))
	})
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			c, err := r.Cookie("auth")
			if err != nil || !strings.HasPrefix(c.Value, "tok-") {
				w.WriteHeader(401)
				w.Write([]byte("Unauthorized"))
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("/api/douban/categories", auth(func(w http.ResponseWriter, r *http.Request) {
		counters.lists++
		q := r.URL.Query()
		w.Write([]byte(`{"code":200,"list":[{"id":"1","title":"` + q.Get("kind") + "/" + q.Get("category") + "/" + q.Get("type") + `","poster":"http://p/1.jpg","rate":"8.1","year":"2026"}]}`))
	}))
	mux.HandleFunc("/api/douban/recommends", auth(func(w http.ResponseWriter, r *http.Request) {
		counters.lists++
		q := r.URL.Query()
		w.Write([]byte(`{"code":200,"list":[{"id":"3","title":"rec:` + q.Get("kind") + "/" + q.Get("category") + "/" + q.Get("format") + `","poster":"http://p/3.jpg","rate":"","year":""}]}`))
	}))
	mux.HandleFunc("/api/favorites", auth(func(w http.ResponseWriter, r *http.Request) {
		c, _ := r.Cookie("auth")
		counters.lastMethodPath = r.Method + " " + r.URL.RequestURI()
		if r.Method != "GET" {
			if r.Method == "POST" {
				var b map[string]interface{}
				json.NewDecoder(r.Body).Decode(&b)
				counters.lastBody = b
			}
			w.Write([]byte(`{"ok":true}`))
			return
		}
		user := strings.TrimPrefix(c.Value, "tok-")
		w.Write([]byte(`{"a+1":{"title":"` + user + ` 收藏","cover":"http://p/f.jpg","save_time":5,"total_episodes":12},"b+2":{"title":"旧收藏","save_time":1}}`))
	}))
	mux.HandleFunc("/api/skipconfigs", auth(func(w http.ResponseWriter, r *http.Request) {
		counters.lastMethodPath = r.Method + " " + r.URL.RequestURI()
		if r.Method != "GET" {
			if r.Method == "POST" {
				var b map[string]interface{}
				json.NewDecoder(r.Body).Decode(&b)
				counters.lastBody = b
			}
			w.Write([]byte(`{"ok":true}`))
			return
		}
		w.Write([]byte(`{"ruyi+86003":{"enable":true,"intro_time":90,"outro_time":120}}`))
	}))
	mux.HandleFunc("/api/bangumi/calendar", auth(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"weekday":{"cn":"星期一","id":1},"items":[{"id":1,"name":"jp","name_cn":"周一番","air_date":"2026-04-06","rating":{"score":7.5},"images":{"large":"http://b/1.jpg"}}]},
		                 {"weekday":{"cn":"星期日","id":7},"items":[{"id":7,"name":"sun","name_cn":"","air_date":"2026-01-01","rating":{"score":0},"images":{"large":"http://b/7.jpg"}}]}]`))
	}))
	mux.HandleFunc("/api/playrecords", auth(func(w http.ResponseWriter, r *http.Request) {
		c, _ := r.Cookie("auth")
		counters.lastMethodPath = r.Method + " " + r.URL.RequestURI()
		if r.Method == "POST" || r.Method == "DELETE" {
			w.Write([]byte(`{"ok":true}`))
			return
		}
		user := strings.TrimPrefix(c.Value, "tok-")
		w.Write([]byte(`{"src+1":{"title":"` + user + ` 看的剧","cover":"http://p/c.jpg","index":3,"total_episodes":10,"play_time":100,"total_time":2000,"save_time":2,"year":"2025"},
		                 "src+2":{"title":"旧的","cover":"","save_time":1},
		                 "nokey":{"title":"ignored"}}`))
	}))
	mux.HandleFunc("/api/search", auth(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"results":[
		  {"source":"a","source_name":"A","id":"1","title":"兰香如故","poster":"","year":"2026","type_name":"剧","class":"古装","desc":"` + strings.Repeat("长", 400) + `","episodes":["u1","u2"],"episodes_titles":["1","2"],"douban_id":1},
		  {"source":"b","source_name":"B","id":"9","title":"兰香如故","poster":"http://p/b.jpg","year":"2026","episodes":["v1"]},
		  {"source":"c","source_name":"C","id":"3","title":"别的","poster":null,"year":"2024","episodes":null}
		]}`))
	}))
	mux.HandleFunc("/api/searchhistory", auth(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`["流浪地球","2026年世界杯"]`))
	}))
	mux.HandleFunc("/api/image-proxy", auth(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		w.Write([]byte("JPEGDATA:" + r.URL.Query().Get("url")))
	}))
	mux.HandleFunc("/api/detail", auth(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":"` + r.URL.Query().Get("id") + `","title":"d"}`))
	}))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, counters
}

func testApp(t *testing.T) (*App, *httptest.Server, *counters) {
	t.Helper()
	up, counters := fakeMoonTV(t)
	dir := t.TempDir()
	cfg := Config{Upstream: up.URL, User: "moontv1", Pass: "moontv1", CacheDir: dir,
		SeedAccounts: [][2]string{{"moontv1", "moontv1"}, {"moontv2", "moontv2"}}}
	app := newApp(cfg)
	srv := httptest.NewServer(app.routes())
	t.Cleanup(srv.Close)
	return app, srv, counters
}

func get(t *testing.T, url string, hdr map[string]string) (int, http.Header, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf strings.Builder
	b := make([]byte, 1<<16)
	for {
		n, err := resp.Body.Read(b)
		buf.Write(b[:n])
		if err != nil {
			break
		}
	}
	return resp.StatusCode, resp.Header, []byte(buf.String())
}

func post(t *testing.T, url, body string, hdr map[string]string) (int, []byte) {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var sb strings.Builder
	b := make([]byte, 1<<16)
	for {
		n, err := resp.Body.Read(b)
		sb.Write(b[:n])
		if err != nil {
			break
		}
	}
	return resp.StatusCode, []byte(sb.String())
}

func decode(t *testing.T, b []byte, v interface{}) {
	t.Helper()
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("bad json %q: %v", b, err)
	}
}

// ---------------------------------------------------------------- tests

func TestHealthAndCORS(t *testing.T) {
	_, srv, _ := testApp(t)
	st, h, b := get(t, srv.URL+"/health", nil)
	if st != 200 || h.Get("Access-Control-Allow-Origin") != "*" || !strings.Contains(h.Get("Access-Control-Allow-Headers"), "X-Session") {
		t.Fatalf("health: %d %v %s", st, h, b)
	}
	req, _ := http.NewRequest("OPTIONS", srv.URL+"/home", nil)
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 204 || resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("preflight: %d", resp.StatusCode)
	}
}

func TestLoginSessionsAndMe(t *testing.T) {
	_, srv, _ := testApp(t)
	st, b := post(t, srv.URL+"/login", `{"username":"moontv2","password":"wrong"}`, nil)
	if st != 401 || !strings.Contains(string(b), "login failed") {
		t.Fatalf("bad password: %d %s", st, b)
	}
	st, b = post(t, srv.URL+"/login", `{"username":"","password":"x"}`, nil)
	if st != 400 {
		t.Fatalf("missing user: %d", st)
	}
	st, b = post(t, srv.URL+"/login", `{"username":"moontv2","password":"moontv2"}`, nil)
	var lg struct {
		OK       bool   `json:"ok"`
		Session  string `json:"session"`
		Username string `json:"username"`
	}
	decode(t, b, &lg)
	if st != 200 || !lg.OK || len(lg.Session) != 64 || lg.Username != "moontv2" {
		t.Fatalf("login: %d %s", st, b)
	}
	// /me without session = default account; with session = that user
	var me struct {
		Username string `json:"username"`
		Default  bool   `json:"default"`
	}
	_, _, b = get(t, srv.URL+"/me", nil)
	decode(t, b, &me)
	if me.Username != "moontv1" || !me.Default {
		t.Fatalf("me default: %s", b)
	}
	_, _, b = get(t, srv.URL+"/me", map[string]string{"X-Session": lg.Session})
	decode(t, b, &me)
	if me.Username != "moontv2" || me.Default {
		t.Fatalf("me session: %s", b)
	}
	// ?session= query form works too; bogus token -> 401 "session expired"
	st, _, _ = get(t, srv.URL+"/me?session="+lg.Session, nil)
	if st != 200 {
		t.Fatalf("query session: %d", st)
	}
	st, _, b = get(t, srv.URL+"/me", map[string]string{"X-Session": "deadbeef"})
	if st != 401 || !strings.Contains(string(b), "session expired") {
		t.Fatalf("bogus: %d %s", st, b)
	}
	// logout invalidates
	post(t, srv.URL+"/logout", `{}`, map[string]string{"X-Session": lg.Session})
	st, _, _ = get(t, srv.URL+"/me", map[string]string{"X-Session": lg.Session})
	if st != 401 {
		t.Fatalf("after logout: %d", st)
	}
}

func TestHomePerUserAndKeyOrder(t *testing.T) {
	_, srv, counters := testApp(t)
	_, b := post(t, srv.URL+"/login", `{"username":"moontv2","password":"moontv2"}`, nil)
	var lg struct{ Session string }
	decode(t, b, &lg)

	_, _, b1 := get(t, srv.URL+"/home", nil)
	_, _, b2 := get(t, srv.URL+"/home", map[string]string{"X-Session": lg.Session})
	for _, want := range []string{`"user": "moontv1"`, `"continue": [`, `"movie": [`, `"show": [`} {
		if !strings.Contains(string(b1), want) {
			t.Fatalf("home missing %q in %s", want, b1)
		}
	}
	if !strings.Contains(string(b1), "moontv1 看的剧") || !strings.Contains(string(b2), "moontv2 看的剧") {
		t.Fatalf("continue not per-user:\n%s\n%s", b1, b2)
	}
	// key order: user, continue, movie, tv, anime, show
	s := string(b1)
	if !(strings.Index(s, `"user"`) < strings.Index(s, `"continue"`) && strings.Index(s, `"continue"`) < strings.Index(s, `"movie"`) &&
		strings.Index(s, `"movie"`) < strings.Index(s, `"tv"`) && strings.Index(s, `"anime"`) < strings.Index(s, `"show"`)) {
		t.Fatalf("key order wrong: %s", s[:200])
	}
	var rows struct {
		Anime []Item `json:"anime"`
		Show  []Item `json:"show"`
		TV    []Item `json:"tv"`
	}
	decode(t, b1, &rows)
	if rows.Anime[0].Title == rows.Show[0].Title || rows.Anime[0].Title != "rec:tv/动画/电视剧" || rows.Show[0].Title != "tv/show/show" || rows.TV[0].Title != "tv/tv/tv" {
		t.Fatalf("home rows must come from distinct tags: anime=%v show=%v tv=%v", rows.Anime[0].Title, rows.Show[0].Title, rows.TV[0].Title)
	}
	// shared lists are cached: second /home must not hit douban again
	n := counters.lists
	get(t, srv.URL+"/home", nil)
	if counters.lists != n {
		t.Fatalf("douban lists not cached: %d -> %d", n, counters.lists)
	}
	// record shape + sorting (newest first) + non "+" keys dropped
	var home struct {
		Continue []Rec `json:"continue"`
	}
	decode(t, b1, &home)
	if len(home.Continue) != 2 || home.Continue[0].Key != "src+1" || home.Continue[0].Source != "src" || home.Continue[0].ID != "1" {
		t.Fatalf("continue: %+v", home.Continue)
	}
	if home.Continue[1].Index != float64(1) || home.Continue[1].TotalEpisodes != float64(1) || home.Continue[1].SearchTitle != "" {
		t.Fatalf("record defaults: %+v", home.Continue[1])
	}
}

func TestListFiltersAndValidation(t *testing.T) {
	_, srv, _ := testApp(t)
	st, _, _ := get(t, srv.URL+"/list?type=bogus", nil)
	if st != 400 {
		t.Fatalf("bad type: %d", st)
	}
	_, _, b := get(t, srv.URL+"/list?type=movie&tag=豆瓣高分&region=日本&size=5", nil)
	var items []Item
	decode(t, b, &items)
	if len(items) != 1 || items[0].Title != "movie/豆瓣高分/日本" {
		t.Fatalf("movie list: %s", b)
	}
	// every chip maps to exactly the request MoonTV's web UI makes
	cases := map[string]string{
		"/list?type=movie": "movie/热门/全部",
		"/list?type=movie&tag=最新电影&region=韩国": "movie/最新/韩国",
		"/list?type=tv":             "tv/tv/tv",
		"/list?type=tv&region=韩国":   "tv/tv/tv_korean",
		"/list?type=tv&region=动漫":   "tv/tv/tv_animation",
		"/list?type=show":           "tv/show/show",
		"/list?type=show&region=国内": "tv/show/show_domestic",
		"/list?type=anime":          "rec:tv/动画/电视剧",
		"/list?type=anime&tag=剧场版":  "rec:movie/动画/",
	}
	for path, want := range cases {
		_, _, b = get(t, srv.URL+path, nil)
		decode(t, b, &items)
		if len(items) == 0 || items[0].Title != want {
			t.Errorf("%s -> %s, want %s", path, b, want)
		}
	}
	_, h, b := get(t, srv.URL+"/filters", nil)
	var f map[string]filterSet
	decode(t, b, &f)
	if f["movie"].Cats[0] != "热门电影" || len(f["movie"].Regions) != 5 || f["tv"].Regions[1] != "国产" || f["anime"].Cats[1] != "剧场版" || f["show"].Regions[2] != "国外" || h.Get("Cache-Control") != "public, max-age=3600" {
		t.Fatalf("filters: %s %v", b, h)
	}
	// key order movie, tv, anime, show is kept for byte-stable output
	s := string(b)
	if !(strings.Index(s, `"movie"`) < strings.Index(s, `"tv"`) && strings.Index(s, `"tv"`) < strings.Index(s, `"anime"`) && strings.Index(s, `"anime"`) < strings.Index(s, `"show"`)) {
		t.Fatalf("filters key order: %s", s)
	}
}

func TestSearchGrouping(t *testing.T) {
	_, srv, _ := testApp(t)
	_, _, b := get(t, srv.URL+"/search?q=", nil)
	if string(b) != "[]" {
		t.Fatalf("empty query: %s", b)
	}
	_, _, b = get(t, srv.URL+"/search?q=兰香如故", nil)
	var groups []Group
	decode(t, b, &groups)
	if len(groups) != 2 || groups[0].Title != "兰香如故" || len(groups[0].Sources) != 2 || groups[1].Title != "别的" {
		t.Fatalf("groups: %s", b)
	}
	// poster backfilled from the second source; desc truncated to 300 runes; null episodes -> []
	if groups[0].Poster != "http://p/b.jpg" {
		t.Fatalf("poster backfill: %v", groups[0].Poster)
	}
	if n := len([]rune(groups[0].Sources[0].Desc)); n != 300 {
		t.Fatalf("desc len %d", n)
	}
	if groups[1].Sources[0].Episodes == nil || len(groups[1].Sources[0].Episodes) != 0 {
		t.Fatalf("episodes should be []: %s", b)
	}
	if !strings.Contains(string(b), `"episodes": []`) && !strings.Contains(string(b), `"episodes":[]`) {
		t.Fatalf("episodes must serialise as [] not null: %s", b)
	}
}

func TestPosterCacheOnDisk(t *testing.T) {
	app, srv, _ := testApp(t)
	u := "https://img/x.jpg"
	st, h, b := get(t, srv.URL+"/poster?url="+u, nil)
	if st != 200 || h.Get("Content-Type") != "image/jpeg" || string(b) != "JPEGDATA:"+u || h.Get("Cache-Control") != "public, max-age=604800" {
		t.Fatalf("poster: %d %v %s", st, h, b)
	}
	// file format shared with the Python bridge: "<ctype>\n<body>"
	data, err := os.ReadFile(app.posters.path(u))
	if err != nil || string(data) != "image/jpeg\nJPEGDATA:"+u {
		t.Fatalf("cache file: %q %v", data, err)
	}
	// served from cache even if upstream changes
	os.WriteFile(app.posters.path(u), []byte("image/png\nCACHED"), 0o644)
	_, h, b = get(t, srv.URL+"/poster?url="+u, nil)
	if string(b) != "CACHED" || h.Get("Content-Type") != "image/png" {
		t.Fatalf("cache hit: %v %s", h, b)
	}
}

func TestRecordPostUsesSessionAndDefaultsSaveTime(t *testing.T) {
	_, srv, _ := testApp(t)
	st, b := post(t, srv.URL+"/record", `{"key":"a+1"}`, nil)
	if st != 400 {
		t.Fatalf("validation: %d %s", st, b)
	}
	st, b = post(t, srv.URL+"/record", `{"key":"a+1","record":{"title":"x"}}`, map[string]string{"X-Session": "nope"})
	if st != 401 {
		t.Fatalf("bad session: %d %s", st, b)
	}
	st, b = post(t, srv.URL+"/record", `{"key":"a+1","record":{"title":"x"}}`, nil)
	if st != 200 || string(b) != `{"ok":true}` {
		t.Fatalf("record: %d %s", st, b)
	}
}

func TestReloginOn401(t *testing.T) {
	app, srv, counters := testApp(t)
	get(t, srv.URL+"/me", nil)
	get(t, srv.URL+"/record", nil)
	n := counters.logins
	app.defaultUp.mu.Lock()
	app.defaultUp.cookie_ = "auth=stale" // simulate MoonTV having expired the cookie
	app.defaultUp.at = time.Time{}
	app.defaultUp.mu.Unlock()
	st, _, _ := get(t, srv.URL+"/record", nil)
	if st != 200 || counters.logins != n+1 {
		t.Fatalf("expected one silent re-login: status %d logins %d->%d", st, n, counters.logins)
	}
}

func TestGzipOnlyForLargeTextLikeBodies(t *testing.T) {
	_, srv, _ := testApp(t)
	_, h, _ := get(t, srv.URL+"/search?q=兰香如故", map[string]string{"Accept-Encoding": "gzip"})
	if h.Get("Content-Encoding") != "gzip" {
		t.Fatalf("large JSON should be gzipped: %v", h)
	}
	_, h, _ = get(t, srv.URL+"/health", map[string]string{"Accept-Encoding": "gzip"})
	if h.Get("Content-Encoding") != "" {
		t.Fatalf("small JSON must not be gzipped")
	}
	_, h, _ = get(t, srv.URL+"/poster?url=x", map[string]string{"Accept-Encoding": "gzip"})
	if h.Get("Content-Encoding") != "" {
		t.Fatalf("images must not be gzipped")
	}
}

func TestSeedAccounts(t *testing.T) {
	_, srv, _ := testApp(t)
	_, _, b := get(t, srv.URL+"/seed-accounts", nil)
	var seeds []map[string]string
	decode(t, b, &seeds)
	want := []map[string]string{{"username": "moontv1", "password": "moontv1"}, {"username": "moontv2", "password": "moontv2"}}
	if !reflect.DeepEqual(seeds, want) {
		t.Fatalf("seeds: %s", b)
	}
}

func TestTitleVariantsAndPinyinIndex(t *testing.T) {
	cases := map[string][]string{
		"现在就出发 第四季":            {"现在就出发 第四季", "现在就出发"},
		"兰香如故":                 {"兰香如故"},
		"出差沟通之神：SEVENTEEN团结大会": {"出差沟通之神：SEVENTEEN团结大会", "出差沟通之神"},
		"2026年世界杯":             nil,
		"  ":                   nil,
		"Westworld":            nil,
	}
	for in, want := range cases {
		if got := titleVariants(in); !reflect.DeepEqual(got, want) {
			t.Errorf("titleVariants(%q) = %v, want %v", in, got, want)
		}
	}
	// phrase-aware pinyin: 重庆 -> chong qing, 长征 -> chang zheng, 银行 -> yin hang
	for in, want := range map[string]string{"重庆": "chongqing", "伟大的长征": "weidadechangzheng", "银行": "yinhang", "兰香如故": "lanxiangrugu",
		"令人心动的offer 第八季": "lingrenxindongdedibaji", "脱口秀和Ta的朋友们": "tuokouxiuhedepengyoumen", "血战X": "xuezhan",
		"重整家族荣耀": "zhongzhengjiazurongyao", "你为什么要爬山？": "niweishenmeyaopashan", "百分之十(电影版)": "baifenzhishidianyingban"} {
		if got := strings.Join(syllables(in), ""); got != want {
			t.Errorf("syllables(%q) = %q, want %q", in, got, want)
		}
	}
	_, srv, _ := testApp(t)
	_, h, b := get(t, srv.URL+"/titles", nil)
	var idx TitleIndex
	decode(t, b, &idx)
	if h.Get("Cache-Control") != "public, max-age=600" {
		t.Fatalf("titles cache header: %v", h)
	}
	// records (weight 3) + history + lists all indexed; non-CJK-leading history entry dropped
	if idx.Full["liulangdiqiu"] == nil || idx.Initials["lldq"] == nil || idx.Count == 0 {
		t.Fatalf("titles index: %s", b)
	}
	for k := range idx.Full {
		if !isAlpha(k) {
			t.Fatalf("non a-z key %q", k)
		}
	}
}

func TestDetailPassthroughAndValidation(t *testing.T) {
	_, srv, _ := testApp(t)
	st, _, _ := get(t, srv.URL+"/detail?source=a", nil)
	if st != 400 {
		t.Fatalf("validation: %d", st)
	}
	st, _, b := get(t, srv.URL+"/detail?source=a&id=42", nil)
	if st != 200 || !strings.Contains(string(b), `"id":"42"`) {
		t.Fatalf("detail: %d %s", st, b)
	}
}

func TestUpstreamDownMapsTo502Or500(t *testing.T) {
	up, _ := fakeMoonTV(t)
	cfg := Config{Upstream: up.URL, User: "moontv1", Pass: "moontv1", CacheDir: t.TempDir()}
	app := newApp(cfg)
	srv := httptest.NewServer(app.routes())
	defer srv.Close()
	up.Close() // MoonTV goes away
	st, _, b := get(t, srv.URL+"/home", nil)
	if st != 500 && st != 502 {
		t.Fatalf("expected 5xx when upstream is down, got %d %s", st, b)
	}
	if !strings.Contains(string(b), `"error"`) {
		t.Fatalf("error body: %s", b)
	}
}

func del(t *testing.T, url string, hdr map[string]string) (int, []byte) {
	t.Helper()
	req, _ := http.NewRequest("DELETE", url, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var sb strings.Builder
	b := make([]byte, 1<<16)
	for {
		n, err := resp.Body.Read(b)
		sb.Write(b[:n])
		if err != nil {
			break
		}
	}
	return resp.StatusCode, []byte(sb.String())
}

func TestAdvancedFiltersMirrorWeb(t *testing.T) {
	_, srv, _ := testApp(t)
	st, _, _ := get(t, srv.URL+"/filters/advanced?type=anime", nil)
	if st != 400 {
		t.Fatalf("anime has no advanced filters on the web: %d", st)
	}
	_, _, b := get(t, srv.URL+"/filters/advanced?type=tv", nil)
	var groups []advGroup
	decode(t, b, &groups)
	keys := []string{}
	for _, g := range groups {
		keys = append(keys, g.Key)
	}
	if strings.Join(keys, ",") != "sort,category,region,year,platform" {
		t.Fatalf("tv groups: %v", keys)
	}
	_, _, b = get(t, srv.URL+"/filters/advanced?type=movie", nil)
	decode(t, b, &groups)
	if len(groups) != 4 || groups[0].Options[1] != "近期热度" {
		t.Fatalf("movie groups: %s", b)
	}
	// request shape == what the web sends for the same dropdown choices
	cases := map[string]string{
		"/list/advanced?type=movie": "rec:movie/all/",
		"/list/advanced?type=movie&sort=近期热度&category=喜剧&region=华语&year=2020年代": "rec:movie/喜剧/",
		"/list/advanced?type=tv&platform=Netflix":                               "rec:tv/all/电视剧",
		"/list/advanced?type=show&sort=高分优先":                                    "rec:tv/all/综艺",
	}
	var items []Item
	for path, want := range cases {
		_, _, b = get(t, srv.URL+path, nil)
		decode(t, b, &items)
		if len(items) == 0 || items[0].Title != want {
			t.Errorf("%s -> %s want %s", path, b, want)
		}
	}
	if got := advancedListPath("movie", map[string]string{"sort": "近期热度", "category": "喜剧", "region": "华语", "year": "2020年代"}, 0, 25); !strings.Contains(got, "sort=U") || !strings.Contains(got, "category="+q("喜剧")) || !strings.Contains(got, "year="+q("2020年代")) || !strings.Contains(got, "platform=all") {
		t.Fatalf("recommends path: %s", got)
	}
	if got := advancedListPath("tv", map[string]string{"sort": "高分优先"}, 25, 25); !strings.Contains(got, "sort=S") || !strings.Contains(got, "format="+q("电视剧")) || !strings.Contains(got, "start=25") {
		t.Fatalf("tv recommends path: %s", got)
	}
}

func TestFavoritesCRUDPerUser(t *testing.T) {
	_, srv, c := testApp(t)
	_, b := post(t, srv.URL+"/login", `{"username":"moontv2","password":"moontv2"}`, nil)
	var lg struct{ Session string }
	decode(t, b, &lg)
	hdr := map[string]string{"X-Session": lg.Session}

	_, _, b = get(t, srv.URL+"/favorites", hdr)
	var favs []Fav
	decode(t, b, &favs)
	if len(favs) != 2 || favs[0].Key != "a+1" || favs[0].Title != "moontv2 收藏" || favs[0].Source != "a" || favs[0].TotalEpisodes != float64(12) {
		t.Fatalf("favorites: %s", b)
	}
	st, b := post(t, srv.URL+"/favorites", `{"key":"x+9","favorite":{"title":"T","cover":"c"}}`, hdr)
	if st != 200 || c.lastBody["key"] != "x+9" || c.lastBody["favorite"].(map[string]interface{})["save_time"] == nil {
		t.Fatalf("add favorite: %d %s body=%v", st, b, c.lastBody)
	}
	st, _ = del(t, srv.URL+"/favorites?key=x%2B9", hdr)
	if st != 200 || c.lastMethodPath != "DELETE /api/favorites?key=x%2B9" {
		t.Fatalf("delete favorite: %d %s", st, c.lastMethodPath)
	}
	st, _ = del(t, srv.URL+"/favorites", hdr)
	if st != 200 || c.lastMethodPath != "DELETE /api/favorites" {
		t.Fatalf("clear favorites: %d %s", st, c.lastMethodPath)
	}
	st, _ = post(t, srv.URL+"/favorites", `{"key":"x+9"}`, hdr)
	if st != 400 {
		t.Fatalf("validation: %d", st)
	}
	st, _, _ = get(t, srv.URL+"/favorites", map[string]string{"X-Session": "bad"})
	if st != 401 {
		t.Fatalf("bad session: %d", st)
	}
}

func TestSkipConfigs(t *testing.T) {
	_, srv, c := testApp(t)
	_, _, b := get(t, srv.URL+"/skip?key=ruyi%2B86003", nil)
	var cfg struct {
		Enable bool    `json:"enable"`
		Intro  float64 `json:"intro_time"`
		Outro  float64 `json:"outro_time"`
	}
	decode(t, b, &cfg)
	if !cfg.Enable || cfg.Intro != 90 || cfg.Outro != 120 {
		t.Fatalf("skip get: %s", b)
	}
	_, _, b = get(t, srv.URL+"/skip?key=none%2B0", nil)
	if string(b) != "{}" {
		t.Fatalf("missing key should be {}: %s", b)
	}
	st, _ := post(t, srv.URL+"/skip", `{"key":"ruyi+86003","config":{"enable":true,"intro_time":95,"outro_time":0}}`, nil)
	if st != 200 || c.lastBody["key"] != "ruyi+86003" || c.lastBody["config"].(map[string]interface{})["intro_time"] != float64(95) {
		t.Fatalf("skip post: %d %v", st, c.lastBody)
	}
	st, _ = del(t, srv.URL+"/skip?key=ruyi%2B86003", nil)
	if st != 200 || c.lastMethodPath != "DELETE /api/skipconfigs?key=ruyi%2B86003" {
		t.Fatalf("skip delete: %d %s", st, c.lastMethodPath)
	}
	st, _ = del(t, srv.URL+"/skip", nil)
	if st != 400 {
		t.Fatalf("skip delete needs key: %d", st)
	}
}

func TestRecordDeleteAndClear(t *testing.T) {
	_, srv, c := testApp(t)
	st, _ := del(t, srv.URL+"/record?key=src%2B1", nil)
	if st != 200 || c.lastMethodPath != "DELETE /api/playrecords?key=src%2B1" {
		t.Fatalf("delete one: %d %s", st, c.lastMethodPath)
	}
	st, _ = del(t, srv.URL+"/record", nil)
	if st != 200 || c.lastMethodPath != "DELETE /api/playrecords" {
		t.Fatalf("clear all: %d %s", st, c.lastMethodPath)
	}
}

func TestBangumiAndHomeRows(t *testing.T) {
	_, srv, _ := testApp(t)
	_, h, b := get(t, srv.URL+"/bangumi", nil)
	var items []BangumiItem
	decode(t, b, &items)
	if len(items) != 2 || h.Get("Cache-Control") != "public, max-age=600" {
		t.Fatalf("bangumi: %s %v", b, h)
	}
	for _, it := range items {
		if it.Title == "" || it.Day == "" {
			t.Fatalf("bangumi item missing title/day: %+v", it)
		}
		if it.Title == "周一番" && (it.Rate != "7.5" || it.Year != "2026" || it.Poster != "http://b/1.jpg") {
			t.Fatalf("bangumi fields: %+v", it)
		}
		if it.ID == float64(7) && it.Title != "sun" { // falls back to name when name_cn empty
			t.Fatalf("name fallback: %+v", it)
		}
	}
	_, _, b = get(t, srv.URL+"/home", nil)
	s := string(b)
	order := []string{`"user"`, `"continue"`, `"favorites"`, `"movie"`, `"tv"`, `"bangumi"`, `"anime"`, `"show"`}
	for i := 1; i < len(order); i++ {
		if strings.Index(s, order[i-1]) > strings.Index(s, order[i]) {
			t.Fatalf("home key order: %v", order)
		}
	}
	var home struct {
		Favorites []Fav         `json:"favorites"`
		Bangumi   []BangumiItem `json:"bangumi"`
	}
	decode(t, b, &home)
	if len(home.Favorites) != 2 || len(home.Bangumi) != 2 {
		t.Fatalf("home rows: favs=%d bangumi=%d", len(home.Favorites), len(home.Bangumi))
	}
}
