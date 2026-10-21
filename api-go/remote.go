package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

// --------------------------------------------------------------------------- remote input (phone -> TV)
// The TV's on-screen keyboard registers a channel and shows a QR code pointing at /r/<id>.
// The phone opens that page, types, and POSTs to /remote/<id>/send; the TV long-polls
// /remote/<id>/poll. Everything is in memory and LAN-only.

const (
	remoteTTL      = 24 * time.Hour
	remotePollWait = 25 * time.Second
	remoteIDChars  = "abcdefghjkmnpqrstuvwxyz23456789"
)

var remoteIDRe = regexp.MustCompile(`^[A-Za-z0-9]{4,16}$`)

// remoteMsg is one message queued for the TV; key order matches the Python dict.
type remoteMsg struct {
	Seq    int     `json:"seq"`
	Text   string  `json:"text"`
	Action string  `json:"action"`
	T      float64 `json:"t"`
}

// remoteState is what the TV reports about its keyboard; empty until the first POST (Python: {}).
type remoteState struct {
	Open  bool   `json:"open"`
	Label string `json:"label"`
	Value string `json:"value"`
}

type remoteChannel struct {
	id    string
	mu    sync.Mutex // guards seq, msgs, state; cond waits on it
	cond  *sync.Cond
	seq   int
	msgs  []remoteMsg
	state *remoteState // nil -> {}
	t     time.Time    // last touch, for expiry
}

func newRemoteChannel(id string, now time.Time) *remoteChannel {
	ch := &remoteChannel{id: id, msgs: []remoteMsg{}, t: now}
	ch.cond = sync.NewCond(&ch.mu)
	return ch
}

// Remote holds all channels.
type Remote struct {
	mu sync.Mutex
	ch map[string]*remoteChannel
}

func newRemote() *Remote { return &Remote{ch: map[string]*remoteChannel{}} }

func (rm *Remote) newID() string {
	b := make([]byte, 6)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(remoteIDChars))))
		if err != nil {
			panic(err)
		}
		b[i] = remoteIDChars[n.Int64()]
	}
	return string(b)
}

// channel returns the channel cid (expiring idle ones first). With create, a missing or invalid
// cid yields a fresh channel with a generated id. Returns nil when not found and !create.
func (rm *Remote) channel(cid string, create bool) *remoteChannel {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	now := time.Now()
	for k, v := range rm.ch {
		if now.Sub(v.t) > remoteTTL {
			delete(rm.ch, k)
		}
	}
	var ch *remoteChannel
	if cid != "" {
		ch = rm.ch[cid]
	}
	if ch == nil && create {
		if cid == "" || !remoteIDRe.MatchString(cid) {
			cid = rm.newID()
			for rm.ch[cid] != nil {
				cid = rm.newID()
			}
		}
		ch = newRemoteChannel(cid, now)
		rm.ch[cid] = ch
	}
	if ch != nil {
		ch.t = now
	}
	return ch
}

func (rm *Remote) send(ch *remoteChannel, text, action string) int {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	ch.seq++
	ch.msgs = append(ch.msgs, remoteMsg{Seq: ch.seq, Text: text, Action: action, T: float64(time.Now().UnixNano()) / 1e9})
	if len(ch.msgs) > 20 {
		ch.msgs = append([]remoteMsg{}, ch.msgs[len(ch.msgs)-20:]...)
	}
	ch.cond.Broadcast()
	return ch.seq
}

// poll waits up to timeout for messages with seq > since; returns {"seq": N, "messages": [...]}.
func (rm *Remote) poll(ch *remoteChannel, since int, timeout time.Duration) map[string]interface{} {
	deadline := time.Now().Add(timeout)
	timer := time.AfterFunc(timeout, func() {
		ch.mu.Lock()
		ch.cond.Broadcast()
		ch.mu.Unlock()
	})
	defer timer.Stop()
	ch.mu.Lock()
	defer ch.mu.Unlock()
	for {
		pending := []remoteMsg{}
		for _, m := range ch.msgs {
			if m.Seq > since {
				pending = append(pending, m)
			}
		}
		if len(pending) > 0 || !time.Now().Before(deadline) {
			return map[string]interface{}{"seq": ch.seq, "messages": pending}
		}
		ch.cond.Wait()
	}
}

// qrSVG renders data as a single-path SVG like qrcode.image.svg.SvgPathImage
// (box_size=10 -> 1 unit per module, border=2, white background, black path).
func qrSVG(data string) ([]byte, error) {
	qr, err := qrcode.New(data, qrcode.Medium)
	if err != nil {
		return nil, err
	}
	qr.DisableBorder = true
	bm := qr.Bitmap()
	const border = 2
	n := len(bm)
	dim := n + 2*border
	var b strings.Builder
	fmt.Fprintf(&b, `<svg width="%dmm" height="%dmm" version="1.1" viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg">`, dim, dim, dim, dim)
	fmt.Fprintf(&b, `<rect width="%d" height="%d" fill="#ffffff"/>`, dim, dim)
	b.WriteString(`<path d="`)
	for y, row := range bm {
		for x, on := range row {
			if on {
				fmt.Fprintf(&b, "M%d,%dH%dV%dH%dz", x+border, y+border, x+border+1, y+border+1, x+border)
			}
		}
	}
	b.WriteString(`" id="qr-path" fill="#000000" fill-opacity="1" fill-rule="nonzero" stroke="none"/></svg>`)
	return []byte(b.String()), nil
}

func hostOf(r *http.Request, a *App) string {
	if r.Host != "" {
		return r.Host
	}
	return "localhost:" + a.cfg.Port
}

// remoteGet handles GET /remote/<id>/{qr.svg,poll,state}.
func (a *App) remoteGet(w http.ResponseWriter, r *http.Request, p string) {
	parts := strings.Split(p, "/") // ['', 'remote', '<id>', '<op>']
	if len(parts) != 4 {
		sendError(w, r, 404, "not found")
		return
	}
	ch := a.remote.channel(parts[2], false)
	if ch == nil {
		sendError(w, r, 404, "no such channel")
		return
	}
	switch parts[3] {
	case "qr.svg":
		svg, err := qrSVG(fmt.Sprintf("http://%s/r/%s", hostOf(r, a), ch.id))
		if err != nil {
			fail(w, r, err)
			return
		}
		send(w, r, 200, svg, "image/svg+xml", 86400)
	case "poll":
		since := atoi(r.URL.Query().Get("since"), 0)
		sendJSON(w, r, 200, a.remote.poll(ch, since, remotePollWait), 0)
	case "state":
		ch.mu.Lock()
		st := ch.state
		ch.mu.Unlock()
		if st == nil {
			sendJSON(w, r, 200, map[string]interface{}{}, 0)
		} else {
			sendJSON(w, r, 200, st, 0)
		}
	default:
		sendError(w, r, 404, "not found")
	}
}

// remoteNew handles POST /remote/new: reuse body.id if it is a live/valid channel id, else create.
func (a *App) remoteNew(w http.ResponseWriter, r *http.Request, body map[string]interface{}) {
	ch := a.remote.channel(strings.TrimSpace(str(body["id"])), true)
	ch.mu.Lock()
	seq := ch.seq
	ch.mu.Unlock()
	sendJSON(w, r, 200, map[string]interface{}{"id": ch.id, "seq": seq, "url": fmt.Sprintf("http://%s/r/%s", hostOf(r, a), ch.id)}, 0)
}

// pyStrOr mimics str(body.get(k) or "") for JSON values.
func pyStrOr(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "True"
		}
		return ""
	case float64:
		if t == 0 {
			return ""
		}
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprint(t)
	default:
		return fmt.Sprint(t)
	}
}

// pyTruthy mimics bool(x) for JSON values.
func pyTruthy(v interface{}) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case []interface{}:
		return len(t) > 0
	case map[string]interface{}:
		return len(t) > 0
	}
	return true
}

// remotePost handles POST /remote/<id>/{send,state}.
func (a *App) remotePost(w http.ResponseWriter, r *http.Request, p string, body map[string]interface{}) {
	parts := strings.Split(p, "/")
	var ch *remoteChannel
	if len(parts) == 4 {
		ch = a.remote.channel(parts[2], false)
	}
	if ch == nil {
		sendError(w, r, 404, "no such channel")
		return
	}
	switch parts[3] {
	case "send":
		text := truncRunes(pyStrOr(body["text"]), 500)
		action := "input"
		if s, ok := body["action"].(string); ok && (s == "input" || s == "submit") {
			action = s
		}
		seq := a.remote.send(ch, text, action)
		sendJSON(w, r, 200, map[string]interface{}{"ok": true, "seq": seq}, 0)
	case "state":
		st := &remoteState{Open: pyTruthy(body["open"]), Label: truncRunes(pyStrOr(body["label"]), 20), Value: truncRunes(pyStrOr(body["value"]), 100)}
		ch.mu.Lock()
		ch.state = st
		ch.mu.Unlock()
		sendJSON(w, r, 200, map[string]bool{"ok": true}, 0)
	default:
		sendError(w, r, 404, "not found")
	}
}

// servePhonePage handles GET /r/<id>.
func (a *App) servePhonePage(w http.ResponseWriter, r *http.Request, id string) {
	if !remoteIDRe.MatchString(id) {
		sendError(w, r, 404, "not found")
		return
	}
	idJSON, _ := json.Marshal(id)
	send(w, r, 200, []byte(strings.Replace(phonePage, "__ID__", string(idJSON), 1)), "text/html; charset=utf-8", 0)
}

// phonePage is PHONE_PAGE from the Python bridge, verbatim.
const phonePage = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>MoonTV 电视输入</title>
<style>
body{font-family:-apple-system,"Segoe UI","Noto Sans",sans-serif;background:#0f1117;color:#e8e8ec;margin:0;padding:22px}
h1{font-size:22px;color:#fad778;margin:0 0 6px}#ctx{color:#8f94a3;font-size:14px;min-height:20px;margin-bottom:14px}
textarea{width:100%;box-sizing:border-box;font-size:20px;padding:12px;border-radius:12px;border:2px solid #2a2f40;background:#1a1d28;color:#fff;min-height:120px;outline:none}
textarea:focus{border-color:#fad778}button{width:100%;font-size:20px;padding:15px;margin-top:12px;border-radius:12px;border:0}
.send{background:#2a2f40;color:#e8e8ec}.go{background:#fad778;color:#111;font-weight:600}#msg{margin-top:12px;color:#8f94a3;font-size:14px;min-height:20px}
</style></head><body>
<h1>MoonTV 电视输入</h1><div id="ctx">连接电视中…</div>
<textarea id="t" autofocus placeholder="在手机上打字，发送到电视"></textarea>
<button class="send" onclick="send('input')">发送到电视（填入）</button>
<button class="go" id="go" onclick="send('submit')">确认</button>
<div id="msg"></div>
<script>
var ID=__ID__;
function st(){fetch('/remote/'+ID+'/state').then(function(r){return r.ok?r.json():null}).then(function(s){
  var go=document.getElementById('go'),c=document.getElementById('ctx');
  if(!s||!s.open){go.textContent='确认';c.textContent='电视当前没有打开键盘（在电视上进入搜索或登录页）';return}
  go.textContent=s.label||'确认';c.textContent='电视正在等待输入 · 按钮 = 电视上的「'+(s.label||'确认')+'」'+(s.value?'　当前：'+s.value:'');
}).catch(function(){document.getElementById('ctx').textContent='无法连接桥接服务'})}
st();setInterval(st,4000);
function send(a){var v=document.getElementById('t').value;
 fetch('/remote/'+ID+'/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:v,action:a})})
 .then(function(r){document.getElementById('msg').textContent=r.ok?'已发送 ✓':(r.status===404?'电视未连接，请在电视上重新打开键盘':'发送失败');if(r.ok&&a==='submit')document.getElementById('t').value='';})
 .catch(function(){document.getElementById('msg').textContent='发送失败'})}
</script></body></html>`
