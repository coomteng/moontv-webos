package main

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Everything in this file mirrors a feature of MoonTV's own web UI (recorded by driving it):
//   - advanced browse ("全部" tab): /api/douban/recommends with 类型/地区/年代/平台/排序
//   - favourites:   GET /api/favorites, POST {key,favorite}, DELETE ?key=, DELETE (all)
//   - skip configs: GET /api/skipconfigs, POST {key,config}, DELETE ?key=
//   - clear play records: DELETE /api/playrecords, DELETE ?key=
//   - bangumi calendar (新番放送): GET /api/bangumi/calendar

// ---------------------------------------------------------------- advanced filters (recommends)

type advGroup struct {
	Key     string   `json:"key"`     // query parameter name
	Label   string   `json:"label"`   // row label shown on the TV
	Options []string `json:"options"` // display labels; "全部" maps to "all"
}

// sortCodes: display label -> recommends sort= value (the web's dropdown order).
var sortCodes = map[string]string{"综合排序": "T", "近期热度": "U", "首映时间": "R", "首播时间": "R", "高分优先": "S"}

var advMovie = []advGroup{
	{"sort", "排序", []string{"综合排序", "近期热度", "首映时间", "高分优先"}},
	{"category", "类型", []string{"全部", "喜剧", "爱情", "动作", "科幻", "悬疑", "犯罪", "惊悚", "冒险", "音乐", "历史", "奇幻", "恐怖", "战争", "传记", "歌舞", "武侠", "情色", "灾难", "西部", "纪录片", "短片"}},
	{"region", "地区", []string{"全部", "华语", "欧美", "韩国", "日本", "中国大陆", "美国", "中国香港", "中国台湾", "英国", "法国", "德国", "意大利", "西班牙", "印度", "泰国", "俄罗斯", "加拿大", "澳大利亚", "爱尔兰", "瑞典", "巴西", "丹麦"}},
	{"year", "年代", []string{"全部", "2020年代", "2025", "2024", "2023", "2022", "2021", "2020", "2019", "2010年代", "2000年代", "90年代", "80年代", "70年代", "60年代", "更早"}},
}

var advTV = []advGroup{
	{"sort", "排序", []string{"综合排序", "近期热度", "首播时间", "高分优先"}},
	{"category", "类型", []string{"全部", "喜剧", "爱情", "悬疑", "武侠", "古装", "家庭", "犯罪", "科幻", "恐怖", "历史", "战争", "动作", "冒险", "传记", "剧情", "奇幻", "惊悚", "灾难", "歌舞", "音乐"}},
	{"region", "地区", []string{"全部", "华语", "欧美", "国外", "韩国", "日本", "中国大陆", "中国香港", "美国", "英国", "泰国", "中国台湾", "意大利", "法国", "德国", "西班牙", "俄罗斯", "瑞典", "巴西", "丹麦", "印度", "加拿大", "爱尔兰", "澳大利亚"}},
	{"year", "年代", []string{"全部", "2020年代", "2025", "2024", "2023", "2022", "2021", "2020", "2019", "2010年代", "2000年代", "90年代", "80年代", "70年代", "60年代", "更早"}},
	{"platform", "平台", []string{"全部", "腾讯视频", "爱奇艺", "优酷", "湖南卫视", "Netflix", "HBO", "BBC", "NHK", "CBS", "NBC", "tvN"}},
}

// advFilters returns the advanced filter groups for a kind, as the TV app renders them.
func advFilters(kind string) []advGroup {
	switch kind {
	case "movie":
		return advMovie
	case "tv", "show":
		return advTV
	}
	return nil
}

func allOr(v string) string {
	if v == "" || v == "全部" {
		return "all"
	}
	return v
}

// advancedListPath builds the recommends request exactly as the web does for the "全部" tab.
func advancedListPath(kind string, p map[string]string, start, size int) string {
	sortCode := sortCodes[p["sort"]]
	if sortCode == "" {
		sortCode = "T"
	}
	var k, format string
	switch kind {
	case "movie":
		k, format = "movie", ""
	case "show":
		k, format = "tv", "综艺"
	default:
		k, format = "tv", "电视剧"
	}
	return fmt.Sprintf("/api/douban/recommends?kind=%s&limit=%d&start=%d&category=%s&format=%s&region=%s&year=%s&platform=%s&sort=%s&label=all",
		k, size, start, q(allOr(p["category"])), q(format), q(allOr(p["region"])), q(allOr(p["year"])), q(allOr(p["platform"])), sortCode)
}

func (a *App) advancedList(kind string, p map[string]string, start, size int) ([]Item, error) {
	key := fmt.Sprintf("adv:%s:%s:%s:%s:%s:%s:%d:%d", kind, p["sort"], p["category"], p["region"], p["year"], p["platform"], start, size)
	v, err := a.mem.get(key, listTTL, func() (interface{}, error) {
		var res struct {
			List []map[string]interface{} `json:"list"`
		}
		if err := a.defaultUp.callJSON("GET", advancedListPath(kind, p, start, size), nil, 60*time.Second, &res); err != nil {
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

// ---------------------------------------------------------------- favourites

// Fav is a favourite as served to the TV (same shape family as Rec so cards render alike).
type Fav struct {
	Key           string      `json:"key"`
	Source        string      `json:"source"`
	ID            string      `json:"id"`
	Title         interface{} `json:"title"`
	Poster        interface{} `json:"poster"`
	Year          interface{} `json:"year"`
	SourceName    interface{} `json:"source_name"`
	TotalEpisodes interface{} `json:"total_episodes"`
	SaveTime      interface{} `json:"save_time"`
	SearchTitle   interface{} `json:"search_title"`
	saveTime      float64
}

func favorites(up *Upstream) ([]Fav, error) {
	var m map[string]map[string]interface{}
	if err := up.callJSON("GET", "/api/favorites", nil, 60*time.Second, &m); err != nil {
		return nil, err
	}
	out := make([]Fav, 0, len(m))
	for key, f := range m {
		src, vid, ok := strings.Cut(key, "+")
		if !ok {
			continue
		}
		fv := Fav{Key: key, Source: src, ID: vid, Title: f["title"], Poster: f["cover"], Year: f["year"], SourceName: f["source_name"],
			TotalEpisodes: orDefault(f, "total_episodes", 1), SaveTime: orDefault(f, "save_time", 0), SearchTitle: orDefault(f, "search_title", "")}
		fv.saveTime = toFloat(fv.SaveTime)
		out = append(out, fv)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].saveTime > out[j].saveTime })
	return out, nil
}

// ---------------------------------------------------------------- bangumi calendar (新番放送)

type BangumiItem struct {
	ID     interface{} `json:"id"`
	Title  string      `json:"title"`
	Poster interface{} `json:"poster"`
	Rate   string      `json:"rate"`
	Year   string      `json:"year"`
	Day    string      `json:"day"` // 星期一 … 星期日
}

func (a *App) bangumiToday() ([]BangumiItem, error) {
	v, err := a.mem.get("bangumi", 60*time.Minute, func() (interface{}, error) {
		var days []struct {
			Weekday struct {
				CN string `json:"cn"`
				ID int    `json:"id"`
			} `json:"weekday"`
			Items []map[string]interface{} `json:"items"`
		}
		if err := a.defaultUp.callJSON("GET", "/api/bangumi/calendar", nil, 60*time.Second, &days); err != nil {
			return nil, err
		}
		// today first, then the following days (the web shows a weekday tab strip defaulting to today)
		wd := int(time.Now().Weekday()) // Sunday=0
		if wd == 0 {
			wd = 7
		}
		sort.SliceStable(days, func(i, j int) bool {
			di, dj := (days[i].Weekday.ID-wd+7)%7, (days[j].Weekday.ID-wd+7)%7
			return di < dj
		})
		var out []BangumiItem
		for _, d := range days {
			for _, it := range d.Items {
				title, _ := it["name_cn"].(string)
				if title == "" {
					title, _ = it["name"].(string)
				}
				var poster interface{}
				if imgs, ok := it["images"].(map[string]interface{}); ok {
					poster = imgs["large"]
				}
				rate := ""
				if r, ok := it["rating"].(map[string]interface{}); ok {
					if s, ok := r["score"].(float64); ok && s > 0 {
						rate = fmt.Sprintf("%.1f", s)
					}
				}
				year := ""
				if ad, ok := it["air_date"].(string); ok && len(ad) >= 4 {
					year = ad[:4]
				}
				out = append(out, BangumiItem{ID: it["id"], Title: title, Poster: poster, Rate: rate, Year: year, Day: d.Weekday.CN})
			}
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	return v.([]BangumiItem), nil
}

// ---------------------------------------------------------------- handlers

// GET /favorites            -> [Fav]
// POST /favorites {key, favorite:{title,cover,source_name,year,total_episodes,save_time,search_title}}
// DELETE /favorites?key=    (or no key = clear all)
func (a *App) handleFavorites(w http.ResponseWriter, r *http.Request, body map[string]interface{}) {
	up, err := a.session(r)
	if err != nil {
		fail(w, r, err)
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		favs, err := favorites(up)
		if err != nil {
			fail(w, r, err)
			return
		}
		sendJSON(w, r, 200, favs, 0)
	case http.MethodPost:
		key := str(body["key"])
		fav, ok := body["favorite"].(map[string]interface{})
		if key == "" || !ok {
			sendError(w, r, 400, "key and favorite required")
			return
		}
		if _, has := fav["save_time"]; !has {
			fav["save_time"] = time.Now().UnixMilli()
		}
		if err := up.callJSON("POST", "/api/favorites", map[string]interface{}{"key": key, "favorite": fav}, 60*time.Second, nil); err != nil {
			fail(w, r, err)
			return
		}
		sendJSON(w, r, 200, map[string]bool{"ok": true}, 0)
	case http.MethodDelete:
		path := "/api/favorites"
		if key := r.URL.Query().Get("key"); key != "" {
			path += "?key=" + q(key)
		}
		if err := up.callJSON("DELETE", path, nil, 60*time.Second, nil); err != nil {
			fail(w, r, err)
			return
		}
		sendJSON(w, r, 200, map[string]bool{"ok": true}, 0)
	default:
		sendError(w, r, 405, "method not allowed")
	}
}

// GET /skip?key=  -> {enable,intro_time,outro_time} or {} ; GET /skip -> all
// POST /skip {key, config:{enable,intro_time,outro_time}} ; DELETE /skip?key=
func (a *App) handleSkip(w http.ResponseWriter, r *http.Request, body map[string]interface{}) {
	up, err := a.session(r)
	if err != nil {
		fail(w, r, err)
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		var all map[string]interface{}
		if err := up.callJSON("GET", "/api/skipconfigs", nil, 60*time.Second, &all); err != nil {
			fail(w, r, err)
			return
		}
		if key := r.URL.Query().Get("key"); key != "" {
			if c, ok := all[key]; ok {
				sendJSON(w, r, 200, c, 0)
			} else {
				sendJSON(w, r, 200, map[string]interface{}{}, 0)
			}
			return
		}
		if all == nil {
			all = map[string]interface{}{}
		}
		sendJSON(w, r, 200, all, 0)
	case http.MethodPost:
		key := str(body["key"])
		cfg, ok := body["config"].(map[string]interface{})
		if key == "" || !ok {
			sendError(w, r, 400, "key and config required")
			return
		}
		if err := up.callJSON("POST", "/api/skipconfigs", map[string]interface{}{"key": key, "config": cfg}, 60*time.Second, nil); err != nil {
			fail(w, r, err)
			return
		}
		sendJSON(w, r, 200, map[string]bool{"ok": true}, 0)
	case http.MethodDelete:
		key := r.URL.Query().Get("key")
		if key == "" {
			sendError(w, r, 400, "key required")
			return
		}
		if err := up.callJSON("DELETE", "/api/skipconfigs?key="+q(key), nil, 60*time.Second, nil); err != nil {
			fail(w, r, err)
			return
		}
		sendJSON(w, r, 200, map[string]bool{"ok": true}, 0)
	default:
		sendError(w, r, 405, "method not allowed")
	}
}

// DELETE /record?key=  (one) or DELETE /record (clear all 继续观看)
func (a *App) handleRecordDelete(w http.ResponseWriter, r *http.Request) {
	up, err := a.session(r)
	if err != nil {
		fail(w, r, err)
		return
	}
	path := "/api/playrecords"
	if key := r.URL.Query().Get("key"); key != "" {
		path += "?key=" + q(key)
	}
	if err := up.callJSON("DELETE", path, nil, 60*time.Second, nil); err != nil {
		fail(w, r, err)
		return
	}
	sendJSON(w, r, 200, map[string]bool{"ok": true}, 0)
}
