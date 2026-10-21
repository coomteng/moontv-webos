package main

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// memCache is a tiny TTL cache with single-flight per key (one fill at a time per key).
type memCache struct {
	mu    sync.Mutex
	items map[string]memItem
	fills map[string]*sync.Mutex
}

type memItem struct {
	at  time.Time
	val interface{}
}

func newMemCache() *memCache {
	return &memCache{items: map[string]memItem{}, fills: map[string]*sync.Mutex{}}
}

// get returns the cached value or calls fn to fill it. Errors are not cached.
func (c *memCache) get(key string, ttl time.Duration, fn func() (interface{}, error)) (interface{}, error) {
	c.mu.Lock()
	if it, ok := c.items[key]; ok && time.Since(it.at) < ttl {
		c.mu.Unlock()
		return it.val, nil
	}
	fm, ok := c.fills[key]
	if !ok {
		fm = &sync.Mutex{}
		c.fills[key] = fm
	}
	c.mu.Unlock()

	fm.Lock()
	defer fm.Unlock()
	c.mu.Lock()
	if it, ok := c.items[key]; ok && time.Since(it.at) < ttl { // filled while we waited
		c.mu.Unlock()
		return it.val, nil
	}
	c.mu.Unlock()
	v, err := fn()
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.items[key] = memItem{at: time.Now(), val: v}
	c.mu.Unlock()
	return v, nil
}

func (c *memCache) delete(key string) {
	c.mu.Lock()
	delete(c.items, key)
	c.mu.Unlock()
}

// posterCache stores poster bytes on disk. File format is shared with the Python bridge:
// first line = content type, rest = body, name = sha1(url).
type posterCache struct {
	dir string
	ttl time.Duration
}

func sha1hex(s string) string {
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}

func (p *posterCache) path(url string) string { return filepath.Join(p.dir, sha1hex(url)) }

func (p *posterCache) get(url string) ([]byte, string, bool) {
	f := p.path(url)
	st, err := os.Stat(f)
	if err != nil || time.Since(st.ModTime()) > p.ttl {
		return nil, "", false
	}
	data, err := os.ReadFile(f)
	if err != nil {
		return nil, "", false
	}
	r := bufio.NewReader(bytes.NewReader(data))
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, "", false
	}
	rest, _ := readAllFrom(r)
	return rest, strings.TrimSpace(line), true
}

func readAllFrom(r *bufio.Reader) ([]byte, error) {
	var buf bytes.Buffer
	_, err := buf.ReadFrom(r)
	return buf.Bytes(), err
}

func (p *posterCache) put(url, ctype string, data []byte) {
	if err := os.MkdirAll(p.dir, 0o755); err != nil {
		return
	}
	f := p.path(url)
	tmp := f + ".tmp"
	out := make([]byte, 0, len(ctype)+1+len(data))
	out = append(out, ctype...)
	out = append(out, '\n')
	out = append(out, data...)
	if err := os.WriteFile(tmp, out, 0o644); err == nil {
		os.Rename(tmp, f)
	}
}
