package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/Lofanmi/pinyin-golang/pinyin"
)

const (
	listTTL   = 10 * time.Minute
	titlesTTL = 30 * time.Minute
	posterTTL = 7 * 24 * time.Hour
)

// Item is a slimmed douban list entry (field order matters for byte-identical JSON).
type Item struct {
	ID     interface{} `json:"id"`
	Title  interface{} `json:"title"`
	Poster interface{} `json:"poster"`
	Rate   interface{} `json:"rate"`
	Year   interface{} `json:"year"`
}

// Filters mirror MoonTV's web UI chips. Order of keys is fixed via MarshalJSON below.
type filterSet struct {
	Cats    []string `json:"cats"`
	Regions []string `json:"regions"`
}

var filterOrder = []string{"movie", "tv", "anime", "show"}
var filters = map[string]filterSet{
	"movie": {Cats: []string{"热门", "最新", "豆瓣高分", "冷门佳片"}, Regions: []string{"全部", "华语", "欧美", "韩国", "日本"}},
	"tv":    {Cats: []string{"全部", "国产剧", "欧美剧", "韩剧", "日剧", "港剧"}, Regions: []string{}},
	"anime": {Cats: []string{"动画"}, Regions: []string{}},
	"show":  {Cats: []string{"综艺"}, Regions: []string{}},
}
var tvType = map[string]string{"全部": "tv", "国产剧": "国产剧", "欧美剧": "欧美剧", "韩剧": "韩剧", "日剧": "日剧", "港剧": "港剧", "动画": "动画", "综艺": "综艺"}

// filtersJSON renders filters in a stable key order.
func filtersJSON() []byte {
	var b strings.Builder
	b.WriteString("{")
	for i, k := range filterOrder {
		if i > 0 {
			b.WriteString(", ")
		}
		v, _ := json.Marshal(filters[k])
		fmt.Fprintf(&b, "%q: %s", k, v)
	}
	b.WriteString("}")
	return []byte(b.String())
}

func q(s string) string { return url.QueryEscape(s) }

func (a *App) doubanList(kind, tag, region string, start, size int) ([]Item, error) {
	if tag == "" {
		tag = filters[kind].Cats[0]
	}
	if region == "" {
		region = "全部"
	}
	key := fmt.Sprintf("douban:%s:%s:%s:%d:%d", kind, tag, region, start, size)
	v, err := a.mem.get(key, listTTL, func() (interface{}, error) {
		var path string
		if kind == "movie" {
			path = fmt.Sprintf("/api/douban/categories?kind=movie&category=%s&type=%s&limit=%d&start=%d", q(tag), q(region), size, start)
		} else {
			t := tvType[tag]
			if t == "" {
				t = tag
			}
			path = fmt.Sprintf("/api/douban/categories?kind=tv&category=%s&type=%s&limit=%d&start=%d", q("最近热门"), q(t), size, start)
		}
		var res struct {
			List []map[string]interface{} `json:"list"`
		}
		if err := a.defaultUp.callJSON("GET", path, nil, 60*time.Second, &res); err != nil {
			return nil, err
		}
		out := make([]Item, 0, len(res.List))
		for _, i := range res.List {
			out = append(out, Item{i["id"], i["title"], i["poster"], i["rate"], i["year"]})
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	return v.([]Item), nil
}

// Rec is a play record as served to the TV.
type Rec struct {
	Key           string      `json:"key"`
	Source        string      `json:"source"`
	ID            string      `json:"id"`
	Title         interface{} `json:"title"`
	Poster        interface{} `json:"poster"`
	Year          interface{} `json:"year"`
	SourceName    interface{} `json:"source_name"`
	Index         interface{} `json:"index"`
	TotalEpisodes interface{} `json:"total_episodes"`
	PlayTime      interface{} `json:"play_time"`
	TotalTime     interface{} `json:"total_time"`
	SaveTime      interface{} `json:"save_time"`
	SearchTitle   interface{} `json:"search_title"`
	saveTime      float64
}

func orDefault(m map[string]interface{}, k string, d interface{}) interface{} {
	if v, ok := m[k]; ok && v != nil {
		return v
	}
	return d
}

func toFloat(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case json.Number:
		f, _ := n.Float64()
		return f
	case int:
		return float64(n)
	}
	return 0
}

func continueWatching(up *Upstream, limit int) ([]Rec, error) {
	var recs map[string]map[string]interface{}
	if err := up.callJSON("GET", "/api/playrecords", nil, 60*time.Second, &recs); err != nil {
		return nil, err
	}
	items := make([]Rec, 0, len(recs))
	for key, r := range recs {
		src, vid, ok := strings.Cut(key, "+")
		if !ok {
			continue
		}
		rec := Rec{
			Key: key, Source: src, ID: vid,
			Title: r["title"], Poster: r["cover"], Year: r["year"],
			SourceName: r["source_name"], Index: orDefault(r, "index", 1),
			TotalEpisodes: orDefault(r, "total_episodes", 1),
			PlayTime:      orDefault(r, "play_time", 0), TotalTime: orDefault(r, "total_time", 0),
			SaveTime: orDefault(r, "save_time", 0), SearchTitle: orDefault(r, "search_title", ""),
		}
		rec.saveTime = toFloat(rec.SaveTime)
		items = append(items, rec)
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].saveTime > items[j].saveTime })
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

// Result is one source's entry for a title.
type Result struct {
	Source         interface{}   `json:"source"`
	SourceName     interface{}   `json:"source_name"`
	ID             interface{}   `json:"id"`
	Title          interface{}   `json:"title"`
	Poster         interface{}   `json:"poster"`
	Year           interface{}   `json:"year"`
	TypeName       interface{}   `json:"type_name"`
	Class          interface{}   `json:"class"`
	Desc           string        `json:"desc"`
	Episodes       []interface{} `json:"episodes"`
	EpisodesTitles []interface{} `json:"episodes_titles"`
	DoubanID       interface{}   `json:"douban_id"`
}

type Group struct {
	Title    interface{} `json:"title"`
	Year     interface{} `json:"year"`
	Poster   interface{} `json:"poster"`
	TypeName interface{} `json:"type_name"`
	Sources  []*Result   `json:"sources"`
}

func asList(v interface{}) []interface{} {
	if l, ok := v.([]interface{}); ok {
		return l
	}
	return []interface{}{}
}

func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func (a *App) search(query string) ([]*Group, error) {
	var res struct {
		Results []map[string]interface{} `json:"results"`
	}
	if err := a.defaultUp.callJSON("GET", "/api/search?q="+q(query), nil, 90*time.Second, &res); err != nil {
		return nil, err
	}
	groups := map[string]*Group{}
	var order []string
	for _, r := range res.Results {
		desc, _ := r["desc"].(string)
		it := &Result{
			Source: r["source"], SourceName: r["source_name"], ID: r["id"], Title: r["title"], Poster: r["poster"],
			Year: r["year"], TypeName: r["type_name"], Class: r["class"], Desc: truncRunes(desc, 300),
			Episodes: asList(r["episodes"]), EpisodesTitles: asList(r["episodes_titles"]), DoubanID: r["douban_id"],
		}
		gk := fmt.Sprintf("%v\x00%v", it.Title, it.Year)
		g, ok := groups[gk]
		if !ok {
			g = &Group{Title: it.Title, Year: it.Year, Poster: it.Poster, TypeName: it.TypeName, Sources: []*Result{}}
			groups[gk] = g
			order = append(order, gk)
		}
		if isEmpty(g.Poster) && !isEmpty(it.Poster) {
			g.Poster = it.Poster
		}
		g.Sources = append(g.Sources, it)
	}
	out := make([]*Group, 0, len(order))
	for _, k := range order {
		out = append(out, groups[k])
	}
	return out, nil
}

func isEmpty(v interface{}) bool {
	if v == nil {
		return true
	}
	s, ok := v.(string)
	return ok && s == ""
}

// ---------------------------------------------------------------- titles (pinyin index for the IME)

var splitRe = regexp.MustCompile(`\s+|第[\d一二三四五六七八九十百]+[季部集]|[：:·\-—(（]`)

func isHan(r rune) bool { return unicode.Is(unicode.Han, r) }

// titleVariants: "现在就出发 第四季" -> ["现在就出发 第四季", "现在就出发"]; titles must start with a CJK char.
func titleVariants(t string) []string {
	t = strings.TrimSpace(t)
	if t == "" || !isHan([]rune(t)[0]) {
		return nil
	}
	out := []string{t}
	base := strings.TrimSpace(splitRe.Split(t, 2)[0])
	if base != "" && base != t && len([]rune(base)) >= 2 {
		out = append(out, base)
	}
	return out
}

var pinyinDict = pinyin.NewDict()

// phraseFixes patch readings where Lofanmi's dictionary disagrees with pypinyin (the reference the
// built-in pinyin-data.js was generated with). Replacements are plain ASCII syllables separated by
// spaces so they survive syllables()'s letter filter. Order matters: longer phrases first.
var phraseFixes = strings.NewReplacer(
	"为什么", " wei shen me ",
	"重整", " zhong zheng ",
	"重生", " chong sheng ",
	"伽", " ga ",
	"明的", " ming de ",
)

// syllables returns lowercase a-z syllables for a title via Lofanmi's dictionary. The library keeps
// punctuation attached to syllables ("qi:" / "xian!" / "shi("), so each token is reduced to its
// letters; tokens that have none (digits, "(") are dropped. Matches pypinyin's lazy_pinyin filtering.
func syllables(t string) []string {
	// Drop Latin letters/digits up front: pypinyin's lazy_pinyin keeps them as separate tokens that
	// the Python bridge then filters out, so "令人心动的offer" indexes as lingrenxindongde.
	var cjkOnly strings.Builder
	for _, r := range t {
		if isHan(r) || unicode.IsSpace(r) || unicode.IsPunct(r) {
			cjkOnly.WriteRune(r)
		} else {
			cjkOnly.WriteRune(' ')
		}
	}
	s := pinyinDict.Sentence(phraseFixes.Replace(cjkOnly.String())).None()
	var out []string
	for _, w := range strings.Fields(s) {
		w = strings.ToLower(strings.ReplaceAll(w, "ü", "v"))
		var b strings.Builder
		for _, r := range w {
			if r >= 'a' && r <= 'z' {
				b.WriteRune(r)
			}
		}
		if b.Len() > 0 {
			out = append(out, b.String())
		}
	}
	return out
}

func isAlpha(s string) bool {
	for _, r := range s {
		if r < 'a' || r > 'z' {
			return false
		}
	}
	return true
}

type TitleIndex struct {
	Full     map[string][]string `json:"full"`
	Initials map[string][]string `json:"initials"`
	Count    int                 `json:"count"`
}

func (a *App) buildTitles() (*TitleIndex, error) {
	weight := map[string]int{}
	add := func(t interface{}, w int) {
		s, _ := t.(string)
		for _, v := range titleVariants(s) {
			if weight[v] < w {
				weight[v] = w
			}
		}
	}
	if recs, err := continueWatching(a.defaultUp, 200); err == nil {
		for _, r := range recs {
			add(r.Title, 3)
		}
	} else {
		log.Printf("titles: records failed %v", err)
	}
	var hist []string
	if err := a.defaultUp.callJSON("GET", "/api/searchhistory", nil, 30*time.Second, &hist); err == nil {
		for _, h := range hist {
			add(h, 3)
		}
	} else {
		log.Printf("titles: history failed %v", err)
	}
	type src struct{ kind, tag, region string }
	for _, s := range []src{{"movie", "热门", "全部"}, {"movie", "最新", "全部"}, {"tv", "全部", ""}, {"tv", "国产剧", ""},
		{"tv", "欧美剧", ""}, {"tv", "韩剧", ""}, {"tv", "日剧", ""}, {"anime", "动画", ""}, {"show", "综艺", ""}} {
		for _, start := range []int{0, 24, 48} {
			items, err := a.doubanList(s.kind, s.tag, s.region, start, 24)
			if err != nil {
				log.Printf("titles: list %s/%s failed %v", s.kind, s.tag, err)
				break
			}
			for _, it := range items {
				add(it.Title, 1)
			}
		}
	}
	type wt struct {
		w int
		t string
	}
	full, initials := map[string][]wt{}, map[string][]wt{}
	for t, w := range weight {
		syl := syllables(t)
		if len(syl) == 0 {
			continue
		}
		full[strings.Join(syl, "")] = append(full[strings.Join(syl, "")], wt{w, t})
		if len(syl) >= 2 {
			var ini strings.Builder
			for _, s := range syl {
				ini.WriteByte(s[0])
			}
			initials[ini.String()] = append(initials[ini.String()], wt{w, t})
		}
	}
	finish := func(d map[string][]wt) map[string][]string {
		out := make(map[string][]string, len(d))
		for k, v := range d {
			sort.SliceStable(v, func(i, j int) bool { return v[i].w > v[j].w })
			if len(v) > 6 {
				v = v[:6]
			}
			ts := make([]string, len(v))
			for i := range v {
				ts[i] = v[i].t
			}
			out[k] = ts
		}
		return out
	}
	return &TitleIndex{Full: finish(full), Initials: finish(initials), Count: len(weight)}, nil
}
