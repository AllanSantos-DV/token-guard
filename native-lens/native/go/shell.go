package main

// The shellDump rule. Hand-written in place of what RE2 cannot express: the backreference of
// stripHeredocs, and the lookahead and lookbehind constraints of the find, tree and fd dump patterns
// (they scan candidate positions and test the command-position prefix with a regexp anchored at its end).

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	lineTerminators = `\n\r\x{2028}\x{2029}`
	envPrefix       = `(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+){0,6})`
	cmdPos          = `(?:^|[|;&]\s*)` + envPrefix
)

var (
	cmdPosEnd = rx(cmdPos + `$`)

	reGetChildItem = rx(cmdPos + `(?:get-childitem|gci|dir)\s[^|;&]*-recurse`)
	reGciR         = rx(cmdPos + `(?:gci|dir)\s[^|;&]*-r(?:[\s|;&]|$)`)
	reLsR          = rx(`\bls\s+-[a-zA-Z]*[rR][a-zA-Z]*\b`)
	reDirS         = rx(`\bdir\s+\/s\b`)
	reFindStr      = rx(`\bfindstr\s+\/s`)
	reRgFilesCmd   = rx(`\brg\s+[^|;&]*--files\b`)
	reRgFiles      = rx(`\brg\s+[^|;&]*--files\b[^|;&]*(?:[;&]|$)`)
	reTreeLevel    = rx(`-l[\s\/]|-l\b|\/l|--level`)
	reFdFilter     = rx(`-e\s|--extension|-t\s|--type|-g\s|--glob`)

	reGrepish   = rx(`(?:^|[|;&]\s*)` + envPrefix + `(?:[\w.-]+[\\/])?(?:grep|egrep|fgrep|rg)\b`)
	reCapHints  = rx(capHintsSrc)
	reShellWord = rx(`"((?:[^"\\]|\\[^` + lineTerminators + `])*)"|'([^']*)'|(\S+)`)
	reLsFiles   = rx(`^` + envPrefix + `git\s+ls-files\b`)
	reLsPrefix  = rx(`^[^` + lineTerminators + `]*?\bgit\s+ls-files\b`)
	reFindFile  = rx(`\bfind\s+("[^"]+"|'[^']+'|\S+)`)
	reSrcExt    = regexp.MustCompile(`\.[A-Za-z0-9]{1,8}$`)

	reCmdSplit = map[string]*regexp.Regexp{
		"dir":  rx(`^[^` + lineTerminators + `]*?(?:get-childitem|gci|dir)\b`),
		"ls":   rx(`^[^` + lineTerminators + `]*?\bls\b`),
		"find": rx(`^[^` + lineTerminators + `]*?\bfind\b`),
		"tree": rx(`^[^` + lineTerminators + `]*?\btree\b`),
	}

	reGrepCmd0   = rx(`^(?:[\w.-]+[\\/])?(?:grep|egrep|fgrep|rg)$`)
	reRgCmd0     = rx(`(?:^|[\\/])rg$`)
	reEnvAssign  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	reRecurFlag  = regexp.MustCompile(`^-[A-Za-z]*[rR][A-Za-z]*$`)
	reRecurLong  = regexp.MustCompile(`^--(?:dereference-)?recursive$`)
	reShortFlags = regexp.MustCompile(`^-[A-Za-z]+$`)
	reLongFlag   = rx(`^--[a-zA-Z]`)
	reValueLong  = regexp.MustCompile(`^--(?:max-count|after-context|before-context|context|include|exclude|exclude-dir|glob|iglob|type|type-not|max-columns|threads|max-depth|replace|colors?|encoding)$`)
	reDotOnly    = regexp.MustCompile(`^\.{1,2}/?$`)
	reLsStatus   = regexp.MustCompile(`^--(?:others|modified|deleted|unmerged|killed)$`)
	reLsShort    = regexp.MustCompile(`^-[a-z]+$`)

	reGrepWords = rx(`^((?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)((?:[\w.-]+[\\/])?(?:grep|egrep|fgrep|rg))\b\s*([^` + lineTerminators + `]*)$`)
)

const capHintsSrc = `(>\s*[^\s|;&>]` +
	`|\|\s*(?:select-object|select-string|measure-object|sort-object|head|tail|wc|uniq|less|more|awk|sed|grep|findstr|rg)\b` +
	`|-first\s+\d|-totalcount\s+\d|\bhead\s+-n` +
	`|maxdepth[=\s]+\d|-l\s*\d|--level|\/l\b` +
	`|-m\s+\d|--max-count` +
	`|(?:^|\s)-name\s|(?:^|\s)-iname\s|(?:^|\s)-path\s|(?:^|\s)-regex\s` +
	`|(?:^|\s)-(?:newer[a-zA-Z]*|[acmACM]time|[acmACM]min|size|ipath|iregex|i?wholename|perm|user|group)\s|(?:^|\s)-empty\b` +
	`|(?:^|\s)-filter\s|\|\s*(?:where-object|where)\b|\|\s*\?\s*\{|(?:^|\s)-depth\s+\d` +
	`|\bselect-string\b` +
	`|--include|-include\b)`

func isDigitByte(c byte) bool { return c >= '0' && c <= '9' }

// leadingSpaceEnd returns the index after the run of JavaScript whitespace starting at i.
func leadingSpaceEnd(s string, i int) int {
	for i < len(s) {
		r, w := utf8.DecodeRuneInString(s[i:])
		if !isJSSpace(r) {
			break
		}
		i += w
	}
	return i
}

// firstSeparator is the index of the first of | ; & in s, or len(s).
func firstSeparator(s string) int {
	if i := strings.IndexAny(s, "|;&"); i >= 0 {
		return i
	}
	return len(s)
}

func cmdPosAt(s string, p int) bool { return cmdPosEnd.MatchString(s[:p]) }

// matchFind is CMD_POS find\s+(?!"|'|-)(?!\/[a-z]{1,2}(?:$|[\s"]))[^\s|;&]+
func matchFind(s string) bool {
	for p := indexFold(s, "find", 0); p >= 0; p = indexFold(s, "find", p+1) {
		k := leadingSpaceEnd(s, p+4)
		if k == p+4 || k >= len(s) || !cmdPosAt(s, p) {
			continue
		}
		switch s[k] {
		case '"', '\'', '-', '|', ';', '&':
			continue
		case '/':
			if findSwitchFollows(s[k+1:]) {
				continue
			}
		}
		return true
	}
	return false
}

// findSwitchFollows is `[a-z]{1,2}(?:$|[\s"])` anchored at the start of rest.
func findSwitchFollows(rest string) bool {
	n := 0
	for n < len(rest) && n < 2 && isLetterByte(rest[n]) {
		n++
	}
	for k := n; k >= 1; k-- {
		if k == len(rest) || rest[k] == '"' {
			return true
		}
		if r, _ := utf8.DecodeRuneInString(rest[k:]); isJSSpace(r) {
			return true
		}
	}
	return false
}

// matchTree is CMD_POS tree\b(?![^|;&]*(?:-[lL][\s\/]\d*|-l\b|\/l|--level))
func matchTree(s string) bool {
	for p := indexFold(s, "tree", 0); p >= 0; p = indexFold(s, "tree", p+1) {
		e := p + 4
		if e < len(s) && isWordByte(s[e]) || !cmdPosAt(s, p) {
			continue
		}
		rest := s[e:]
		if reTreeLevel.MatchString(rest[:firstSeparator(rest)]) {
			continue
		}
		return true
	}
	return false
}

// matchFd is CMD_POS (?:fd|fdfind)\b(?![^|;&]*(?:-e\s|--extension|-t\s|--type|-g\s|--glob))
func matchFd(s string) bool {
	for p := indexFold(s, "fd", 0); p >= 0; p = indexFold(s, "fd", p+1) {
		e := p + 2
		if indexFold(s[p:], "fdfind", 0) == 0 {
			e = p + 6
		}
		if e < len(s) && isWordByte(s[e]) || !cmdPosAt(s, p) {
			continue
		}
		rest := s[e:]
		if reFdFilter.MatchString(rest[:firstSeparator(rest)]) {
			continue
		}
		return true
	}
	return false
}

type dumpPattern struct {
	what string
	test func(string) bool
}

func guarded(needle string, re *regexp.Regexp) func(string) bool {
	return func(s string) bool { return containsFold(s, needle) && re.MatchString(s) }
}

func both(a, b string, re *regexp.Regexp) func(string) bool {
	return func(s string) bool { return containsFold(s, a) && containsFold(s, b) && re.MatchString(s) }
}

func guardedFn(needle string, f func(string) bool) func(string) bool {
	return func(s string) bool { return containsFold(s, needle) && f(s) }
}

var dumpPatterns = []dumpPattern{
	{"Get-ChildItem -Recurse", guarded("recurse", reGetChildItem)},
	{"gci -r", guarded("-r", reGciR)},
	{"ls -R", guarded("ls", reLsR)},
	{"dir /s", guarded("dir", reDirS)},
	{"find <path>", guardedFn("find", matchFind)},
	{"tree", guardedFn("tree", matchTree)},
	{"findstr /s", guarded("findstr", reFindStr)},
	{"rg --files", both("rg", "--files", reRgFiles)},
	{"fd", guardedFn("fd", matchFd)},
}

func shellWords(seg string) []string {
	var out []string
	for _, m := range reShellWord.FindAllStringSubmatchIndex(seg, -1) {
		switch {
		case m[2] >= 0:
			out = append(out, seg[m[2]:m[3]])
		case m[4] >= 0:
			out = append(out, seg[m[4]:m[5]])
		default:
			out = append(out, seg[m[6]:m[7]])
		}
	}
	return out
}

const (
	valueShortGrep = "efmABCdD"
	valueShortRg   = "efgtTmABCjMEdr"
)

// isStopWord is /^(?:[|;&]+|\d*>.*|<.*)$/: a pipe, a redirect or a chain ends the search arguments.
func isStopWord(w string) bool {
	if w != "" && strings.Trim(w, "|;&") == "" {
		return true
	}
	noLineBreak := func(s string) bool { return !strings.ContainsAny(s, "\n\r\u2028\u2029") }
	i := 0
	for i < len(w) && isDigitByte(w[i]) {
		i++
	}
	if i < len(w) && w[i] == '>' && noLineBreak(w[i+1:]) {
		return true
	}
	return strings.HasPrefix(w, "<") && noLineBreak(w[1:])
}

func searchPaths(isRg bool, words []string) []string {
	valueShort := valueShortGrep
	if isRg {
		valueShort = valueShortRg
	}
	var positional []string
	patternByFlag := false
	for k := 0; k < len(words); k++ {
		w := words[k]
		if isStopWord(w) {
			break
		}
		if w == "--" {
			positional = append(positional, words[k+1:]...)
			break
		}
		if reLongFlag.MatchString(w) {
			switch {
			case w == "--regexp" || w == "--file":
				patternByFlag = true
				k++
			case strings.HasPrefix(w, "--regexp=") || strings.HasPrefix(w, "--file="):
				patternByFlag = true
			case reValueLong.MatchString(w):
				k++
			}
			continue
		}
		if reShortFlags.MatchString(w) {
			last := w[len(w)-1]
			if strings.IndexByte(valueShort, last) >= 0 {
				if last == 'e' || last == 'f' {
					patternByFlag = true
				}
				k++
			}
			continue
		}
		if strings.HasPrefix(w, "-") && len(w) > 1 {
			continue
		}
		positional = append(positional, w)
	}
	if patternByFlag || len(positional) == 0 {
		return positional
	}
	return positional[1:]
}

// grepUnbounded: a content search that walks the repository with nothing to narrow it.
func grepUnbounded(seg, root string) bool {
	toks := shellWords(jsTrim(seg))
	i := 0
	piped := false
	for i < len(toks) && (reEnvAssign.MatchString(toks[i]) || (len(toks[i]) == 1 && strings.Contains("|;&", toks[i]))) {
		if toks[i] == "|" {
			piped = true
		}
		i++
	}
	if i >= len(toks) || toks[i] == "" || !reGrepCmd0.MatchString(toks[i]) {
		return false
	}
	isRg := reRgCmd0.MatchString(toks[i])
	rest := toks[i+1:]
	recursive := isRg
	for _, f := range rest {
		if strings.HasPrefix(f, "-") && (reRecurFlag.MatchString(f) || reRecurLong.MatchString(f)) {
			recursive = true
		}
	}
	if !recursive {
		return false
	}
	paths := searchPaths(isRg, rest)
	if len(paths) == 0 {
		return !piped
	}
	for _, p := range paths {
		if hasRealPathScope([]string{p}, root) {
			return false
		}
	}
	return true
}

// stripHeredocs drops heredoc bodies, keeping the line that opens each one. It stands in for
// /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\r?\n|$)/g, replacing every
// match with its first line, including the regex's backtracking over the delimiter length.
func stripHeredocs(cmd string) string {
	var out strings.Builder
	i, last := 0, 0
	for {
		j := strings.Index(cmd[i:], "<<")
		if j < 0 {
			break
		}
		start := i + j
		if end, firstLineEnd, ok := heredocAt(cmd, start); ok {
			out.WriteString(cmd[last:start])
			out.WriteString(cmd[start:firstLineEnd])
			last, i = end, end
			continue
		}
		i = start + 1
	}
	out.WriteString(cmd[last:])
	return out.String()
}

func isIdentByte(c byte) bool { return c == '_' || isLetterByte(c) }

func heredocAt(s string, start int) (end, firstLineEnd int, ok bool) {
	p := start + 2
	if p < len(s) && s[p] == '-' {
		p++
	}
	p = leadingSpaceEnd(s, p)
	quote := ""
	if p < len(s) && (s[p] == '\'' || s[p] == '"') {
		quote = s[p : p+1]
		p++
	}
	if p >= len(s) || !isIdentByte(s[p]) {
		return 0, 0, false
	}
	tagStart := p
	p++
	for p < len(s) && (isWordByte(s[p]) || s[p] == '-') {
		p++
	}
	for tagEnd := p; tagEnd > tagStart; tagEnd-- {
		after := tagEnd
		if quote != "" {
			if tagEnd != p || !strings.HasPrefix(s[tagEnd:], quote) {
				continue
			}
			after += len(quote)
		}
		nl := strings.IndexByte(s[after:], '\n')
		if nl < 0 {
			return 0, 0, false
		}
		nl += after
		tag := s[tagStart:tagEnd]
		for j := nl + 1; j <= len(s); j++ {
			if j < len(s) && s[j] != '\n' {
				continue
			}
			if j == len(s) {
				break
			}
			q := j + 1
			for q < len(s) && (s[q] == ' ' || s[q] == '\t') {
				q++
			}
			if !strings.HasPrefix(s[q:], tag) {
				continue
			}
			q += len(tag)
			for q < len(s) && (s[q] == ' ' || s[q] == '\t') {
				q++
			}
			if q == len(s) || s[q] == '\n' || (s[q] == '\r' && q+1 < len(s) && s[q+1] == '\n') {
				return q, start + strings.IndexByte(s[start:q], '\n'), true
			}
		}
	}
	return 0, 0, false
}

// statements splits a command line into independent commands: on newline, ;, && and ||, never inside
// quotes or a PowerShell block, and never across a continued line.
func statements(cmd string) []string {
	var out []string
	var cur strings.Builder
	var quote byte
	depth := 0
	for i := 0; i < len(cmd); i++ {
		ch := cmd[i]
		var nx byte
		if i+1 < len(cmd) {
			nx = cmd[i+1]
		}
		if quote != 0 {
			cur.WriteByte(ch)
			if ch == quote && !(quote == '"' && i > 0 && cmd[i-1] == '\\') {
				quote = 0
			}
			continue
		}
		if ch == '"' || ch == '\'' {
			quote = ch
			cur.WriteByte(ch)
			continue
		}
		if ch == '{' {
			depth++
		}
		if ch == '}' && depth > 0 {
			depth--
		}
		if depth > 0 {
			cur.WriteByte(ch)
			continue
		}
		if ch == '\n' || (ch == '\r' && nx == '\n') {
			if ch == '\r' {
				i++
			}
			t := jsTrimRight(cur.String())
			if strings.HasSuffix(t, "\\") || strings.HasSuffix(t, "`") || strings.HasSuffix(t, "|") ||
				strings.HasPrefix(leftTrim(cmd[i+1:]), "|") {
				if strings.HasSuffix(t, "\\") || strings.HasSuffix(t, "`") {
					t = t[:len(t)-1]
				}
				cur.Reset()
				cur.WriteString(t + " ")
				continue
			}
			out = append(out, cur.String())
			cur.Reset()
			continue
		}
		if ch == ';' {
			out = append(out, cur.String())
			cur.Reset()
			continue
		}
		if (ch == '&' && nx == '&') || (ch == '|' && nx == '|') {
			out = append(out, cur.String())
			cur.Reset()
			i++
			continue
		}
		cur.WriteByte(ch)
	}
	out = append(out, cur.String())
	kept := out[:0]
	for _, x := range out {
		if x = jsTrim(x); x != "" {
			kept = append(kept, x)
		}
	}
	return kept
}

func leftTrim(s string) string { return strings.TrimLeftFunc(s, isJSSpace) }

// findTargetsFile: `find path/file.ext` checks that a file exists, it does not scan.
func findTargetsFile(stmt string) bool {
	m := reFindFile.FindStringSubmatch(stmt)
	if m == nil {
		return false
	}
	return reSrcExt.MatchString(strings.NewReplacer(`"`, "", `'`, "").Replace(m[1]))
}

// lsFilesBounded: git ls-files with a path, a status set (-o/-m/-d/-u/-k) or a cap on the pipe.
func lsFilesBounded(stmt string) bool {
	body := reLsPrefix.ReplaceAllString(stmt, "")
	body, _, _ = strings.Cut(body, "|")
	toks := jsFields(body)
	for _, t := range toks {
		if reLsStatus.MatchString(t) || (reLsShort.MatchString(t) && strings.ContainsAny(t, "omduk") && !strings.Contains(t, "s")) {
			return true
		}
	}
	for _, t := range toks {
		if !strings.HasPrefix(t, "-") && !reDotOnly.MatchString(t) {
			return true
		}
	}
	return reCapHints.MatchString(stmt)
}

// targetArg is the first argument that is not a flag after the command ('.' when there is none).
func targetArg(stmt, which string) string {
	rest := reCmdSplit[which].ReplaceAllString(stmt, "")
	rest = rest[:firstSeparator(rest)]
	for _, t := range jsFields(rest) {
		if !strings.HasPrefix(t, "-") && !strings.HasPrefix(t, "/") {
			return t
		}
	}
	return "."
}

func dumpRewrite(what, stmt string) string {
	switch what {
	case "Get-ChildItem -Recurse", "gci -r":
		return "Get-ChildItem " + targetArg(stmt, "dir") + " -Recurse -Filter *.ts | Select-Object -First 50"
	case "ls -R":
		return "ls " + targetArg(stmt, "ls") + " | head -50"
	case "dir /s":
		return `dir /s /b *.ts | findstr /i "<name fragment>"`
	case "find <path>":
		return "find " + targetArg(stmt, "find") + " -name '*.ts' | head -50"
	case "tree":
		return "tree -L 2 " + targetArg(stmt, "tree")
	case "findstr /s":
		return `Select-String -Path "src\*.ts" -Pattern "<text>" | Select-Object -First 50`
	case "rg --files":
		return "rg --files -g '*.ts' | head -50"
	case "fd":
		return "fd -e ts <name fragment>"
	}
	return stmt + " | head -50"
}

// grepSplit is the (command, arguments) of a search statement; ok is false when it does not parse.
func grepSplit(seg string) (cmd0, rest string, ok bool) {
	m := reGrepWords.FindStringSubmatch(jsTrim(seg))
	if m == nil {
		return "", "", false
	}
	return m[2], m[3], true
}

// grepFilesFirst is the same search, only the names of the files that match, capped.
func grepFilesFirst(seg string) string {
	cmd0, rest, ok := grepSplit(seg)
	if !ok {
		return `grep -rl "<text>" src | head -50`
	}
	return cmd0 + " -l " + jsTrim(rest[:firstSeparator(rest)]) + " | head -50"
}

// grepCapped is the same search, limited to a directory and with an output cap.
func grepCapped(seg string) string {
	cmd0, rest, ok := grepSplit(seg)
	if !ok {
		return `grep -rn "<text>" src | head -50`
	}
	toks := jsFields(rest[:firstSeparator(rest)])
	if len(toks) > 0 && reDotOnly.MatchString(toks[len(toks)-1]) {
		toks = toks[:len(toks)-1]
	} else if len(toks) == 0 {
		toks = nil
	}
	return cmd0 + " " + strings.Join(append(toks, "src"), " ") + " | head -50"
}

func ruleShellDump(c *ctx) *hit {
	if family(c.name) != "shell" {
		return nil
	}
	raw := inputCommand(c.input)
	if raw == "" {
		return nil
	}
	cmd := stripHeredocs(raw)

	repoFiles, haveStats := repoFileCount(c.stats)
	if haveStats && repoFiles < minRepoFilesForScan {
		return nil
	}

	if containsFold(cmd, "grep") || containsFold(cmd, "rg") {
		if loc := reGrepish.FindStringIndex(cmd); loc != nil && !(containsFold(cmd, "--files") && reRgFilesCmd.MatchString(cmd)) {
			if !reCapHints.MatchString(cmd) && grepUnbounded(cmd[loc[0]:], c.root) {
				return &hit{"shellDump",
					"token-guard/shellDump: content search from the repository root with no result cap. " +
						"The scan itself is cheap; the OUTPUT is what enters the context window.\n" +
						"DO THIS INSTEAD: (1) list the matching files first — `" + grepFilesFirst(cmd[loc[0]:]) + "` — " +
						"then re-run scoped to those paths; or (2) cap it now with a path argument and a pipe limit: `" + grepCapped(cmd[loc[0]:]) + "`.\n" +
						"(PT-BR) Busca por conteúdo a partir da raiz, sem teto de saída. Liste primeiro os arquivos " +
						"que casam e refaça restrito a eles, ou limite já com caminho-alvo e pipe (`| head -50`)."}
			}
			return nil
		}
	}

	stmts := statements(cmd)
	for _, st := range stmts {
		if reLsFiles.MatchString(st) {
			if !lsFilesBounded(st) {
				return &hit{"shellDump",
					"token-guard/shellDump: \"git ls-files\" with no path argument lists the whole tree.\n" +
						"DO THIS INSTEAD: scope it to what you actually need — `git ls-files src/` — or pipe it: `git ls-files | head -50`; to find a file by name: `git ls-files \"*Service*\"`.\n" +
						"(PT-BR) \"git ls-files\" sem caminho lista a árvore inteira. Escopoie (\"git ls-files src/\") ou limite (\"| head -50\")."}
			}
			return nil
		}
	}

	var found *dumpPattern
	hitStmt := ""
	for _, st := range stmts {
		var h *dumpPattern
		for i := range dumpPatterns {
			if dumpPatterns[i].test(st) {
				h = &dumpPatterns[i]
				break
			}
		}
		if h != nil && !reCapHints.MatchString(st) && !(h.what == "find <path>" && findTargetsFile(st)) {
			found, hitStmt = h, st
			break
		}
	}
	if found == nil {
		return nil
	}

	scale := "On a large repository this alone can exceed the entire context window."
	if haveStats && repoFiles != 0 {
		pathChars := 0.0
		if p := get(c.stats, "pathChars"); truthy(p) {
			pathChars = toNumber(p)
		}
		scale = "This repository has " + fmtPT(repoFiles) + " files; the raw listing alone is roughly " +
			fmtPT(jsRound(pathChars/charsPerToken)) + " tokens."
	}

	return &hit{"shellDump",
		"token-guard/shellDump: \"" + found.what + "\" walks the tree with no filter and no cap, and every line " +
			"it prints is billed as context. " + scale + "\n" +
			"DO THIS INSTEAD: (1) use the harness search tool instead of the shell — it respects ignore rules " +
			"and returns structured, bounded results (Glob pattern=\"**/*.ts\" paths=[\"src\"]); (2) if the shell is genuinely required, " +
			"run the capped form of your command: `" + dumpRewrite(found.what, hitStmt) + "`; " +
			"(3) for a whole-tree survey, run the audit — `npx @allansantos-dev/token-guard audit` (repo installs: " +
			"`node .github/token-guard/token-audit.cjs`) — which reports aggregates instead of dumping paths.\n" +
			"(PT-BR) \"" + found.what + "\" percorre a árvore sem filtro e sem teto, e cada linha impressa vira contexto. " +
			"Prefira a ferramenta de busca do harness; se precisar do shell, filtre por nome/extensão e limite " +
			"a saída (`| Select-Object -First 50` ou `| head -50`). " +
			"Para um panorama do repositório inteiro, rode `npx @allansantos-dev/token-guard audit`."}
}
