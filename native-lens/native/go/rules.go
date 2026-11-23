package main

// The noisePath, blindRead and broadScan rules and the tool-family helpers they share.

import (
	"os"
	"regexp"
	"strings"
)

type hit struct{ id, reason string }

type ctx struct {
	name  string
	input map[string]any
	root  string
	stats any
}

const (
	charsPerToken         = 4
	contextWindow         = 200000
	readBytesWithoutRange = 51200
	minRepoFilesForScan   = 400
)

var noiseDirs = []string{
	"node_modules", "target", "dist", "build", "out", ".git", ".svn", ".hg",
	"venv", ".venv", "env", "__pycache__", ".pytest_cache", ".mypy_cache",
	".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache",
	"vendor", "coverage", ".gradle", ".mvn", ".idea", ".vs", ".vscode-test",
	"bin", "obj", "Pods", "DerivedData", "bower_components", "jspm_packages",
	"instantclient", ".terraform", "site-packages", ".tox", ".nyc_output",
	".mcp-memory", ".token-guard", ".playwright-mcp", ".ruff_cache",
	"logs", "tmp", "temp", ".tmp",
}

var (
	depDirs = setOf("node_modules", "vendor", "bower_components", "jspm_packages", "site-packages", "venv", ".venv", "env", "pods", ".terraform", ".tox", "instantclient")
	vcsDirs = setOf(".git", ".svn", ".hg")
	logDirs = setOf("logs", "tmp", "temp", ".tmp", ".cache", ".playwright-mcp", ".mcp-memory", ".token-guard")
)

// The family patterns only ever see toolKey output, which is [a-z0-9_], so RE2 runs them as written.
var (
	famRead  = regexp.MustCompile(`^(view|read|read_file|readfile|cat_file|open_file|get_file_contents|str_replace_editor)$|(^|_)(read_file|read_media_file|read_text_file|read_multiple_files)$`)
	famGrep  = regexp.MustCompile(`(^|_)(grep|ripgrep|search_text|text_search|grep_search|search_in_files)($|_)`)
	famGlob  = regexp.MustCompile(`(^|_)(glob|file_search|find_files|list_dir|list_files|list_directory|listdirectory)($|_)`)
	famShell = regexp.MustCompile(`(^|_)(bash|sh|shell|zsh|powershell|pwsh|run_in_terminal|run_command|execute_command|terminal|run_shell)($|_)`)
)

var watched = []string{"view", "read", "grep", "glob", "search", "list_dir", "list_files", "list_director", "bash", "shell", "powershell", "pwsh", "terminal", "run_command", "execute_command", "find_files", "cat_file", "open_file", "ripgrep"}

func isWatched(name string) bool {
	for _, w := range watched {
		if containsFold(name, w) {
			return true
		}
	}
	return false
}

func toolKey(name string) string {
	var b strings.Builder
	for _, r := range jsLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		case r >= 0x10000:
			b.WriteString("__")
		default:
			b.WriteByte('_')
		}
	}
	return strings.Trim(b.String(), "_")
}

func family(name string) string {
	n := toolKey(name)
	switch {
	case famRead.MatchString(n):
		return "read"
	case famGrep.MatchString(n):
		return "grep"
	case famGlob.MatchString(n):
		return "glob"
	case famShell.MatchString(n):
		return "shell"
	}
	return ""
}

func normalize(p string) string { return strings.ReplaceAll(p, `\`, "/") }

func hitsNoise(p string) (string, bool) {
	var segs []string
	for _, s := range strings.Split(normalize(p), "/") {
		if s != "" {
			segs = append(segs, jsLower(s))
		}
	}
	for _, d := range noiseDirs {
		dd := jsLower(d)
		for _, s := range segs {
			if s == dd {
				return d, true
			}
		}
	}
	return "", false
}

var nameChars = regexp.MustCompile(`[A-Za-z0-9_-]{3,}`)

// hasNameFilter: the last glob segment carries a literal run of three or more characters.
func hasNameFilter(pattern string) bool {
	parts := strings.Split(normalize(pattern), "/")
	last := parts[len(parts)-1]
	last = strings.Map(func(r rune) rune {
		if strings.ContainsRune("*?[]{},", r) {
			return ' '
		}
		return r
	}, last)
	return nameChars.MatchString(last)
}

var (
	extTail      = regexp.MustCompile(`\.[A-Za-z0-9]{1,10}(?:\}|,|$)`)
	braceGroup   = regexp.MustCompile(`\{[^}]*\}`)
	extAlt       = regexp.MustCompile(`^\*?[A-Za-z0-9]{1,10}$`)
	rasterImage  = rx(`\.(png|jpe?g|gif|webp)$`)
	renderedRead = rx(`\.(png|jpe?g|gif|webp|pdf)$`)
	resultsDir   = rx(`(?:^|[\\/])\.token-guard[\\/]results[\\/]`)
)

func hasExtensionFilter(pattern string) bool {
	if extTail.MatchString(pattern) {
		return true
	}
	for _, g := range braceGroup.FindAllString(pattern, -1) {
		for _, alt := range strings.Split(g[1:len(g)-1], ",") {
			if extAlt.MatchString(jsTrim(alt)) {
				return true
			}
		}
	}
	return false
}

func isAnchored(pattern string) bool {
	p := normalize(pattern)
	p = strings.TrimPrefix(p, "./")
	return p != "" && p[0] != '*' && p[0] != '{'
}

func trimTrailingSlashes(s string) string { return strings.TrimRight(s, "/") }

func comparablePath(p string) string {
	return jsLower(trimTrailingSlashes(posixNormalize(normalize(p))))
}

var driveOnly = regexp.MustCompile(`^[A-Za-z]:$`)

func startsAbsolute(n string) bool {
	return strings.HasPrefix(n, "/") || (len(n) >= 3 && isLetterByte(n[0]) && n[1] == ':' && n[2] == '/')
}

// hasRealPathScope: the filesystem root, the payload cwd and any ancestor of it narrow nothing.
func hasRealPathScope(paths []string, root string) bool {
	r := ""
	if root != "" {
		r = comparablePath(root)
	}
	for _, p := range paths {
		n := normalize(p)
		if strings.HasPrefix(n, ".") {
			n = strings.TrimPrefix(n[1:], "/")
		}
		n = trimTrailingSlashes(n)
		if n == "" || n == "." || n == "/" || driveOnly.MatchString(n) {
			continue
		}
		if r == "" {
			return true
		}
		var abs string
		if startsAbsolute(n) {
			abs = comparablePath(n)
		} else {
			abs = comparablePath(r + "/" + n)
		}
		if abs != r && !strings.HasPrefix(r, abs+"/") {
			return true
		}
	}
	return false
}

func bytesHuman(b float64) string {
	switch {
	case b >= 1073741824:
		return strings.Replace(toFixed(b/1073741824, 2), ".", ",", 1) + " GB"
	case b >= 1048576:
		return strings.Replace(toFixed(b/1048576, 1), ".", ",", 1) + " MB"
	case b >= 1024:
		return numToString(jsRound(b/1024)) + " KB"
	}
	return numToString(b) + " B"
}

func isInside(child, parent string) bool {
	rel := win32Relative(parent, child)
	return !strings.HasPrefix(rel, "..") && !win32IsAbsolute(rel)
}

var binaryExts = setOf(
	"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "heic", "avif", "psd", "pdf",
	"doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
	"zip", "gz", "tgz", "tar", "7z", "rar", "xz", "bz2", "zst", "iso", "dmg", "msi", "jar", "war", "nupkg",
	"class", "exe", "dll", "so", "dylib", "bin", "wasm", "pyc", "o", "a", "lib", "obj", "pdb", "dmp", "pcap",
	"db", "sqlite", "sqlite3", "parquet", "h5", "npy", "pkl", "pt", "onnx", "safetensors",
	"mp3", "mp4", "mov", "avi", "mkv", "webm", "wav", "flac", "ogg", "m4a", "aac",
	"woff", "woff2", "ttf", "otf",
)

// isBinaryFile: the text ends in a dot and one of the known binary extensions.
func isBinaryFile(s string) bool {
	i := strings.LastIndexByte(s, '.')
	return i >= 0 && binaryExts[asciiLower(s[i+1:])]
}

func noiseAdvice(dir, target string) string {
	d := jsLower(dir)
	rel := normalize(target)
	bn := win32Basename(rel)
	stem := bn
	if i := strings.LastIndexByte(bn, '.'); i >= 0 {
		stem = bn[:i]
	}
	if stem == "" {
		stem = bn
	}
	binary := isBinaryFile(rel)
	switch {
	case depDirs[d]:
		return "DO THIS INSTEAD: (1) see how the project uses the dependency — search the project's own code for the import (Grep pattern=\"from '<package>'\" or \"require('<package>')\"), which shows the API actually used; " +
			"(2) for the API itself, read the package docs: `npm view <package> readme` (Python: `pip show <package>`); " +
			"(3) only if this exact file is required, add \"" + rel + "\" to \"allowlist\" in token-guard.config.json."
	case vcsDirs[d]:
		return "DO THIS INSTEAD: ask git, not the object store — `git log -n 5 --oneline -- <path>`, `git show HEAD:<path>`, `git diff`. " +
			"Files under " + dir + "/ are binary or packed and never useful as text."
	case logDirs[d] && !binary:
		return "DO THIS INSTEAD: read only the tail through the shell — `tail -n 100 \"" + rel + "\"` (PowerShell: `Get-Content \"" + rel + "\" -Tail 100`) — " +
			"or search it for the error you chase (`grep -n \"ERROR\" \"" + rel + "\" | tail -20`). If you need the file whole, add \"" + rel + "\" to \"allowlist\" in token-guard.config.json."
	}
	return "DO THIS INSTEAD: (1) find the source that generates it — Glob pattern=\"**/" + stem + ".*\" (the name filter keeps the answer to a few paths) — and read that source, not the artifact; " +
		"(2) if you need the compiled output's behavior, run it or its tests and read the result; " +
		"(3) only if this exact file is required, add \"" + rel + "\" to \"allowlist\" in token-guard.config.json."
}

func ruleNoisePath(c *ctx) *hit {
	targets := []string{}
	for _, t := range append([]string{inputPath(c.input)}, inputPaths(c.input)...) {
		if t != "" {
			targets = append(targets, t)
		}
	}
	reading := family(c.name) == "read"
	for _, t := range targets {
		if resultsDir.MatchString(t) {
			continue
		}
		probe := t
		if c.root != "" {
			abs := t
			if !win32IsAbsolute(t) {
				abs = win32Resolve(c.root, t)
			}
			rel := win32Relative(c.root, abs)
			if rel == "" || strings.HasPrefix(rel, "..") {
				continue
			}
			probe = rel
			tmp := tmpdir()
			if isInside(abs, tmp) && !isInside(c.root, tmp) {
				probe = win32Relative(tmp, abs)
			}
		}
		dir, found := hitsNoise(probe)
		if !found {
			continue
		}
		if reading && logDirs[jsLower(dir)] && renderedRead.MatchString(t) {
			continue
		}
		return &hit{"noisePath",
			"token-guard/noisePath: the path crosses \"" + dir + "\", a build/dependency directory. " +
				"Its contents are generated or vendored and never belong in context.\n" +
				noiseAdvice(dir, probe) + "\n" +
				"(PT-BR) O caminho passa por \"" + dir + "\" (build/dependência). " +
				"Leia a fonte que gera o artefato, não o artefato. " +
				"Se precisa mesmo deste arquivo, inclua o caminho em \"allowlist\" no token-guard.config.json."}
	}
	return nil
}

func ruleBlindRead(c *ctx) *hit {
	if family(c.name) != "read" {
		return nil
	}
	var targets []string
	if p := inputPath(c.input); p != "" {
		targets = []string{p}
	} else {
		targets = inputPaths(c.input)
	}
	for _, t := range targets {
		if h := blindReadOne(c, t); h != nil {
			return h
		}
	}
	return nil
}

func blindReadOne(c *ctx, target string) *hit {
	in := c.input
	ext := jsLower(win32Extname(target))
	notebook := ext == ".ipynb"
	var ranged bool
	switch {
	case notebook:
		ranged = isNonEmptyArray(in["view_range"])
	case ext == ".pdf":
		s, ok := in["pages"].(string)
		ranged = ok && jsTrim(s) != ""
	default:
		ranged = hasReadRange(in)
	}
	if ranged || target == "" {
		return nil
	}

	var abs string
	if win32IsAbsolute(target) {
		abs = win32Normalize(target)
	} else {
		abs = win32Resolve(c.root, target)
	}
	if rasterImage.MatchString(abs) {
		return nil
	}
	st, err := os.Stat(toNamespaced(abs))
	if err != nil || !st.Mode().IsRegular() {
		return nil
	}
	sizeBytes := float64(st.Size())
	if sizeBytes <= readBytesWithoutRange {
		return nil
	}

	base := win32Basename(target)
	size := bytesHuman(sizeBytes)

	if ext == ".pdf" {
		return &hit{"blindRead",
			"token-guard/blindRead: \"" + base + "\" is a " + size + " PDF requested with no \"pages\".\n" +
				"DO THIS INSTEAD: pass pages for the part you need (e.g. pages: \"1-5\"; at most 20 per call) — " +
				"start with the first pages or the table of contents to find where the content lives. " +
				"If this harness has no page parameter, convert first (pdftotext \"" + base + "\" out.txt) and read ranges of the text.\n" +
				"(PT-BR) \"" + base + "\" é um PDF de " + size + " pedido sem \"pages\". Passe pages com o trecho necessário " +
				"(ex.: pages: \"1-5\"; até 20 por chamada). Sem parâmetro de páginas, converta antes (pdftotext) e leia faixas do texto."}
	}

	tokens := jsRound(sizeBytes / charsPerToken)
	pctWindow := strings.Replace(toFixed(tokens/contextWindow*100, 1), ".", ",", 1)
	window := fmtPT(contextWindow)

	if isBinaryFile(base) {
		return &hit{"blindRead",
			"token-guard/blindRead: \"" + base + "\" is a " + size + " binary file — reading it as text costs ~" + fmtPT(tokens) + " tokens and shows nothing useful.\n" +
				"DO THIS INSTEAD: inspect it by format — `file \"" + base + "\"` says what it is; archives list their contents " +
				"(`unzip -l \"" + base + "\"`, `tar -tf \"" + base + "\"`); databases list their tables (`sqlite3 \"" + base + "\" \".tables\"`); " +
				"otherwise read the source or the command that produced it.\n" +
				"(PT-BR) \"" + base + "\" é um binário de " + size + ": lido como texto custa ~" + fmtPT(tokens) + " tokens e não mostra nada útil. " +
				"Inspecione pelo formato (file, unzip -l, tar -tf, sqlite3 .tables) ou leia a fonte que o gerou."}
	}

	if notebook {
		return &hit{"blindRead",
			"token-guard/blindRead: notebook \"" + base + "\" is " + size + " (~" + fmtPT(tokens) + " tokens, " + pctWindow + "% of a " +
				window + "-token window). Read loads notebooks whole — offset/limit are ignored.\n" +
				"DO THIS INSTEAD: (1) find the cell index — `jq -r '.cells | to_entries[] | select(.value.source | join(\"\")  | test(\"<text>\")) | .key' \"" + base + "\"`; " +
				"(2) extract only that cell — `jq -r '.cells[3].source | join(\"\")' \"" + base + "\"` " +
				"(no jq: `node -e \"const nb=JSON.parse(require('fs').readFileSync('" + base + "','utf8'));console.log(nb.cells[3].source.join(''))\"`). " +
				"Outputs (images, tables) are usually the bulk — skip them unless needed.\n" +
				"(PT-BR) O notebook \"" + base + "\" tem " + size + " (~" + fmtPT(tokens) + " tokens, " + pctWindow + "% da janela) e o Read " +
				"carrega notebook inteiro (ignora offset/limit). Localize as células com uma busca restrita ao arquivo " +
				"e extraia só essas células (node -e / jq)."}
	}

	return &hit{"blindRead",
		"token-guard/blindRead: \"" + base + "\" is " + size + " (~" + fmtPT(tokens) + " tokens, " +
			pctWindow + "% of a " + window + "-token window) and you requested it with no line range.\n" +
			"DO THIS INSTEAD: (1) find the line — Grep pattern=\"<symbol or text you need>\" path=\"" + target + "\" output_mode=\"content\" head_limit=20 " +
			"(shell: `grep -n \"<text>\" \"" + base + "\" | head -20`); " +
			"(2) read around the hit — Read file_path=\"" + target + "\" offset=<hit line - 20> limit=80 " +
			"(shell: `sed -n '<from>,<to>p' \"" + base + "\"`; PowerShell: `Get-Content \"" + base + "\" | Select-Object -Skip <from-1> -First 80`). " +
			"Most tasks need 40-80 lines, not the whole file. If you truly need a full pass, delegate it to a sub-agent so the bulk never " +
			"enters this window; import only its conclusion.\n" +
			"(PT-BR) \"" + base + "\" tem " + size + " (~" + fmtPT(tokens) + " tokens, " + pctWindow + "% da janela) " +
			"e foi pedido sem faixa de linhas. Localize o trecho com uma busca restrita a este arquivo e releia " +
			"só a faixa relevante. Se precisa varrer tudo, delegue a um sub-agente e traga só a conclusão."}
}

// repoFileCount is stats.totalFiles when it is a finite number.
func repoFileCount(stats any) (float64, bool) {
	if !truthy(stats) {
		return 0, false
	}
	return isFiniteNumber(get(stats, "totalFiles"))
}

func ruleBroadScan(c *ctx) *hit {
	fam := family(c.name)
	if fam != "glob" && fam != "grep" {
		return nil
	}
	repoFiles, haveStats := repoFileCount(c.stats)
	if haveStats && repoFiles < minRepoFilesForScan {
		return nil
	}

	pattern := inputPattern(c.input)
	paths := inputPaths(c.input)
	if pattern == "" {
		return nil
	}
	scoped := hasRealPathScope(paths, c.root)

	if fam == "glob" {
		if scoped || isAnchored(pattern) || hasExtensionFilter(pattern) || hasNameFilter(pattern) {
			return nil
		}
		scale, scalePT := "every file in the repository", "todo o repositório"
		if haveStats && repoFiles != 0 {
			scale = "about " + fmtPT(repoFiles) + " files"
			scalePT = fmtPT(repoFiles) + " arquivos"
		}
		return &hit{"broadScan",
			"token-guard/broadScan: the pattern \"" + pattern + "\" is unbounded in both breadth and type, " +
				"so it returns the path of " + scale + ". A bare file listing is pure overhead: it answers " +
				"\"what exists\", never \"where is the thing I need\".\n" +
				"DO THIS INSTEAD: bound it on at least one axis — " +
				"(a) by type: pattern=\"**/*.{ts,tsx,js}\" (or \"**/*.java\"); " +
				"(b) by directory: pattern=\"" + pattern + "\" with paths=[\"src\"]; " +
				"(c) by name: pattern=\"**/*Service*\" (a literal fragment of 3+ characters). " +
				"To find code by meaning rather than by filename, search content instead of listing paths: Grep pattern=\"<text>\" output_mode=\"files_with_matches\".\n" +
				"(PT-BR) O padrão \"" + pattern + "\" não limita nem escopo nem tipo: devolve o caminho de " +
				scalePT + ". " +
				"Limite por extensão (\"**/*.java\"), por diretório (paths=[\"src/...\"]) ou por nome (\"**/*Service*\")."}
	}

	modeSrc := c.input["output_mode"]
	if !truthy(modeSrc) {
		modeSrc = c.input["outputMode"]
	}
	mode := ""
	if truthy(modeSrc) {
		mode = jsLower(toStr(modeSrc))
	}
	if mode != "content" && !truthy(c.input["includeContent"]) {
		return nil
	}

	for _, k := range []string{"head_limit", "headLimit", "maxResults", "limit", "max_results"} {
		n := toNumber(c.input[k])
		if n == n && n-n == 0 && n > 0 {
			return nil
		}
	}

	if inputScopeFilter(c.input) != "" || scoped {
		return nil
	}

	q := jsQuote(pattern)
	return &hit{"broadScan",
		"token-guard/broadScan: content-mode search across the whole repository with no result cap " +
			"and no file filter. The scan itself is cheap; the OUTPUT is what enters the context window, " +
			"and here it is unbounded.\n" +
			"DO THIS INSTEAD: (1) run the same query as Grep pattern=" + q + " output_mode=\"files_with_matches\" first to see where " +
			"it lives — that answer is a handful of lines; then (2) re-run in content mode narrowed to one of those files: " +
			"Grep pattern=" + q + " output_mode=\"content\" path=\"<file from step 1>\" head_limit=50. " +
			"Or cap it now: add head_limit=50 and a file filter (glob=\"*.ts\" or type=\"ts\").\n" +
			"(PT-BR) Busca por conteúdo em todo o repositório, sem teto de resultado e sem filtro de arquivo. " +
			"O custo não é a varredura, é a SAÍDA que entra na janela. " +
			"Rode antes com output_mode=\"files_with_matches\" para descobrir onde está, depois volte em modo " +
			"conteúdo só nesses arquivos — ou aplique head_limit + filtro (glob/type) agora."}
}
