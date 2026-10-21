package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// staticApp builds an app dir + sim file in a temp root and returns the server and the root.
func staticApp(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	root := t.TempDir()
	app := filepath.Join(root, "app")
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(app, "js"), 0o755))
	must(os.MkdirAll(filepath.Join(app, "css"), 0o755))
	must(os.MkdirAll(filepath.Join(app, "empty"), 0o755))
	must(os.WriteFile(filepath.Join(app, "index.html"), []byte("<html>app</html>"), 0o644))
	must(os.WriteFile(filepath.Join(app, "js", "a.js"), []byte("var a=1;"), 0o644))
	must(os.WriteFile(filepath.Join(app, "css", "s.css"), []byte("b{}"), 0o644))
	must(os.WriteFile(filepath.Join(app, "data.json"), []byte(`{"k":1}`), 0o644))
	must(os.WriteFile(filepath.Join(app, "logo.png"), []byte{0x89, 'P', 'N', 'G'}, 0o644))
	must(os.WriteFile(filepath.Join(app, "blob.unknownext"), []byte("?"), 0o644))
	must(os.WriteFile(filepath.Join(app, "notes.txt"), []byte("hi"), 0o644))
	must(os.WriteFile(filepath.Join(root, "secret.txt"), []byte("TOP"), 0o644))
	must(os.WriteFile(filepath.Join(root, "sim.html"), []byte("<html>sim</html>"), 0o644))
	// symlink escaping the root must be refused too (realpath semantics)
	if err := os.Symlink(filepath.Join(root, "secret.txt"), filepath.Join(app, "leak.txt")); err != nil {
		t.Logf("symlink not supported: %v", err)
	}
	a := newApp(Config{Upstream: "http://127.0.0.1:9", User: "u", Pass: "p", CacheDir: filepath.Join(root, "cache"),
		AppDir: app, SimFile: filepath.Join(root, "sim.html"), Port: "8788"})
	srv := httptest.NewServer(a.routes())
	t.Cleanup(srv.Close)
	return srv, root
}

// rawGet sends the path bytes untouched (no client-side ".." normalisation).
func rawGet(t *testing.T, srv *httptest.Server, path string) (int, http.Header, string) {
	t.Helper()
	req, err := http.NewRequest("GET", srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.URL.Opaque = path
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return resp.StatusCode, resp.Header, sb.String()
}

func TestStaticAppServesFilesAndIndex(t *testing.T) {
	srv, _ := staticApp(t)
	for _, c := range []struct{ path, ctype, body string }{
		{"/tv", "text/html; charset=utf-8", "<html>app</html>"},
		{"/tv/", "text/html; charset=utf-8", "<html>app</html>"},
		{"/tv/index.html", "text/html; charset=utf-8", "<html>app</html>"},
		{"/tv/js/a.js", "text/javascript; charset=utf-8", "var a=1;"},
		{"/tv/css/s.css", "text/css; charset=utf-8", "b{}"},
		{"/tv/data.json", "application/json; charset=utf-8", `{"k":1}`},
		{"/tv/notes.txt", "text/plain; charset=utf-8", "hi"},
		{"/tv/logo.png", "image/png", "\x89PNG"},
		{"/tv/blob.unknownext", "application/octet-stream", "?"},
	} {
		st, h, body := rawGet(t, srv, c.path)
		if st != 200 || h.Get("Content-Type") != c.ctype || body != c.body {
			t.Errorf("%s: %d %q %q", c.path, st, h.Get("Content-Type"), body)
		}
		if h.Get("Cache-Control") != "no-cache" || h.Get("Access-Control-Allow-Origin") != "*" {
			t.Errorf("%s: headers %v", c.path, h)
		}
		if h.Get("Content-Length") == "" {
			t.Errorf("%s: no Content-Length", c.path)
		}
	}
	// HEAD: headers only
	req, _ := http.NewRequest("HEAD", srv.URL+"/tv/js/a.js", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Length") != "8" {
		t.Errorf("HEAD: %d %v", resp.StatusCode, resp.Header)
	}
	// directory without index.html and missing files -> 404 JSON
	for _, p := range []string{"/tv/empty", "/tv/empty/", "/tv/nope.js", "/tv/js", "/tv/js/"} {
		st, h, body := rawGet(t, srv, p)
		if st != 404 || strings.TrimSpace(body) != `{"error":"not found"}` || !strings.HasPrefix(h.Get("Content-Type"), "application/json") {
			t.Errorf("%s: %d %q", p, st, body)
		}
	}
}

func TestStaticTraversalIsRefused(t *testing.T) {
	srv, root := staticApp(t)
	for _, p := range []string{
		"/tv/../secret.txt",
		"/tv/../sim.html",
		"/tv/../go.mod",
		"/tv/js/../../secret.txt",
		"/tv/%2e%2e/secret.txt",
		"/tv/..%2fsecret.txt",
		"/tv/%2e%2e%2fsecret.txt",
		"/tv/....//secret.txt",
		"/tv//../secret.txt",
		"/tv/./../secret.txt",
		"/tv/" + strings.Repeat("../", 12) + "etc/passwd",
		"/tv/leak.txt", // symlink pointing outside the root
	} {
		st, _, body := rawGet(t, srv, p)
		if st != 404 || strings.Contains(body, "TOP") || strings.Contains(body, "sim") {
			t.Errorf("%s: %d %q (should be 404 not found)", p, st, body)
		}
	}
	// direct unit check on the guard, including the "/tv/../go.mod" shape against a real module dir
	if _, _, ok := staticFile(filepath.Join(root, "app"), "/../go.mod"); ok {
		t.Error("staticFile served ../go.mod")
	}
	if _, _, ok := staticFile(filepath.Join(root, "app"), "/../secret.txt"); ok {
		t.Error("staticFile served ../secret.txt")
	}
	if _, _, ok := staticFile("", "/index.html"); ok {
		t.Error("empty root must serve nothing")
	}
	if data, ctype, ok := staticFile(filepath.Join(root, "app"), "/"); !ok || string(data) != "<html>app</html>" || ctype != "text/html; charset=utf-8" {
		t.Errorf("root index: %v %q %q", ok, data, ctype)
	}
	// app dir disabled -> everything under /tv is 404
	a := newApp(Config{Upstream: "http://127.0.0.1:9", User: "u", Pass: "p", CacheDir: t.TempDir()})
	s2 := httptest.NewServer(a.routes())
	defer s2.Close()
	st, _, body := rawGet(t, s2, "/tv/")
	if st != 404 || strings.TrimSpace(body) != `{"error":"not found"}` {
		t.Errorf("/tv without APP_DIR: %d %s", st, body)
	}
}

func TestSimAndRootRedirect(t *testing.T) {
	srv, root := staticApp(t)
	st, h, body := rawGet(t, srv, "/sim")
	if st != 200 || h.Get("Content-Type") != "text/html; charset=utf-8" || body != "<html>sim</html>" {
		t.Fatalf("/sim: %d %q %q", st, h.Get("Content-Type"), body)
	}
	st, h, _ = rawGet(t, srv, "/")
	if st != 302 || h.Get("Location") != "/sim" || h.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("/: %d %v", st, h)
	}
	// /health reflects app+sim flags
	st, _, body = rawGet(t, srv, "/health")
	if st != 200 || !strings.Contains(body, `"app":true`) || !strings.Contains(body, `"sim":true`) {
		t.Fatalf("/health: %d %s", st, body)
	}
	// sim file removed after start -> 404 (Python falls through to "not found")
	os.Remove(filepath.Join(root, "sim.html"))
	st, _, body = rawGet(t, srv, "/sim")
	if st != 404 || strings.TrimSpace(body) != `{"error":"not found"}` {
		t.Fatalf("/sim missing file: %d %s", st, body)
	}
}

func TestContentTypeFor(t *testing.T) {
	for ext, want := range map[string]string{
		"x.html": "text/html; charset=utf-8", "x.JS": "text/javascript; charset=utf-8",
		"x.mjs": "text/javascript; charset=utf-8", "x.json": "application/json; charset=utf-8",
		"x.css": "text/css; charset=utf-8", "x.svg": "image/svg+xml", "x.woff2": "font/woff2",
		"x.webp": "image/webp", "x.ico": "image/vnd.microsoft.icon", "x.bin": "application/octet-stream", "x": "application/octet-stream",
	} {
		if got := contentTypeFor(ext); got != want {
			t.Errorf("%s: %q want %q", ext, got, want)
		}
	}
}
