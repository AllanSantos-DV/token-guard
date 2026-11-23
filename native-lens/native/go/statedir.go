package main

// Where the repository statistics live: the project root walk, the user data folder and the hash-keyed
// fallback, without a session id and without ever writing.

import (
	"crypto/sha1"
	"encoding/hex"
	"os"
	"strings"
)

var (
	projectMarkers = []string{".git", "package.json", "token-guard.config.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle"}
	userFolders    = setOf("desktop", "documents", "downloads", "pictures", "videos", "music", "onedrive")
	systemSegments = setOf("appdata", "node_modules", "windows", "program files", "program files (x86)", "programdata", "system32")
	systemLeaves   = setOf("bin", "sbin", "etc", "usr", "var")
)

func setOf(items ...string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, i := range items {
		m[i] = true
	}
	return m
}

func exists(p string) bool {
	_, err := os.Stat(toNamespaced(p))
	return err == nil
}

func dataHome() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = win32Join(homedir(), "AppData", "Local")
	}
	return win32Join(base, "token-guard")
}

func sameDir(a, b string) bool {
	return jsLower(win32Resolve(a)) == jsLower(win32Resolve(b))
}

// splitSeparators splits on either slash and keeps empty segments.
func splitSeparators(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' || s[i] == '/' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return append(out, s[start:])
}

// neverProject is true for folders that can never be a project root: drive roots, the home folder,
// its personal folders and system locations.
func neverProject(dir string) bool {
	abs := win32Resolve(dir)
	if win32Dirname(abs) == abs {
		return true
	}
	home := homedir()
	if sameDir(abs, home) {
		return true
	}
	if sameDir(win32Dirname(abs), home) && userFolders[jsLower(win32Basename(abs))] {
		return true
	}
	rel := win32Relative(home, abs)
	inHome := rel != "" && !strings.HasPrefix(rel, "..") && !win32IsAbsolute(rel)
	if systemLeaves[jsLower(win32Basename(abs))] {
		return true
	}
	subject := abs
	if inHome {
		subject = rel
	}
	segments := splitSeparators(subject)
	for i := range segments {
		segments[i] = jsLower(segments[i])
	}
	for i, s := range segments {
		if s == "appdata" && i+2 < len(segments) && segments[i+1] == "local" && segments[i+2] == "temp" {
			segments = segments[i+3:]
			break
		}
	}
	for _, s := range segments {
		if systemSegments[s] {
			return true
		}
	}
	return false
}

func projectRoot(dir string) (string, bool) {
	cur := win32Resolve(dir)
	for {
		if neverProject(cur) {
			return "", false
		}
		for _, m := range projectMarkers {
			if exists(win32Join(cur, m)) {
				return cur, true
			}
		}
		up := win32Dirname(cur)
		if up == cur {
			return "", false
		}
		cur = up
	}
}

// stateDir is the folder holding the cached statistics of root.
func stateDir(root string) string {
	origin := win32Resolve(root)
	if project, ok := projectRoot(origin); ok {
		return win32Join(project, ".token-guard")
	}
	sum := sha1.Sum([]byte(jsLower(origin)))
	return win32Join(dataHome(), "state", hex.EncodeToString(sum[:])[:16])
}

// repoStats is the parsed repo-stats.json of root, or nil when it is missing, unreadable or not JSON.
func repoStats(root string) any {
	p := win32Join(stateDir(root), "repo-stats.json")
	if !exists(p) {
		return nil
	}
	b, err := os.ReadFile(toNamespaced(p))
	if err != nil {
		return nil
	}
	v, err := parseJSON(b)
	if err != nil {
		return nil
	}
	return v
}
