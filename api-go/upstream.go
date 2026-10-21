package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// httpClient is shared; no redirect following is needed for the MoonTV API.
var httpClient = &http.Client{Timeout: 90 * time.Second}

// Upstream is one MoonTV login (cookie) for one set of credentials.
type Upstream struct {
	base     string
	Username string
	password string

	mu     sync.Mutex
	cookie_ string
	at     time.Time
}

func newUpstream(base, user, pass string) *Upstream {
	return &Upstream{base: base, Username: user, password: pass}
}

type httpError struct {
	Status int
	Body   []byte
}

func (e *httpError) Error() string { return fmt.Sprintf("upstream HTTP %d", e.Status) }

func (u *Upstream) login() (string, error) {
	body, _ := json.Marshal(map[string]string{"username": u.Username, "password": u.password})
	req, _ := http.NewRequest("POST", u.base+"/api/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != 200 {
		return "", &httpError{Status: resp.StatusCode}
	}
	for _, c := range resp.Cookies() {
		if c.Name == "auth" {
			log.Printf("login ok (%s)", u.Username)
			return "auth=" + c.Value, nil
		}
	}
	// Go's cookie parser may drop values with URL-encoded characters it dislikes; fall back to raw header.
	for _, h := range resp.Header.Values("Set-Cookie") {
		if kv := strings.SplitN(h, ";", 2)[0]; strings.HasPrefix(strings.TrimSpace(kv), "auth=") {
			log.Printf("login ok (%s)", u.Username)
			return strings.TrimSpace(kv), nil
		}
	}
	return "", errors.New("login response had no auth cookie")
}

// cookie returns the cached cookie, logging in on first use or when force is set
// (but not more than once every 2 s under concurrent 401s).
func (u *Upstream) cookie(force bool) (string, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.cookie_ != "" && !force {
		return u.cookie_, nil
	}
	if force && u.cookie_ != "" && time.Since(u.at) < 2*time.Second {
		return u.cookie_, nil
	}
	c, err := u.login()
	if err != nil {
		return "", err
	}
	u.cookie_ = c
	u.at = time.Now()
	return c, nil
}

// call performs an authenticated request against MoonTV and retries once after a 401.
// Returns the raw body and content type; callers decode JSON as needed.
func (u *Upstream) call(method, path string, body []byte, timeout time.Duration) ([]byte, string, error) {
	for attempt := 0; attempt < 2; attempt++ {
		ck, err := u.cookie(attempt == 1)
		if err != nil {
			return nil, "", err
		}
		var rdr io.Reader
		if body != nil {
			rdr = bytes.NewReader(body)
		}
		req, err := http.NewRequest(method, u.base+path, rdr)
		if err != nil {
			return nil, "", err
		}
		req.Header.Set("Cookie", ck)
		req.Header.Set("Accept-Encoding", "identity")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		client := httpClient
		if timeout > 0 {
			client = &http.Client{Timeout: timeout}
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, "", err
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == 401 && attempt == 0 {
			log.Printf("401 on %s, re-login", path)
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, "", &httpError{Status: resp.StatusCode, Body: data}
		}
		return data, resp.Header.Get("Content-Type"), nil
	}
	return nil, "", errors.New("unreachable")
}

// callJSON decodes the response into v (v may be nil to discard).
func (u *Upstream) callJSON(method, path string, body interface{}, timeout time.Duration, v interface{}) error {
	var b []byte
	if body != nil {
		b, _ = json.Marshal(body)
	}
	data, _, err := u.call(method, path, b, timeout)
	if err != nil {
		return err
	}
	if v == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, v)
}

// ---------------------------------------------------------------- sessions

type AuthError struct{ msg string }

func (e *AuthError) Error() string { return e.msg }

// Sessions holds opaque tokens for TVs logged in as another MoonTV user. In memory only:
// a restart logs everyone out and the app re-logs in silently with its stored credentials.
type Sessions struct {
	base string
	mu   sync.Mutex
	byTk map[string]*Upstream
}

func newSessions(base string) *Sessions { return &Sessions{base: base, byTk: map[string]*Upstream{}} }

func (s *Sessions) login(user, pass string) (string, error) {
	up := newUpstream(s.base, user, pass)
	if _, err := up.cookie(true); err != nil {
		var he *httpError
		if errors.As(err, &he) {
			return "", &AuthError{fmt.Sprintf("HTTP %d", he.Status)}
		}
		return "", &AuthError{err.Error()}
	}
	b := make([]byte, 32)
	rand.Read(b)
	tk := hex.EncodeToString(b)
	s.mu.Lock()
	s.byTk[tk] = up
	s.mu.Unlock()
	return tk, nil
}

// get returns the upstream for a token; nil token means the default account (returned as def).
// Unknown token returns nil.
func (s *Sessions) get(token string, def *Upstream) *Upstream {
	if token == "" {
		return def
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.byTk[token]
}

func (s *Sessions) logout(token string) {
	s.mu.Lock()
	delete(s.byTk, token)
	s.mu.Unlock()
}
