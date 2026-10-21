package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// --------------------------------------------------------------------------- stream probe
// Port of probe_stream & friends from api/moontv-api.py. Result keys/values match the Python
// bridge exactly (null for unknown values).

const (
	probeUA          = "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.34 Safari/537.36"
	probeSampleBytes = 1536 * 1024 // download up to 1.5 MB of the first segment for speed
	probeTimeout     = 8 * time.Second
	probeTTL         = 15 * time.Minute
	probeWorkers     = 8
)

// probeHTTPError mirrors urllib.error.HTTPError: a non-2xx/3xx status from the probed host.
type probeHTTPError struct{ code int }

func (e *probeHTTPError) Error() string { return fmt.Sprintf("HTTP %d", e.code) }

// probeClient follows redirects (like urllib). Timeouts are enforced per request through an
// idle timer that mimics Python's socket timeout: the request fails if no progress is made
// (dial, headers or a body read) within the timeout, not after a fixed total budget.
var probeClient = &http.Client{
	Transport: &http.Transport{
		Proxy:              http.ProxyFromEnvironment,
		MaxIdleConns:       32,
		IdleConnTimeout:    60 * time.Second,
		DisableCompression: true, // urllib sends no Accept-Encoding
	},
}

// idleReader resets a timer on every successful read so a stalled body cancels the request.
type idleReader struct {
	r       io.Reader
	timer   *time.Timer
	timeout time.Duration
}

func (i *idleReader) Read(p []byte) (int, error) {
	n, err := i.r.Read(p)
	if n > 0 {
		i.timer.Reset(i.timeout)
	}
	return n, err
}

// probeFetch GETs url; returns (bytes, first_byte_ms, total_ms, final_url).
// limit <= 0 reads the whole body; otherwise at most limit bytes.
func probeFetch(u string, limit int, timeout time.Duration) ([]byte, float64, float64, string, error) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timedOut := false
	timer := time.AfterFunc(timeout, func() { timedOut = true; cancel() })
	defer timer.Stop()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, 0, "", err
	}
	req.Header.Set("User-Agent", probeUA)
	req.Header.Set("Accept", "*/*")
	t0 := time.Now()
	resp, err := probeClient.Do(req)
	if err != nil {
		return nil, 0, 0, "", unwrapProbeErr(err, &timedOut)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, 0, 0, "", &probeHTTPError{resp.StatusCode}
	}
	body := &idleReader{r: resp.Body, timer: timer, timeout: timeout}
	first := make([]byte, 1)
	n, err := io.ReadFull(body, first)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return nil, 0, 0, "", unwrapProbeErr(err, &timedOut)
	}
	ttfb := float64(time.Since(t0)) / float64(time.Millisecond)
	var buf bytes.Buffer
	buf.Write(first[:n])
	if n > 0 {
		var rdr io.Reader = body
		if limit > 0 {
			rdr = io.LimitReader(body, int64(limit-1))
		}
		if _, err := buf.ReadFrom(rdr); err != nil {
			return nil, 0, 0, "", unwrapProbeErr(err, &timedOut)
		}
	}
	final := u
	if resp.Request != nil && resp.Request.URL != nil {
		final = resp.Request.URL.String()
	}
	return buf.Bytes(), ttfb, float64(time.Since(t0)) / float64(time.Millisecond), final, nil
}

// probeTimeoutError stands in for Python's socket timeout (TimeoutError: timed out).
type probeTimeoutError struct{}

func (probeTimeoutError) Error() string   { return "timed out" }
func (probeTimeoutError) Timeout() bool   { return true }
func (probeTimeoutError) Temporary() bool { return true }

func unwrapProbeErr(err error, timedOut *bool) error {
	if *timedOut || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return probeTimeoutError{}
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

type m3u8Variant struct {
	bandwidth  int
	resolution string // "" when absent (Python None)
	url        string
}

type m3u8Playlist struct {
	master   bool
	variants []m3u8Variant
	segments []string
	duration float64
}

var (
	reBandwidth  = regexp.MustCompile(`BANDWIDTH=(\d+)`)
	reResolution = regexp.MustCompile(`RESOLUTION=(\d+x\d+)`)
)

// urlJoin mirrors urllib.parse.urljoin for the cases a playlist produces.
func urlJoin(base, ref string) string {
	b, err := url.Parse(base)
	if err != nil {
		return ref
	}
	r, err := url.Parse(ref)
	if err != nil {
		return ref
	}
	return b.ResolveReference(r).String()
}

func parseM3U8(text, base string) m3u8Playlist {
	out := m3u8Playlist{variants: []m3u8Variant{}, segments: []string{}}
	var pending *m3u8Variant
	for _, raw := range strings.Split(text, "\n") {
		l := strings.TrimSpace(raw)
		if l == "" {
			continue
		}
		switch {
		case strings.HasPrefix(l, "#EXT-X-STREAM-INF"):
			out.master = true
			v := &m3u8Variant{}
			if m := reBandwidth.FindStringSubmatch(l); m != nil {
				v.bandwidth, _ = strconv.Atoi(m[1])
			}
			if m := reResolution.FindStringSubmatch(l); m != nil {
				v.resolution = m[1]
			}
			pending = v
		case strings.HasPrefix(l, "#EXTINF"):
			if len(l) >= 8 {
				d := strings.SplitN(l[8:], ",", 2)[0]
				if f, err := strconv.ParseFloat(strings.TrimSpace(d), 64); err == nil {
					out.duration += f
				}
			}
		case !strings.HasPrefix(l, "#"):
			u := urlJoin(base, l)
			if pending != nil {
				pending.url = u
				out.variants = append(out.variants, *pending)
				pending = nil
			} else {
				out.segments = append(out.segments, u)
			}
		}
	}
	return out
}

// probeResult is the ordered result row; nil pointers marshal to null like Python's None.
type probeResult struct {
	URL           string  `json:"url"`
	OK            bool    `json:"ok"`
	LatencyMs     *int    `json:"latency_ms"`
	SpeedKbps     *int    `json:"speed_kbps"`
	Resolution    *string `json:"resolution"`
	BandwidthKbps *int    `json:"bandwidth_kbps"`
	DurationS     *int    `json:"duration_s"`
	Segments      *int    `json:"segments"`
	Error         *string `json:"error"`
}

func intp(v int) *int       { return &v }
func strp(v string) *string { return &v }

// probeErrString formats a Go error the way Python's generic handler does:
// type name plus ": message". We cannot reproduce Python exception class names, so the
// closest stable equivalents are used for the common cases.
func probeErrString(err error) string {
	var he *probeHTTPError
	if errors.As(err, &he) {
		return he.Error()
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "TimeoutError: timed out"
	}
	return "URLError: " + err.Error()
}

// probeStream measures one HLS url. Never fails; the error field carries the reason.
func probeStream(u string) *probeResult {
	res := &probeResult{URL: u}
	body, ttfb, _, final, err := probeFetch(u, 0, probeTimeout)
	if err != nil {
		res.Error = strp(probeErrString(err))
		return res
	}
	res.LatencyMs = intp(int(ttfb))
	text := string(body)
	head := text
	if len(head) > 200 {
		head = head[:200]
	}
	if !strings.Contains(head, "#EXTM3U") {
		res.Error = strp("not an m3u8")
		return res
	}
	pl := parseM3U8(text, final)
	if pl.master && len(pl.variants) > 0 {
		best := pl.variants[0]
		for _, v := range pl.variants[1:] {
			if v.bandwidth > best.bandwidth {
				best = v
			}
		}
		if best.bandwidth != 0 {
			res.BandwidthKbps = intp(best.bandwidth / 1000)
		}
		if best.resolution != "" {
			res.Resolution = strp(best.resolution)
		}
		body2, _, _, final2, err := probeFetch(best.url, 0, probeTimeout)
		if err != nil {
			res.Error = strp(probeErrString(err))
			return res
		}
		pl = parseM3U8(string(body2), final2)
	}
	res.DurationS = intp(int(pl.duration))
	res.Segments = intp(len(pl.segments))
	if len(pl.segments) == 0 {
		res.Error = strp("empty playlist")
		return res
	}
	// speed: time a bounded read of the first segment (skip tiny ad/intro segments if possible)
	idx := 1
	if len(pl.segments)-1 < idx {
		idx = len(pl.segments) - 1
	}
	seg := pl.segments[idx]
	t0 := time.Now()
	data, _, _, _, err := probeFetch(seg, probeSampleBytes, probeTimeout+4*time.Second)
	if err != nil {
		res.Error = strp(probeErrString(err))
		return res
	}
	dt := time.Since(t0).Seconds()
	if dt < 0.001 {
		dt = 0.001
	}
	res.SpeedKbps = intp(int(float64(len(data)) * 8 / dt / 1000))
	res.OK = len(data) > 0
	if res.Resolution == nil && len(data) > 376 {
		if r := guessResolution(data); r != "" {
			res.Resolution = strp(r)
		}
	}
	return res
}

// bitReader reads an Exp-Golomb coded SPS. Reading past the end sets err (Python: IndexError).
type bitReader struct {
	data []byte
	pos  int
	err  bool
}

func (b *bitReader) bit() int {
	if b.pos >= len(b.data)*8 {
		b.err = true
		return 0
	}
	v := int(b.data[b.pos/8]>>(7-uint(b.pos%8))) & 1
	b.pos++
	return v
}

func (b *bitReader) skip(n int) { b.pos += n }

func (b *bitReader) peekPrev() int { // bit at pos-1
	if b.pos-1 < 0 || b.pos-1 >= len(b.data)*8 {
		b.err = true
		return 0
	}
	return int(b.data[(b.pos-1)/8]>>(7-uint((b.pos-1)%8))) & 1
}

func (b *bitReader) ue() int {
	z := 0
	for b.bit() == 0 {
		if b.err || z > 32 {
			b.err = true
			return 0
		}
		z++
	}
	v := 0
	for i := 0; i < z; i++ {
		v = v<<1 | b.bit()
	}
	return (1 << uint(z)) - 1 + v
}

func (b *bitReader) se() int {
	k := b.ue()
	if k%2 == 1 {
		return (k + 1) / 2
	}
	return -(k / 2)
}

var highProfiles = map[int]bool{100: true, 110: true, 122: true, 244: true, 44: true, 83: true, 86: true, 118: true, 128: true, 138: true, 139: true, 134: true, 135: true}

// guessResolution is a best-effort H.264 SPS scan in a TS sample to find coded width/height.
// Returns "WxH" or "" (Python None). Mirrors _guess_resolution step by step, including its
// crude emulation-prevention stripping (replace 00 00 03 -> 00 00 over a 64-byte window).
func guessResolution(ts []byte) string {
	i := bytes.Index(ts, []byte{0, 0, 1, 0x67})
	if i < 0 {
		return ""
	}
	end := i + 4 + 64
	if end > len(ts) {
		end = len(ts)
	}
	sps := bytes.ReplaceAll(ts[i+4:end], []byte{0, 0, 3}, []byte{0, 0})
	if len(sps) == 0 {
		return ""
	}
	br := &bitReader{data: sps, pos: 24} // profile_idc, constraint flags, level_idc
	profile := int(sps[0])
	br.ue() // seq_parameter_set_id
	if highProfiles[profile] {
		cf := br.ue()
		if cf == 3 {
			br.skip(1)
		}
		br.ue()
		br.ue()
		br.skip(1)
		if br.peekPrev() == 1 {
			n := 8
			if cf == 3 {
				n = 12
			}
			for k := 0; k < n; k++ {
				if br.bit() == 1 {
					return "" // scaling lists: too complex for a guess
				}
			}
		}
	}
	br.ue() // log2_max_frame_num
	poc := br.ue()
	if poc == 0 {
		br.ue()
	} else if poc == 1 {
		br.skip(1)
		br.se()
		br.se()
		n := br.ue()
		if n < 0 || n > 255 || br.err {
			return ""
		}
		for k := 0; k < n; k++ {
			br.se()
		}
	}
	br.ue()
	br.skip(1)
	w := (br.ue() + 1) * 16
	h := (br.ue() + 1) * 16
	frameMbsOnly := br.bit()
	if frameMbsOnly == 0 {
		br.skip(1)
		h *= 2
	}
	br.skip(1)
	if br.bit() == 1 {
		l, r, t, b := br.ue(), br.ue(), br.ue(), br.ue()
		w -= (l + r) * 2
		mul := 2
		if frameMbsOnly == 0 {
			mul = 4
		}
		h -= (t + b) * mul
	}
	if br.err {
		return ""
	}
	if 64 <= w && w <= 8192 && 64 <= h && h <= 8192 {
		return fmt.Sprintf("%dx%d", w, h)
	}
	return ""
}

// probeMany probes items ([{source, source_name, url}]) with up to 8 workers and returns each
// input map merged with its probe result. Cached per url for probeTTL; fresh drops cached rows first.
func (a *App) probeMany(items []map[string]interface{}, fresh bool) []map[string]interface{} {
	if fresh {
		for _, it := range items {
			a.mem.delete("probe:" + pyStr(it["url"]))
		}
	}
	out := make([]map[string]interface{}, len(items))
	sem := make(chan struct{}, probeWorkers)
	var wg sync.WaitGroup
	for i, it := range items {
		wg.Add(1)
		go func(i int, it map[string]interface{}) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			out[i] = a.probeOne(it)
		}(i, it)
	}
	wg.Wait()
	return out
}

func (a *App) probeOne(it map[string]interface{}) map[string]interface{} {
	o := make(map[string]interface{}, len(it)+9)
	for k, v := range it {
		o[k] = v
	}
	u, _ := it["url"].(string)
	if u == "" {
		o["ok"] = false
		o["error"] = "no url"
		return o
	}
	v, _ := a.mem.get("probe:"+u, probeTTL, func() (interface{}, error) { return probeStream(u), nil })
	r, _ := v.(*probeResult)
	if r == nil {
		r = probeStream(u)
	}
	o["url"] = r.URL
	o["ok"] = r.OK
	o["latency_ms"] = nilOrInt(r.LatencyMs)
	o["speed_kbps"] = nilOrInt(r.SpeedKbps)
	o["resolution"] = nilOrStr(r.Resolution)
	o["bandwidth_kbps"] = nilOrInt(r.BandwidthKbps)
	o["duration_s"] = nilOrInt(r.DurationS)
	o["segments"] = nilOrInt(r.Segments)
	o["error"] = nilOrStr(r.Error)
	return o
}

func nilOrInt(p *int) interface{} {
	if p == nil {
		return nil
	}
	return *p
}

func nilOrStr(p *string) interface{} {
	if p == nil {
		return nil
	}
	return *p
}

// pyStr mimics str(x) for the cache key of a missing/odd url (Python: "probe:None").
func pyStr(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return "None"
	case string:
		return t
	default:
		return fmt.Sprint(t)
	}
}
