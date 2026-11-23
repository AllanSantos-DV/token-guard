// Command slice is the token-guard PreToolUse guard behind an HTTP hook listener (see ../../SPEC.md).
package main

import (
	"crypto/subtle"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
)

const (
	impl    = "go"
	maxBody = 1 << 30
)

type server struct{ token string }

func (s *server) send(w http.ResponseWriter, status int, body string, rule string) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	if rule != "" {
		h["x-tg-rule"] = []string{rule}
	}
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func (s *server) tokenOK(r *http.Request) bool {
	given := strings.Join(r.Header.Values("X-Token-Guard"), ", ")
	return len(given) == len(s.token) && subtle.ConstantTimeCompare([]byte(given), []byte(s.token)) == 1
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	route, _, _ := strings.Cut(r.RequestURI, "?")
	health := r.Method == http.MethodGet && route == "/token-guard/health"
	pre := r.Method == http.MethodPost && route == "/token-guard/pre"
	if !health && !pre {
		s.send(w, 404, `{"error":"rota desconhecida"}`, "")
		return
	}
	if !s.tokenOK(r) {
		s.send(w, 401, `{"error":"token ausente ou invalido"}`, "")
		return
	}
	if health {
		s.send(w, 200, fmt.Sprintf(`{"ok":true,"pid":%d,"impl":"%s"}`, os.Getpid(), impl), "")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		s.send(w, 400, `{"error":"JSON invalido"}`, "")
		return
	}
	payload, err := parseJSON(body)
	if err != nil {
		s.send(w, 400, `{"error":"JSON invalido"}`, "")
		return
	}
	v := decide(payload)
	rule := ""
	if v != nil {
		rule = v.rule
	}
	s.send(w, 200, envelope(v), rule)
}

func main() {
	port := flag.Int("port", 0, "port to listen on (127.0.0.1)")
	token := flag.String("token", "", "shared token expected in X-Token-Guard")
	flag.Parse()
	if *port == 0 || *token == "" {
		fmt.Fprintln(os.Stderr, "usage: slice --port N --token T")
		os.Exit(2)
	}
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(*port)))
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen:", err)
		os.Exit(1)
	}
	fmt.Printf("READY port=%d impl=%s\n", *port, impl)
	if err := http.Serve(ln, &server{token: *token}); err != nil {
		fmt.Fprintln(os.Stderr, "serve:", err)
		os.Exit(1)
	}
}
