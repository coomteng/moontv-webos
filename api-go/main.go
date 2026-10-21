package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// Config mirrors the environment variables of the Python bridge, same names.
type Config struct {
	Upstream     string
	User         string
	Pass         string
	Listen       string
	Port         string
	CacheDir     string
	AppDir       string
	SimFile      string
	SeedAccounts [][2]string
	Verbose      bool
}

func loadConfig() Config {
	get := func(k, d string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return d
	}
	home, _ := os.UserHomeDir()
	c := Config{
		Upstream: strings.TrimRight(get("MOONTV_UPSTREAM", "http://moontv-core:3000"), "/"),
		User:     os.Getenv("MOONTV_USER"),
		Pass:     os.Getenv("MOONTV_PASS"),
		Listen:   get("MOONTV_LISTEN", "0.0.0.0"),
		Port:     get("MOONTV_PORT", "8788"),
		CacheDir: get("MOONTV_CACHE", home+"/.cache/moontv-api"),
		AppDir:   os.Getenv("MOONTV_APP_DIR"),
		SimFile:  os.Getenv("MOONTV_SIM"),
		Verbose:  os.Getenv("MOONTV_VERBOSE") != "",
	}
	for _, a := range strings.Split(os.Getenv("MOONTV_SEED_ACCOUNTS"), ",") {
		if u, p, ok := strings.Cut(a, ":"); ok && u != "" {
			c.SeedAccounts = append(c.SeedAccounts, [2]string{u, p})
		}
	}
	return c
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("[moontv-api-go] ")
	cfg := loadConfig()
	if cfg.User == "" || cfg.Pass == "" {
		log.Fatal("MOONTV_USER and MOONTV_PASS must be set")
	}

	app := newApp(cfg)
	addr := cfg.Listen + ":" + cfg.Port
	srv := &http.Server{
		Addr:              addr,
		Handler:           app.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		// no WriteTimeout: /remote/<id>/poll holds connections for 25 s and /search can take longer
		IdleTimeout: 120 * time.Second,
	}

	log.Printf("listening on %s -> %s", addr, cfg.Upstream)
	if _, err := app.defaultUp.cookie(false); err != nil {
		log.Printf("initial login failed (will retry on demand): %v", err)
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
