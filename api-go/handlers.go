package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// App bundles the shared state used by handlers.
type App struct {
	cfg       Config
	defaultUp *Upstream
	sessions  *Sessions
	mem       *memCache
	posters   *posterCache
	remote    *Remote
}

func newApp(cfg Config) *App {
	return &App{
		cfg:       cfg,
		defaultUp: newUpstream(cfg.Upstream, cfg.User, cfg.Pass),
		sessions:  newSessions(cfg.Upstream),
		mem:       newMemCache(),
		posters:   &posterCache{dir: cfg.CacheDir, ttl: posterTTL},
		remote:    newRemote(),
	}
}

// ---------------------------------------------------------------- response helpers

func cors(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type, X-Session")
}

// send writes a response like the Python bridge: CORS, optional gzip for >1 KB JSON/text,
// optional Cache-Control, explicit Content-Length, no body for HEAD.
func send(w http.ResponseWriter, r *http.Request, status int, data []byte, ctype string, cacheSec int) {
	if ctype == "" {
		ctype = "application/json; charset=utf-8"
	}
	cors(w)
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") && len(data) > 1024 &&
		(strings.HasPrefix(ctype, "application/json") || strings.HasPrefix(ctype, "text/")) {
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, 5)
		zw.Write(data)
		zw.Close()
		data = buf.Bytes()
		w.Header().Set("Content-Encoding", "gzip")
	}
	w.Header().Set("Content-Type", ctype)
	if cacheSec > 0 {
		w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d", cacheSec))
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		w.Write(data)
	}
}

// marshal matches Python's json.dumps(ensure_ascii=False) closely enough for the TV: no HTML escaping.
func marshal(v interface{}) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
	return bytes.TrimRight(buf.Bytes(), "\n")
}

func sendJSON(w http.ResponseWriter, r *http.Request, status int, v interface{}, cacheSec int) {
	send(w, r, status, marshal(v), "", cacheSec)
}

func sendError(w http.ResponseWriter, r *http.Request, status int, msg string) {
	sendJSON(w, r, status, map[string]string{"error": msg}, 0)
}

// fail maps errors to the same status codes as the Python bridge.
func fail(w http.ResponseWriter, r *http.Request, err error) {
	var ae *AuthError
	var he *httpError
	switch {
	case errors.As(err, &ae):
		sendError(w, r, 401, ae.Error())
	case errors.As(err, &he):
		log.Printf("upstream HTTP %d for %s", he.Status, r.URL.Path)
		sendError(w, r, 502, fmt.Sprintf("upstream HTTP %d", he.Status))
	default:
		log.Printf("error on %s: %v", r.URL.Path, err)
		sendError(w, r, 500, err.Error())
	}
}

// session resolves the Upstream for a request: X-Session header or ?session=, else default.
func (a *App) session(r *http.Request) (*Upstream, error) {
	tk := r.Header.Get("X-Session")
	if tk == "" {
		tk = r.URL.Query().Get("session")
	}
	up := a.sessions.get(tk, a.defaultUp)
	if up == nil {
		return nil, &AuthError{"session expired"}
	}
	return up, nil
}

func readJSONBody(r *http.Request) (map[string]interface{}, error) {
	data, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return map[string]interface{}{}, nil
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		// Python accepts a bare list for /probe; handle in the route via rawBody
		return nil, err
	}
	return m, nil
}

func atoi(s string, d int) int {
	if s == "" {
		return d
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return d
	}
	return n
}

func str(v interface{}) string {
	s, _ := v.(string)
	return s
}

// ---------------------------------------------------------------- routing

func (a *App) routes() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.cfg.Verbose {
			log.Printf("%s %s", r.Method, r.URL.RequestURI())
		}
		p := strings.TrimRight(r.URL.Path, "/")
		if p == "" {
			p = "/"
		}
		switch r.Method {
		case http.MethodOptions:
			cors(w)
			w.Header().Set("Content-Length", "0")
			w.WriteHeader(204)
		case http.MethodGet, http.MethodHead:
			a.handleGet(w, r, p)
		case http.MethodPost:
			a.handlePost(w, r, p)
		default:
			sendError(w, r, 405, "method not allowed")
		}
	})
}

func (a *App) handleGet(w http.ResponseWriter, r *http.Request, p string) {
	g := r.URL.Query().Get
	switch {
	case p == "/" && a.cfg.SimFile != "":
		cors(w)
		w.Header().Set("Location", "/sim")
		w.Header().Set("Content-Length", "0")
		w.WriteHeader(302)
	case p == "/sim" && a.cfg.SimFile != "":
		a.serveSim(w, r)
	case p == "/tv" || strings.HasPrefix(p, "/tv/"):
		a.serveApp(w, r, strings.TrimPrefix(p, "/tv"))
	case p == "/health":
		sendJSON(w, r, 200, map[string]interface{}{"ok": true, "upstream": a.cfg.Upstream, "app": a.cfg.AppDir != "", "sim": a.cfg.SimFile != ""}, 0)
	case strings.HasPrefix(p, "/r/"):
		a.servePhonePage(w, r, p[3:])
	case strings.HasPrefix(p, "/remote/"):
		a.remoteGet(w, r, p)
	case p == "/seed-accounts":
		out := make([]map[string]string, 0, len(a.cfg.SeedAccounts))
		for _, s := range a.cfg.SeedAccounts {
			out = append(out, map[string]string{"username": s[0], "password": s[1]})
		}
		sendJSON(w, r, 200, out, 0)
	case p == "/me":
		up, err := a.session(r)
		if err != nil {
			fail(w, r, err)
			return
		}
		sendJSON(w, r, 200, map[string]interface{}{"username": up.Username, "default": up == a.defaultUp}, 0)
	case p == "/home":
		a.handleHome(w, r)
	case p == "/filters":
		send(w, r, 200, filtersJSON(), "", 3600)
	case p == "/titles":
		v, err := a.mem.get("titles", titlesTTL, func() (interface{}, error) { return a.buildTitles() })
		if err != nil {
			fail(w, r, err)
			return
		}
		sendJSON(w, r, 200, v, 600)
	case p == "/list":
		kind := g("type")
		if kind == "" {
			kind = "movie"
		}
		if _, ok := filters[kind]; !ok {
			sendError(w, r, 400, "bad type")
			return
		}
		items, err := a.doubanList(kind, g("tag"), g("region"), atoi(g("start"), 0), atoi(g("size"), 24))
		if err != nil {
			fail(w, r, err)
			return
		}
		sendJSON(w, r, 200, items, 0)
	case p == "/search":
		query := strings.TrimSpace(g("q"))
		if query == "" {
			sendJSON(w, r, 200, []interface{}{}, 0)
			return
		}
		groups, err := a.search(query)
		if err != nil {
			fail(w, r, err)
			return
		}
		sendJSON(w, r, 200, groups, 0)
	case p == "/detail":
		src, vid := g("source"), g("id")
		if src == "" || vid == "" {
			sendError(w, r, 400, "source and id required")
			return
		}
		data, _, err := a.defaultUp.call("GET", fmt.Sprintf("/api/detail?source=%s&id=%s", q(src), q(vid)), nil, 60*time.Second)
		if err != nil {
			fail(w, r, err)
			return
		}
		send(w, r, 200, data, "", 0)
	case p == "/record":
		up, err := a.session(r)
		if err != nil {
			fail(w, r, err)
			return
		}
		recs, err := continueWatching(up, 200)
		if err != nil {
			fail(w, r, err)
			return
		}
		sendJSON(w, r, 200, recs, 0)
	case p == "/probe":
		u := g("url")
		if u == "" {
			sendError(w, r, 400, "url required")
			return
		}
		res := a.probeMany([]map[string]interface{}{{"url": u}}, false)
		sendJSON(w, r, 200, res[0], 0)
	case p == "/poster":
		u := g("url")
		if u == "" {
			sendError(w, r, 400, "url required")
			return
		}
		data, ctype, err := a.poster(u)
		if err != nil {
			fail(w, r, err)
			return
		}
		send(w, r, 200, data, ctype, int(posterTTL.Seconds()))
	default:
		sendError(w, r, 404, "not found")
	}
}

func (a *App) handleHome(w http.ResponseWriter, r *http.Request) {
	up, err := a.session(r)
	if err != nil {
		fail(w, r, err)
		return
	}
	cont, err := continueWatching(up, 20)
	if err != nil {
		fail(w, r, err)
		return
	}
	rows := map[string][]Item{}
	for _, s := range []struct{ key, kind, tag, region string }{
		{"movie", "movie", "热门", "全部"}, {"tv", "tv", "全部", ""}, {"anime", "anime", "动画", ""}, {"show", "show", "综艺", ""},
	} {
		items, err := a.doubanList(s.kind, s.tag, s.region, 0, 20)
		if err != nil {
			fail(w, r, err)
			return
		}
		rows[s.key] = items
	}
	// fixed key order to match the Python output
	var b bytes.Buffer
	b.WriteString(`{"user": `)
	b.Write(marshal(up.Username))
	b.WriteString(`, "continue": `)
	b.Write(marshal(cont))
	for _, k := range []string{"movie", "tv", "anime", "show"} {
		fmt.Fprintf(&b, `, %q: `, k)
		b.Write(marshal(rows[k]))
	}
	b.WriteString("}")
	send(w, r, 200, b.Bytes(), "", 0)
}

func (a *App) poster(u string) ([]byte, string, error) {
	if data, ctype, ok := a.posters.get(u); ok {
		return data, ctype, nil
	}
	data, ctype, err := a.defaultUp.call("GET", "/api/image-proxy?url="+q(u), nil, 30*time.Second)
	if err != nil {
		return nil, "", err
	}
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	a.posters.put(u, ctype, data)
	return data, ctype, nil
}

func (a *App) handlePost(w http.ResponseWriter, r *http.Request, p string) {
	raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	var body map[string]interface{}
	var bodyList []interface{}
	if len(bytes.TrimSpace(raw)) == 0 {
		body = map[string]interface{}{}
	} else if err := json.Unmarshal(raw, &body); err != nil {
		if err2 := json.Unmarshal(raw, &bodyList); err2 != nil {
			sendError(w, r, 400, "invalid json")
			return
		}
		body = map[string]interface{}{}
	}
	switch {
	case p == "/remote/new":
		a.remoteNew(w, r, body)
	case strings.HasPrefix(p, "/remote/"):
		a.remotePost(w, r, p, body)
	case p == "/login":
		user, pw := strings.TrimSpace(str(body["username"])), str(body["password"])
		if user == "" || pw == "" {
			sendError(w, r, 400, "username and password required")
			return
		}
		tk, err := a.sessions.login(user, pw)
		if err != nil {
			log.Printf("login failed for %s: %v", user, err)
			sendError(w, r, 401, "login failed")
			return
		}
		sendJSON(w, r, 200, map[string]interface{}{"ok": true, "session": tk, "username": user}, 0)
	case p == "/logout":
		tk := r.Header.Get("X-Session")
		if tk == "" {
			tk = str(body["session"])
		}
		a.sessions.logout(tk)
		sendJSON(w, r, 200, map[string]bool{"ok": true}, 0)
	case p == "/probe":
		var items []interface{}
		if bodyList != nil {
			items = bodyList
		} else {
			items, _ = body["items"].([]interface{})
		}
		if len(items) == 0 {
			sendError(w, r, 400, "items[] required")
			return
		}
		if len(items) > 40 {
			items = items[:40]
		}
		maps := make([]map[string]interface{}, 0, len(items))
		for _, it := range items {
			if m, ok := it.(map[string]interface{}); ok {
				maps = append(maps, m)
			}
		}
		fresh, _ := body["fresh"].(bool)
		sendJSON(w, r, 200, a.probeMany(maps, fresh), 0)
	case p == "/record":
		key := str(body["key"])
		rec, ok := body["record"].(map[string]interface{})
		if key == "" || !ok {
			sendError(w, r, 400, "key and record required")
			return
		}
		if _, has := rec["save_time"]; !has {
			rec["save_time"] = time.Now().UnixMilli()
		}
		up, err := a.session(r)
		if err != nil {
			fail(w, r, err)
			return
		}
		if err := up.callJSON("POST", "/api/playrecords", map[string]interface{}{"key": key, "record": rec}, 60*time.Second, nil); err != nil {
			fail(w, r, err)
			return
		}
		sendJSON(w, r, 200, map[string]bool{"ok": true}, 0)
	default:
		sendError(w, r, 404, "not found")
	}
}
