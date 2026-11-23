//! Port of `lib/rules.cjs`: the four context-economy rules (noisePath, blindRead, broadScan, shellDump) in
//! registry order, with the reason strings the agent follows.
//!
//! Regular expressions are compiled by `jsre` from the same source text as the JavaScript original. Places where a
//! RE2-style engine could not express the original, and which `jsre` therefore implements by hand:
//!   - lookahead in the `find`, `tree`, `rg --files`, `fd` and `gci -r` dump patterns;
//!   - backreferences `\1`/`\2` in `stripHeredocs`;
//!   - JavaScript `\s` (includes U+FEFF and U+00A0, excludes U+0085) and ASCII-only `/i` for ASCII patterns.
//! Case folding of paths and tool names uses `str::to_lowercase`, which maps characters like JavaScript's
//! `toLowerCase`. Windows semantics are fixed: paths fold case and accept both separators.

use crate::jsnum::{finite_positive, fmt_pt_br, is_js_ws, js_round, js_trim, to_fixed, to_js_string, to_number, ws_tokens};
use crate::jspath as path;
use crate::json::{quoted, Value};
use crate::jsre::{slice, to_chars, Match, Re};
use crate::payload as p;
use std::sync::OnceLock;

/// Effective configuration: `config.default.json` merged over nothing (no config file is read).
const READ_BYTES_WITHOUT_RANGE: f64 = 51200.0;
const MIN_REPO_FILES_FOR_SCAN_GUARD: f64 = 400.0;
const CHARS_PER_TOKEN: f64 = 4.0;
const CONTEXT_WINDOW: f64 = 200000.0;

const NOISE_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", "out", ".git", ".svn", ".hg", "venv", ".venv", "env", "__pycache__",
    ".pytest_cache", ".mypy_cache", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache", "vendor",
    "coverage", ".gradle", ".mvn", ".idea", ".vs", ".vscode-test", "bin", "obj", "Pods", "DerivedData",
    "bower_components", "jspm_packages", "instantclient", ".terraform", "site-packages", ".tox", ".nyc_output",
    ".mcp-memory", ".token-guard", ".playwright-mcp", ".ruff_cache", "logs", "tmp", "temp", ".tmp",
];
const DEP_DIRS: &[&str] = &["node_modules", "vendor", "bower_components", "jspm_packages", "site-packages", "venv", ".venv", "env", "pods", ".terraform", ".tox", "instantclient"];
const VCS_DIRS: &[&str] = &[".git", ".svn", ".hg"];
const LOG_DIRS: &[&str] = &["logs", "tmp", "temp", ".tmp", ".cache", ".playwright-mcp", ".mcp-memory", ".token-guard"];

const BINARY_EXT: &[&str] = &[
    "png", "jpe?g", "gif", "webp", "bmp", "ico", "tiff?", "heic", "avif", "psd", "pdf", "docx?", "xlsx?", "pptx?", "odt", "ods", "odp",
    "zip", "gz", "tgz", "tar", "7z", "rar", "xz", "bz2", "zst", "iso", "dmg", "msi", "jar", "war", "nupkg",
    "class", "exe", "dll", "so", "dylib", "bin", "wasm", "pyc", "o", "a", "lib", "obj", "pdb", "dmp", "pcap",
    "db", "sqlite3?", "parquet", "h5", "npy", "pkl", "pt", "onnx", "safetensors",
    "mp3", "mp4", "mov", "avi", "mkv", "webm", "wav", "flac", "ogg", "m4a", "aac", "woff2?", "ttf", "otf",
];

const ENV_PREFIX: &str = r#"(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+){0,6})"#;

const CAP_HINTS_SRC: &str = concat!(
    r"(>\s*[^\s|;&>]",
    r"|\|\s*(?:select-object|select-string|measure-object|sort-object|head|tail|wc|uniq|less|more|awk|sed|grep|findstr|rg)\b",
    r"|-first\s+\d|-totalcount\s+\d|\bhead\s+-n",
    r"|maxdepth[=\s]+\d|-L\s*\d|--level|\/l\b",
    r"|-m\s+\d|--max-count",
    r"|(?:^|\s)-name\s|(?:^|\s)-iname\s|(?:^|\s)-path\s|(?:^|\s)-regex\s",
    r"|(?:^|\s)-(?:newer[a-z]*|[acm]time|[acm]min|size|ipath|iregex|i?wholename|perm|user|group)\s|(?:^|\s)-empty\b",
    r"|(?:^|\s)-filter\s|\|\s*(?:where-object|where)\b|\|\s*\?\s*\{|(?:^|\s)-depth\s+\d",
    r"|\bselect-string\b",
    r"|--include|-include\b)"
);

/// Every compiled pattern of the rules, built once on first use.
pub struct Rx {
    pub watched: Re,
    fam_read: Re,
    fam_grep: Re,
    fam_glob: Re,
    fam_shell: Re,
    raster: Re,
    rendered: Re,
    binary: Re,
    results_dir: Re,
    ext_tail: Re,
    ext_group: Re,
    ext_alt: Re,
    drive_only: Re,
    abs_start: Re,
    dump: Vec<(Re, &'static str)>,
    grepish: Re,
    rg_files: Re,
    cap_hints: Re,
    heredoc: Re,
    find_target: Re,
    short_ext: Re,
    ls_cmd: Re,
    ls_strip: Re,
    cmd_gci: Re,
    cmd_ls: Re,
    cmd_find: Re,
    cmd_tree: Re,
    words: Re,
    search_stop: Re,
    long_flag: Re,
    regexp_file: Re,
    regexp_file_eq: Re,
    value_long: Re,
    short_flag: Re,
    env_assign: Re,
    pipe_sep: Re,
    grep_cmd: Re,
    rg_cmd: Re,
    recursive_short: Re,
    recursive_long: Re,
    grep_split: Re,
    dots: Re,
}

impl Rx {
    fn build() -> Rx {
        let i = |s: &str| Re::new(s, "i");
        let n = |s: &str| Re::new(s, "");
        let cmd_pos = format!("(?:^|[|;&]\\s*){ENV_PREFIX}");
        let dump = vec![
            (i(&format!(r"{cmd_pos}(?:get-childitem|gci|dir)\s[^|;&]*-recurse")), "Get-ChildItem -Recurse"),
            (i(&format!(r"{cmd_pos}(?:gci|dir)\s[^|;&]*-r(?=[\s|;&]|$)")), "gci -r"),
            (i(r"\bls\s+-[a-z]*r[a-z]*\b"), "ls -R"),
            (i(r"\bdir\s+\/s\b"), "dir /s"),
            (i(&format!(r#"{cmd_pos}find\s+(?!"|'|-)(?!\/[a-z]{{1,2}}(?:$|[\s"]))[^\s|;&]+"#)), "find <path>"),
            (i(&format!(r"{cmd_pos}tree\b(?![^|;&]*(?:-[lL][\s\/]\d*|-l\b|\/l|--level))")), "tree"),
            (i(r"\bfindstr\s+\/s"), "findstr /s"),
            (i(r"\brg\s+[^|;&]*--files\b(?![^|;&]*\|)"), "rg --files"),
            (i(&format!(r"{cmd_pos}(?:fd|fdfind)\b(?![^|;&]*(?:-e\s|--extension|-t\s|--type|-g\s|--glob))")), "fd"),
        ];
        Rx {
            watched: i(r"(view|read|grep|glob|search|list_dir|list_files|list_director|bash|shell|powershell|pwsh|terminal|run_command|execute_command|find_files|cat_file|open_file|ripgrep)"),
            fam_read: n(r"^(view|read|read_file|readfile|cat_file|open_file|get_file_contents|str_replace_editor)$|(^|_)(read_file|read_media_file|read_text_file|read_multiple_files)$"),
            fam_grep: n(r"(^|_)(grep|ripgrep|search_text|text_search|grep_search|search_in_files)($|_)"),
            fam_glob: n(r"(^|_)(glob|file_search|find_files|list_dir|list_files|list_directory|listdirectory)($|_)"),
            fam_shell: n(r"(^|_)(bash|sh|shell|zsh|powershell|pwsh|run_in_terminal|run_command|execute_command|terminal|run_shell)($|_)"),
            raster: i(r"\.(png|jpe?g|gif|webp)$"),
            rendered: i(r"\.(png|jpe?g|gif|webp|pdf)$"),
            binary: i(&format!(r"\.({})$", BINARY_EXT.join("|"))),
            results_dir: i(r"(?:^|[\\/])\.token-guard[\\/]results[\\/]"),
            ext_tail: i(r"\.[a-z0-9]{1,10}(?:\}|,|$)"),
            ext_group: n(r"\{[^}]*\}"),
            ext_alt: i(r"^\*?[a-z0-9]{1,10}$"),
            drive_only: i(r"^[a-z]:$"),
            abs_start: i(r"^(?:\/|[a-z]:\/)"),
            dump,
            grepish: i(&format!(r"(?:^|[|;&]\s*){ENV_PREFIX}(?:[\w.-]+[\\/])?(?:grep|egrep|fgrep|rg)\b")),
            rg_files: i(r"\brg\s+[^|;&]*--files\b"),
            cap_hints: i(CAP_HINTS_SRC),
            heredoc: n(r#"<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\r?\n|$)"#),
            find_target: i(r#"\bfind\s+("[^"]+"|'[^']+'|\S+)"#),
            short_ext: n(r"\.[A-Za-z0-9]{1,8}$"),
            ls_cmd: i(&format!(r"^{ENV_PREFIX}git\s+ls-files\b")),
            ls_strip: i(r"^.*?\bgit\s+ls-files\b"),
            cmd_gci: i(r"^.*?(?:get-childitem|gci|dir)\b"),
            cmd_ls: i(r"^.*?\bls\b"),
            cmd_find: i(r"^.*?\bfind\b"),
            cmd_tree: i(r"^.*?\btree\b"),
            words: n(r#""((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)"#),
            search_stop: n(r"^(?:[|;&]+|\d*>.*|<.*)$"),
            long_flag: i(r"^--[a-z]"),
            regexp_file: n(r"^--(?:regexp|file)$"),
            regexp_file_eq: n(r"^--(?:regexp|file)="),
            value_long: n(r"^--(?:max-count|after-context|before-context|context|include|exclude|exclude-dir|glob|iglob|type|type-not|max-columns|threads|max-depth|replace|colors?|encoding)$"),
            short_flag: n(r"^-[A-Za-z]+$"),
            env_assign: n(r"^[A-Za-z_][A-Za-z0-9_]*="),
            pipe_sep: n(r"^[|;&]$"),
            grep_cmd: i(r"^(?:[\w.-]+[\\/])?(?:grep|egrep|fgrep|rg)$"),
            rg_cmd: i(r"(?:^|[\\/])rg$"),
            recursive_short: n(r"^-[A-Za-z]*[rR][A-Za-z]*$"),
            recursive_long: n(r"^--(?:dereference-)?recursive$"),
            grep_split: i(r"^((?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)((?:[\w.-]+[\\/])?(?:grep|egrep|fgrep|rg))\b\s*(.*)$"),
            dots: n(r"^\.{1,2}\/?$"),
        }
    }

    /// Name and compiled form of every pattern, for the equivalence test against the JavaScript sources.
    #[cfg(test)]
    pub fn named(&self) -> Vec<(&'static str, &Re)> {
        let mut v: Vec<(&'static str, &Re)> = vec![
            ("watched", &self.watched), ("fam_read", &self.fam_read), ("fam_grep", &self.fam_grep), ("fam_glob", &self.fam_glob),
            ("fam_shell", &self.fam_shell), ("raster", &self.raster), ("rendered", &self.rendered), ("binary", &self.binary),
            ("results_dir", &self.results_dir), ("ext_tail", &self.ext_tail), ("ext_group", &self.ext_group),
            ("ext_alt", &self.ext_alt), ("drive_only", &self.drive_only), ("abs_start", &self.abs_start), ("grepish", &self.grepish),
            ("rg_files", &self.rg_files), ("cap_hints", &self.cap_hints), ("heredoc", &self.heredoc), ("find_target", &self.find_target),
            ("short_ext", &self.short_ext), ("ls_cmd", &self.ls_cmd), ("ls_strip", &self.ls_strip), ("cmd_gci", &self.cmd_gci),
            ("cmd_ls", &self.cmd_ls), ("cmd_find", &self.cmd_find), ("cmd_tree", &self.cmd_tree), ("words", &self.words),
            ("search_stop", &self.search_stop), ("long_flag", &self.long_flag), ("regexp_file", &self.regexp_file),
            ("regexp_file_eq", &self.regexp_file_eq), ("value_long", &self.value_long), ("short_flag", &self.short_flag),
            ("env_assign", &self.env_assign), ("pipe_sep", &self.pipe_sep), ("grep_cmd", &self.grep_cmd), ("rg_cmd", &self.rg_cmd),
            ("recursive_short", &self.recursive_short), ("recursive_long", &self.recursive_long), ("grep_split", &self.grep_split),
            ("dots", &self.dots),
        ];
        for (k, (re, _)) in self.dump.iter().enumerate() {
            let name: &'static str = ["dump0", "dump1", "dump2", "dump3", "dump4", "dump5", "dump6", "dump7", "dump8"][k];
            v.push((name, re));
        }
        v
    }
}

/// The shared compiled patterns.
pub fn rx() -> &'static Rx {
    static R: OnceLock<Rx> = OnceLock::new();
    R.get_or_init(Rx::build)
}

/// Repository statistics cache: `None` for a missing or unreadable file or a falsy JSON value.
pub type Stats = Option<Value>;

/// Everything a rule reads.
pub struct Ctx<'a> {
    pub name: &'a str,
    pub input: &'a Value,
    pub root: &'a str,
    pub stats: &'a Stats,
}

/// A deny: the rule id and the reason (before the "dica" suffix).
pub struct Hit {
    pub id: &'static str,
    pub reason: String,
}

#[derive(PartialEq, Clone, Copy)]
enum Fam {
    Read,
    Grep,
    Glob,
    Shell,
}

fn tool_key(name: &str) -> String {
    let mut s = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' {
            s.push(c);
        } else {
            (0..c.len_utf16()).for_each(|_| s.push('_'));
        }
    }
    s.trim_matches('_').to_string()
}

fn family(name: &str) -> Option<Fam> {
    let r = rx();
    let k = to_chars(&tool_key(name));
    if r.fam_read.test(&k) {
        Some(Fam::Read)
    } else if r.fam_grep.test(&k) {
        Some(Fam::Grep)
    } else if r.fam_glob.test(&k) {
        Some(Fam::Glob)
    } else if r.fam_shell.test(&k) {
        Some(Fam::Shell)
    } else {
        None
    }
}

fn slashes(s: &str) -> String {
    s.replace('\\', "/")
}

fn hits_noise(probe: &str) -> Option<&'static str> {
    let low: Vec<String> = slashes(probe).split('/').filter(|s| !s.is_empty()).map(str::to_lowercase).collect();
    NOISE_DIRS.iter().copied().find(|d| low.iter().any(|s| *s == d.to_lowercase()))
}

fn has_name_filter(pattern: &str) -> bool {
    let n = slashes(pattern);
    let last = n.rsplit('/').next().unwrap_or("");
    let mut run = 0;
    for c in last.chars() {
        let literal = !"*?[]{},".contains(c) && (c.is_ascii_alphanumeric() || c == '_' || c == '-');
        run = if literal { run + 1 } else { 0 };
        if run >= 3 {
            return true;
        }
    }
    false
}

fn has_extension_filter(pattern: &str) -> bool {
    let r = rx();
    let cs = to_chars(pattern);
    if r.ext_tail.test(&cs) {
        return true;
    }
    r.ext_group.find_all(&cs).iter().any(|m| {
        let (a, b) = m[0].unwrap_or((0, 0));
        let inner = slice(&cs, a + 1, b.saturating_sub(1));
        inner.split(',').any(|alt| r.ext_alt.test_str(js_trim(alt)))
    })
}

fn is_anchored(pattern: &str) -> bool {
    let n = slashes(pattern);
    let n = n.strip_prefix("./").unwrap_or(&n);
    !n.is_empty() && !n.starts_with(['*', '{'])
}

fn comparable_path(s: &str) -> String {
    path::posix_normalize(&slashes(s)).trim_end_matches('/').to_lowercase()
}

fn has_real_path_scope(paths: &[String], root: &str) -> bool {
    let r = comparable_path(root);
    let rx = rx();
    paths.iter().any(|raw| {
        let n = slashes(raw);
        let n = match n.strip_prefix('.') {
            Some(rest) => rest.strip_prefix('/').unwrap_or(rest),
            None => n.as_str(),
        };
        let n = n.trim_end_matches('/');
        if n.is_empty() || n == "." || n == "/" || rx.drive_only.test_str(n) {
            return false;
        }
        let abs = comparable_path(&if rx.abs_start.test_str(n) { n.to_string() } else { format!("{r}/{n}") });
        abs != r && !r.starts_with(&format!("{abs}/"))
    })
}

fn bytes_human(b: f64) -> String {
    if b >= 1073741824.0 {
        format!("{} GB", to_fixed(b / 1073741824.0, 2).replace('.', ","))
    } else if b >= 1048576.0 {
        format!("{} MB", to_fixed(b / 1048576.0, 1).replace('.', ","))
    } else if b >= 1024.0 {
        format!("{} KB", js_round(b / 1024.0))
    } else {
        format!("{b} B")
    }
}

fn is_inside(child: &str, parent: &str) -> bool {
    let rel = path::relative(parent, child);
    !rel.starts_with("..") && !path::is_absolute(&rel)
}

fn repo_files(stats: &Stats) -> Option<f64> {
    match stats.as_ref().and_then(|s| s.get("totalFiles")) {
        Some(Value::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

fn noise_advice(dir: &str, target: &str) -> String {
    let d = dir.to_lowercase();
    let rel = slashes(target);
    let base = path::basename(&rel);
    let stem = match base.rfind('.') {
        Some(at) if !base[..at].is_empty() => base[..at].to_string(),
        _ => base.clone(),
    };
    let binary = rx().binary.test_str(&rel);
    if DEP_DIRS.contains(&d.as_str()) {
        return format!(
            "DO THIS INSTEAD: (1) see how the project uses the dependency \u{2014} search the project's own code for the import (Grep pattern=\"from '<package>'\" or \"require('<package>')\"), which shows the API actually used; \
(2) for the API itself, read the package docs: `npm view <package> readme` (Python: `pip show <package>`); \
(3) only if this exact file is required, add \"{rel}\" to \"allowlist\" in token-guard.config.json."
        );
    }
    if VCS_DIRS.contains(&d.as_str()) {
        return format!(
            "DO THIS INSTEAD: ask git, not the object store \u{2014} `git log -n 5 --oneline -- <path>`, `git show HEAD:<path>`, `git diff`. \
Files under {dir}/ are binary or packed and never useful as text."
        );
    }
    if LOG_DIRS.contains(&d.as_str()) && !binary {
        return format!(
            "DO THIS INSTEAD: read only the tail through the shell \u{2014} `tail -n 100 \"{rel}\"` (PowerShell: `Get-Content \"{rel}\" -Tail 100`) \u{2014} \
or search it for the error you chase (`grep -n \"ERROR\" \"{rel}\" | tail -20`). If you need the file whole, add \"{rel}\" to \"allowlist\" in token-guard.config.json."
        );
    }
    format!(
        "DO THIS INSTEAD: (1) find the source that generates it \u{2014} Glob pattern=\"**/{stem}.*\" (the name filter keeps the answer to a few paths) \u{2014} and read that source, not the artifact; \
(2) if you need the compiled output's behavior, run it or its tests and read the result; \
(3) only if this exact file is required, add \"{rel}\" to \"allowlist\" in token-guard.config.json."
    )
}

fn rule_noise_path(ctx: &Ctx) -> Option<Hit> {
    let r = rx();
    let mut targets = vec![p::input_path(ctx.input)];
    targets.extend(p::input_paths(ctx.input));
    let reading = family(ctx.name) == Some(Fam::Read);
    for t in targets.iter().filter(|t| !t.is_empty()) {
        if r.results_dir.test_str(t) {
            continue;
        }
        let abs = if path::is_absolute(t) { t.clone() } else { path::resolve(&[ctx.root, t.as_str()]) };
        let rel = path::relative(ctx.root, &abs);
        if rel.is_empty() || rel.starts_with("..") {
            continue;
        }
        let mut probe = rel;
        let tmp = path::tmpdir();
        if is_inside(&abs, &tmp) && !is_inside(ctx.root, &tmp) {
            probe = path::relative(&tmp, &abs);
        }
        let Some(dir) = hits_noise(&probe) else { continue };
        if reading && LOG_DIRS.contains(&dir.to_lowercase().as_str()) && r.rendered.test_str(t) {
            continue;
        }
        return Some(Hit {
            id: "noisePath",
            reason: format!(
                "token-guard/noisePath: the path crosses \"{dir}\", a build/dependency directory. \
Its contents are generated or vendored and never belong in context.\n\
{}\n\
(PT-BR) O caminho passa por \"{dir}\" (build/depend\u{ea}ncia). \
Leia a fonte que gera o artefato, n\u{e3}o o artefato. \
Se precisa mesmo deste arquivo, inclua o caminho em \"allowlist\" no token-guard.config.json.",
                noise_advice(dir, &probe)
            ),
        });
    }
    None
}

fn rule_blind_read(ctx: &Ctx) -> Option<Hit> {
    if family(ctx.name) != Some(Fam::Read) {
        return None;
    }
    let single = p::input_path(ctx.input);
    let targets = if single.is_empty() { p::input_paths(ctx.input) } else { vec![single] };
    targets.iter().find_map(|t| blind_read_one(ctx, t))
}

fn blind_read_one(ctx: &Ctx, target: &str) -> Option<Hit> {
    let r = rx();
    let input = ctx.input;
    let ext = path::extname(target).to_lowercase();
    let notebook = ext == ".ipynb";
    let ranged = if notebook {
        p::non_empty_array(input.get("view_range"))
    } else if ext == ".pdf" {
        p::non_blank_string(input.get("pages"))
    } else {
        p::has_read_range(input)
    };
    if ranged || target.is_empty() {
        return None;
    }
    let abs = if path::is_absolute(target) { path::normalize(target) } else { path::resolve(&[ctx.root, target]) };
    if r.raster.test_str(&abs) {
        return None;
    }
    let md = std::fs::metadata(&abs).ok()?;
    if !md.is_file() {
        return None;
    }
    let bytes = md.len() as f64;
    if bytes <= READ_BYTES_WITHOUT_RANGE {
        return None;
    }
    let base = path::basename(target);
    let size = bytes_human(bytes);

    if ext == ".pdf" {
        return Some(Hit {
            id: "blindRead",
            reason: format!(
                "token-guard/blindRead: \"{base}\" is a {size} PDF requested with no \"pages\".\n\
DO THIS INSTEAD: pass pages for the part you need (e.g. pages: \"1-5\"; at most 20 per call) \u{2014} \
start with the first pages or the table of contents to find where the content lives. \
If this harness has no page parameter, convert first (pdftotext \"{base}\" out.txt) and read ranges of the text.\n\
(PT-BR) \"{base}\" \u{e9} um PDF de {size} pedido sem \"pages\". Passe pages com o trecho necess\u{e1}rio \
(ex.: pages: \"1-5\"; at\u{e9} 20 por chamada). Sem par\u{e2}metro de p\u{e1}ginas, converta antes (pdftotext) e leia faixas do texto."
            ),
        });
    }

    let tokens = js_round(bytes / CHARS_PER_TOKEN);
    let pct_window = to_fixed(tokens / CONTEXT_WINDOW * 100.0, 1).replace('.', ",");
    let tok = fmt_pt_br(tokens);
    let window = fmt_pt_br(CONTEXT_WINDOW);

    if r.binary.test_str(&base) {
        return Some(Hit {
            id: "blindRead",
            reason: format!(
                "token-guard/blindRead: \"{base}\" is a {size} binary file \u{2014} reading it as text costs ~{tok} tokens and shows nothing useful.\n\
DO THIS INSTEAD: inspect it by format \u{2014} `file \"{base}\"` says what it is; archives list their contents \
(`unzip -l \"{base}\"`, `tar -tf \"{base}\"`); databases list their tables (`sqlite3 \"{base}\" \".tables\"`); \
otherwise read the source or the command that produced it.\n\
(PT-BR) \"{base}\" \u{e9} um bin\u{e1}rio de {size}: lido como texto custa ~{tok} tokens e n\u{e3}o mostra nada \u{fa}til. \
Inspecione pelo formato (file, unzip -l, tar -tf, sqlite3 .tables) ou leia a fonte que o gerou."
            ),
        });
    }

    if notebook {
        return Some(Hit {
            id: "blindRead",
            reason: format!(
                "token-guard/blindRead: notebook \"{base}\" is {size} (~{tok} tokens, {pct_window}% of a \
{window}-token window). Read loads notebooks whole \u{2014} offset/limit are ignored.\n\
DO THIS INSTEAD: (1) find the cell index \u{2014} `jq -r '.cells | to_entries[] | select(.value.source | join(\"\")  | test(\"<text>\")) | .key' \"{base}\"`; \
(2) extract only that cell \u{2014} `jq -r '.cells[3].source | join(\"\")' \"{base}\"` \
(no jq: `node -e \"const nb=JSON.parse(require('fs').readFileSync('{base}','utf8'));console.log(nb.cells[3].source.join(''))\"`). \
Outputs (images, tables) are usually the bulk \u{2014} skip them unless needed.\n\
(PT-BR) O notebook \"{base}\" tem {size} (~{tok} tokens, {pct_window}% da janela) e o Read \
carrega notebook inteiro (ignora offset/limit). Localize as c\u{e9}lulas com uma busca restrita ao arquivo \
e extraia s\u{f3} essas c\u{e9}lulas (node -e / jq)."
            ),
        });
    }

    Some(Hit {
        id: "blindRead",
        reason: format!(
            "token-guard/blindRead: \"{base}\" is {size} (~{tok} tokens, \
{pct_window}% of a {window}-token window) and you requested it with no line range.\n\
DO THIS INSTEAD: (1) find the line \u{2014} Grep pattern=\"<symbol or text you need>\" path=\"{target}\" output_mode=\"content\" head_limit=20 \
(shell: `grep -n \"<text>\" \"{base}\" | head -20`); \
(2) read around the hit \u{2014} Read file_path=\"{target}\" offset=<hit line - 20> limit=80 \
(shell: `sed -n '<from>,<to>p' \"{base}\"`; PowerShell: `Get-Content \"{base}\" | Select-Object -Skip <from-1> -First 80`). \
Most tasks need 40-80 lines, not the whole file. If you truly need a full pass, delegate it to a sub-agent so the bulk never \
enters this window; import only its conclusion.\n\
(PT-BR) \"{base}\" tem {size} (~{tok} tokens, {pct_window}% da janela) \
e foi pedido sem faixa de linhas. Localize o trecho com uma busca restrita a este arquivo e releia \
s\u{f3} a faixa relevante. Se precisa varrer tudo, delegue a um sub-agente e traga s\u{f3} a conclus\u{e3}o."
        ),
    })
}

fn rule_broad_scan(ctx: &Ctx) -> Option<Hit> {
    let fam = family(ctx.name)?;
    if fam != Fam::Glob && fam != Fam::Grep {
        return None;
    }
    let files = repo_files(ctx.stats);
    if files.is_some_and(|n| n < MIN_REPO_FILES_FOR_SCAN_GUARD) {
        return None;
    }
    let pattern = p::input_pattern(ctx.input);
    let paths = p::input_paths(ctx.input);
    if pattern.is_empty() {
        return None;
    }
    let scoped = has_real_path_scope(&paths, ctx.root);

    if fam == Fam::Glob {
        if scoped || is_anchored(&pattern) || has_extension_filter(&pattern) || has_name_filter(&pattern) {
            return None;
        }
        let scale = match files {
            Some(n) if n != 0.0 => format!("about {} files", fmt_pt_br(n)),
            _ => "every file in the repository".to_string(),
        };
        let scale_pt = match files {
            Some(n) if n != 0.0 => format!("{} arquivos", fmt_pt_br(n)),
            _ => "todo o reposit\u{f3}rio".to_string(),
        };
        return Some(Hit {
            id: "broadScan",
            reason: format!(
                "token-guard/broadScan: the pattern \"{pattern}\" is unbounded in both breadth and type, \
so it returns the path of {scale}. A bare file listing is pure overhead: it answers \
\"what exists\", never \"where is the thing I need\".\n\
DO THIS INSTEAD: bound it on at least one axis \u{2014} \
(a) by type: pattern=\"**/*.{{ts,tsx,js}}\" (or \"**/*.java\"); \
(b) by directory: pattern=\"{pattern}\" with paths=[\"src\"]; \
(c) by name: pattern=\"**/*Service*\" (a literal fragment of 3+ characters). \
To find code by meaning rather than by filename, search content instead of listing paths: Grep pattern=\"<text>\" output_mode=\"files_with_matches\".\n\
(PT-BR) O padr\u{e3}o \"{pattern}\" n\u{e3}o limita nem escopo nem tipo: devolve o caminho de \
{scale_pt}. \
Limite por extens\u{e3}o (\"**/*.java\"), por diret\u{f3}rio (paths=[\"src/...\"]) ou por nome (\"**/*Service*\")."
            ),
        });
    }

    let input = ctx.input;
    let mode_src = [input.get("output_mode"), input.get("outputMode")].into_iter().flatten().find(|v| v.truthy());
    let mode = mode_src.map(to_js_string).unwrap_or_default().to_lowercase();
    let wants_content = mode == "content" || input.get("includeContent").is_some_and(Value::truthy);
    if !wants_content {
        return None;
    }
    let capped = ["head_limit", "headLimit", "maxResults", "limit", "max_results"].iter().any(|k| finite_positive(to_number(input.get(k))));
    if capped {
        return None;
    }
    if !p::input_scope_filter(input).is_empty() || scoped {
        return None;
    }
    let q = quoted(&pattern);
    Some(Hit {
        id: "broadScan",
        reason: format!(
            "token-guard/broadScan: content-mode search across the whole repository with no result cap \
and no file filter. The scan itself is cheap; the OUTPUT is what enters the context window, \
and here it is unbounded.\n\
DO THIS INSTEAD: (1) run the same query as Grep pattern={q} output_mode=\"files_with_matches\" first to see where \
it lives \u{2014} that answer is a handful of lines; then (2) re-run in content mode narrowed to one of those files: \
Grep pattern={q} output_mode=\"content\" path=\"<file from step 1>\" head_limit=50. \
Or cap it now: add head_limit=50 and a file filter (glob=\"*.ts\" or type=\"ts\").\n\
(PT-BR) Busca por conte\u{fa}do em todo o reposit\u{f3}rio, sem teto de resultado e sem filtro de arquivo. \
O custo n\u{e3}o \u{e9} a varredura, \u{e9} a SA\u{cd}DA que entra na janela. \
Rode antes com output_mode=\"files_with_matches\" para descobrir onde est\u{e1}, depois volte em modo \
conte\u{fa}do s\u{f3} nesses arquivos \u{2014} ou aplique head_limit + filtro (glob/type) agora."
        ),
    })
}

/// Words of a shell line, keeping quoted text together (`rg "a b" src` has two arguments).
fn shell_words(seg: &str) -> Vec<String> {
    let cs = to_chars(seg);
    rx().words
        .find_all(&cs)
        .iter()
        .map(|m: &Match| {
            let grp = |k: usize| m.get(k).copied().flatten().map(|(a, b)| slice(&cs, a, b));
            grp(1).or_else(|| grp(2)).or_else(|| grp(3)).unwrap_or_default()
        })
        .collect()
}

const VALUE_SHORT_GREP: &str = "efmABCdD";
const VALUE_SHORT_RG: &str = "efgtTmABCjMEdr";

/// Folders a search walks: the positional arguments minus the pattern (the first one, unless `-e`/`-f` carry it).
fn search_paths(is_rg: bool, words: &[String]) -> Vec<String> {
    let r = rx();
    let value_short = if is_rg { VALUE_SHORT_RG } else { VALUE_SHORT_GREP };
    let mut positional: Vec<String> = Vec::new();
    let mut pattern_by_flag = false;
    let mut k = 0;
    while k < words.len() {
        let w = &words[k];
        let cs = to_chars(w);
        if r.search_stop.test(&cs) {
            break;
        }
        if w == "--" {
            positional.extend(words[k + 1..].iter().cloned());
            break;
        }
        if r.long_flag.test(&cs) {
            if r.regexp_file.test(&cs) {
                pattern_by_flag = true;
                k += 1;
            } else if r.regexp_file_eq.test(&cs) {
                pattern_by_flag = true;
            } else if r.value_long.test(&cs) {
                k += 1;
            }
            k += 1;
            continue;
        }
        if r.short_flag.test(&cs) {
            let last = cs[cs.len() - 1];
            if value_short.contains(last) {
                if last == 'e' || last == 'f' {
                    pattern_by_flag = true;
                }
                k += 1;
            }
            k += 1;
            continue;
        }
        if w.starts_with('-') && cs.len() > 1 {
            k += 1;
            continue;
        }
        positional.push(w.clone());
        k += 1;
    }
    if pattern_by_flag {
        positional
    } else {
        positional.into_iter().skip(1).collect()
    }
}

/// True when the search starting at `seg` is an unbounded dump (recursive, no real scope, not fed by a pipe).
fn grep_unbounded(seg: &str, root: &str) -> bool {
    let r = rx();
    let toks = shell_words(js_trim(seg));
    let mut i = 0;
    let mut piped = false;
    while i < toks.len() && (r.env_assign.test_str(&toks[i]) || r.pipe_sep.test_str(&toks[i])) {
        if toks[i] == "|" {
            piped = true;
        }
        i += 1;
    }
    let Some(cmd0) = toks.get(i) else { return false };
    if !r.grep_cmd.test_str(cmd0) {
        return false;
    }
    let is_rg = r.rg_cmd.test_str(cmd0);
    let rest = &toks[i + 1..];
    let recursive = is_rg || rest.iter().filter(|t| t.starts_with('-')).any(|f| r.recursive_short.test_str(f) || r.recursive_long.test_str(f));
    if !recursive {
        return false;
    }
    let paths = search_paths(is_rg, rest);
    if paths.is_empty() {
        return !piped;
    }
    paths.iter().all(|x| !has_real_path_scope(std::slice::from_ref(x), root))
}

/// Heredoc bodies are data, not commands: only the line that opens one stays.
fn strip_heredocs(cmd: &str) -> String {
    let cs = to_chars(cmd);
    let ms = rx().heredoc.find_all(&cs);
    if ms.is_empty() {
        return cmd.to_string();
    }
    let mut out = String::new();
    let mut last = 0;
    for m in &ms {
        let (a, b) = m[0].unwrap_or((0, 0));
        out.push_str(&slice(&cs, last, a));
        let nl = cs[a..b].iter().position(|&c| c == '\n').unwrap_or(b - a);
        out.push_str(&slice(&cs, a, a + nl));
        last = b;
    }
    out.push_str(&slice(&cs, last, cs.len()));
    out
}

fn rtrim_ws(s: &str) -> &str {
    s.trim_end_matches(is_js_ws)
}

/// Independent commands of the line: split on newline, `;`, `&&`, `||`, never inside quotes or a PowerShell `{ }` block,
/// and never across a continued line (`\` or backtick at the end, or a pipe at either side of the break).
fn statements(cmd: &str) -> Vec<String> {
    let c = to_chars(cmd);
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut depth = 0usize;
    let mut i = 0usize;
    while i < c.len() {
        let ch = c[i];
        let nx = c.get(i + 1).copied();
        let prev = if i > 0 { Some(c[i - 1]) } else { None };
        if let Some(q) = quote {
            cur.push(ch);
            if ch == q && !(q == '"' && prev == Some('\\')) {
                quote = None;
            }
            i += 1;
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            cur.push(ch);
            i += 1;
            continue;
        }
        if ch == '{' {
            depth += 1;
        }
        if ch == '}' && depth > 0 {
            depth -= 1;
        }
        if depth > 0 {
            cur.push(ch);
            i += 1;
            continue;
        }
        if ch == '\n' || (ch == '\r' && nx == Some('\n')) {
            if ch == '\r' {
                i += 1;
            }
            let t = rtrim_ws(&cur).to_string();
            let after: String = c[(i + 1).min(c.len())..].iter().collect();
            let continued = t.ends_with(['\\', '`', '|']) || js_trim_start_is_pipe(&after);
            if continued {
                let mut t2 = t;
                if t2.ends_with(['\\', '`']) {
                    t2.pop();
                }
                cur = format!("{t2} ");
                i += 1;
                continue;
            }
            out.push(std::mem::take(&mut cur));
            i += 1;
            continue;
        }
        if ch == ';' {
            out.push(std::mem::take(&mut cur));
            i += 1;
            continue;
        }
        if (ch == '&' && nx == Some('&')) || (ch == '|' && nx == Some('|')) {
            out.push(std::mem::take(&mut cur));
            i += 2;
            continue;
        }
        cur.push(ch);
        i += 1;
    }
    out.push(cur);
    out.iter().map(|x| js_trim(x).to_string()).filter(|x| !x.is_empty()).collect()
}

/// `/^\s*\|/.test(s)`.
fn js_trim_start_is_pipe(s: &str) -> bool {
    s.trim_start_matches(is_js_ws).starts_with('|')
}

/// `find path/file.ext` is an existence check, not a walk.
fn find_targets_file(stmt: &str) -> bool {
    let r = rx();
    let cs = to_chars(stmt);
    let Some(m) = r.find_target.exec(&cs, 0) else { return false };
    let Some((a, b)) = m.get(1).copied().flatten() else { return false };
    let target: String = slice(&cs, a, b).chars().filter(|c| *c != '"' && *c != '\'').collect();
    r.short_ext.test_str(&target)
}

/// `git ls-files` limited by a path, a status set (-o/-m/-d/-u/-k) or an output cap.
fn ls_files_bounded(stmt: &str) -> bool {
    let r = rx();
    let cs = to_chars(stmt);
    let rest = match r.ls_strip.exec(&cs, 0) {
        Some(m) => slice(&cs, m[0].map_or(0, |x| x.1), cs.len()),
        None => stmt.to_string(),
    };
    let head = rest.split('|').next().unwrap_or("");
    let toks = ws_tokens(head);
    let status_set = |t: &str| {
        let long = ["--others", "--modified", "--deleted", "--unmerged", "--killed"].contains(&t);
        let short = t.len() > 1 && t.starts_with('-') && t[1..].bytes().all(|b| b.is_ascii_lowercase());
        long || (short && t.chars().any(|c| "omduk".contains(c)) && !t.contains('s'))
    };
    if toks.iter().any(|t| status_set(t)) {
        return true;
    }
    if toks.iter().any(|t| !t.starts_with('-') && !r.dots.test_str(t)) {
        return true;
    }
    r.cap_hints.test(&cs)
}

/// First argument that is not a flag after the command: the dump's target (`.` when none).
fn target_arg(stmt: &str, cmd_re: &Re) -> String {
    let cs = to_chars(stmt);
    let rest = match cmd_re.exec(&cs, 0) {
        Some(m) => slice(&cs, m[0].map_or(0, |x| x.1), cs.len()),
        None => stmt.to_string(),
    };
    let first = rest.split(['|', ';', '&']).next().unwrap_or("");
    ws_tokens(js_trim(first)).into_iter().find(|t| !t.starts_with('-') && !t.starts_with('/')).unwrap_or(".").to_string()
}

/// The agent's own command, redone with a filter and a cap.
fn dump_rewrite(what: &str, stmt: &str) -> String {
    let r = rx();
    match what {
        "Get-ChildItem -Recurse" | "gci -r" => format!("Get-ChildItem {} -Recurse -Filter *.ts | Select-Object -First 50", target_arg(stmt, &r.cmd_gci)),
        "ls -R" => format!("ls {} | head -50", target_arg(stmt, &r.cmd_ls)),
        "dir /s" => "dir /s /b *.ts | findstr /i \"<name fragment>\"".to_string(),
        "find <path>" => format!("find {} -name '*.ts' | head -50", target_arg(stmt, &r.cmd_find)),
        "tree" => format!("tree -L 2 {}", target_arg(stmt, &r.cmd_tree)),
        "findstr /s" => "Select-String -Path \"src\\*.ts\" -Pattern \"<text>\" | Select-Object -First 50".to_string(),
        "rg --files" => "rg --files -g '*.ts' | head -50".to_string(),
        "fd" => "fd -e ts <name fragment>".to_string(),
        _ => format!("{stmt} | head -50"),
    }
}

/// Splits `[env assignments] cmd rest` as the `grep_split` pattern does: (command, rest).
fn split_grep(seg: &str) -> Option<(String, String)> {
    let cs = to_chars(js_trim(seg));
    let m = rx().grep_split.exec(&cs, 0)?;
    let grp = |k: usize| m.get(k).copied().flatten().map(|(a, b)| slice(&cs, a, b)).unwrap_or_default();
    Some((grp(2), grp(3)))
}

fn first_segment(rest: &str) -> &str {
    rest.split(['|', ';', '&']).next().unwrap_or("")
}

/// Same search, only the names of the files that match, capped.
fn grep_files_first(seg: &str) -> String {
    match split_grep(seg) {
        None => "grep -rl \"<text>\" src | head -50".to_string(),
        Some((cmd0, rest)) => format!("{cmd0} -l {} | head -50", js_trim(first_segment(&rest))),
    }
}

/// Same search, restricted to a folder and capped.
fn grep_capped(seg: &str) -> String {
    let Some((cmd0, rest)) = split_grep(seg) else { return "grep -rn \"<text>\" src | head -50".to_string() };
    let mut toks: Vec<&str> = ws_tokens(js_trim(first_segment(&rest)));
    let last_is_dots = toks.last().map_or(true, |l| rx().dots.test_str(l));
    if last_is_dots {
        toks.pop();
    }
    toks.push("src");
    format!("{cmd0} {} | head -50", toks.join(" "))
}

fn rule_shell_dump(ctx: &Ctx) -> Option<Hit> {
    let r = rx();
    if family(ctx.name) != Some(Fam::Shell) {
        return None;
    }
    let raw = p::input_command(ctx.input);
    if raw.is_empty() {
        return None;
    }
    let cmd = strip_heredocs(&raw);
    let files = repo_files(ctx.stats);
    if files.is_some_and(|n| n < MIN_REPO_FILES_FOR_SCAN_GUARD) {
        return None;
    }
    let cmd_cs = to_chars(&cmd);

    if let Some(gm) = r.grepish.exec(&cmd_cs, 0) {
        if !r.rg_files.test(&cmd_cs) {
            let seg = slice(&cmd_cs, gm[0].map_or(0, |x| x.0), cmd_cs.len());
            if !r.cap_hints.test(&cmd_cs) && grep_unbounded(&seg, ctx.root) {
                return Some(Hit {
                    id: "shellDump",
                    reason: format!(
                        "token-guard/shellDump: content search from the repository root with no result cap. \
The scan itself is cheap; the OUTPUT is what enters the context window.\n\
DO THIS INSTEAD: (1) list the matching files first \u{2014} `{}` \u{2014} \
then re-run scoped to those paths; or (2) cap it now with a path argument and a pipe limit: `{}`.\n\
(PT-BR) Busca por conte\u{fa}do a partir da raiz, sem teto de sa\u{ed}da. Liste primeiro os arquivos \
que casam e refa\u{e7}a restrito a eles, ou limite j\u{e1} com caminho-alvo e pipe (`| head -50`).",
                        grep_files_first(&seg),
                        grep_capped(&seg)
                    ),
                });
            }
            return None;
        }
    }

    let stmts = statements(&cmd);
    if let Some(ls) = stmts.iter().find(|x| r.ls_cmd.test_str(x)) {
        if !ls_files_bounded(ls) {
            return Some(Hit {
                id: "shellDump",
                reason: "token-guard/shellDump: \"git ls-files\" with no path argument lists the whole tree.\n\
DO THIS INSTEAD: scope it to what you actually need \u{2014} `git ls-files src/` \u{2014} or pipe it: `git ls-files | head -50`; to find a file by name: `git ls-files \"*Service*\"`.\n\
(PT-BR) \"git ls-files\" sem caminho lista a \u{e1}rvore inteira. Escopoie (\"git ls-files src/\") ou limite (\"| head -50\")."
                    .to_string(),
            });
        }
        return None;
    }

    let mut hit: Option<(&'static str, &String)> = None;
    for stmt in &stmts {
        let cs = to_chars(stmt);
        let Some((_, what)) = r.dump.iter().find(|(re, _)| re.test(&cs)) else { continue };
        if !r.cap_hints.test(&cs) && !(*what == "find <path>" && find_targets_file(stmt)) {
            hit = Some((*what, stmt));
            break;
        }
    }
    let (what, hit_stmt) = hit?;

    let scale = match files {
        Some(n) if n != 0.0 => {
            let pc = ctx.stats.as_ref().and_then(|s| s.get("pathChars")).filter(|v| v.truthy());
            let chars = pc.map_or(0.0, |v| to_number(Some(v)));
            format!(
                "This repository has {} files; the raw listing alone is roughly {} tokens.",
                fmt_pt_br(n),
                fmt_pt_br(js_round(chars / CHARS_PER_TOKEN))
            )
        }
        _ => "On a large repository this alone can exceed the entire context window.".to_string(),
    };

    Some(Hit {
        id: "shellDump",
        reason: format!(
            "token-guard/shellDump: \"{what}\" walks the tree with no filter and no cap, and every line \
it prints is billed as context. {scale}\n\
DO THIS INSTEAD: (1) use the harness search tool instead of the shell \u{2014} it respects ignore rules \
and returns structured, bounded results (Glob pattern=\"**/*.ts\" paths=[\"src\"]); (2) if the shell is genuinely required, \
run the capped form of your command: `{}`; \
(3) for a whole-tree survey, run the audit \u{2014} `npx @allansantos-dev/token-guard audit` (repo installs: \
`node .github/token-guard/token-audit.cjs`) \u{2014} which reports aggregates instead of dumping paths.\n\
(PT-BR) \"{what}\" percorre a \u{e1}rvore sem filtro e sem teto, e cada linha impressa vira contexto. \
Prefira a ferramenta de busca do harness; se precisar do shell, filtre por nome/extens\u{e3}o e limite \
a sa\u{ed}da (`| Select-Object -First 50` ou `| head -50`). \
Para um panorama do reposit\u{f3}rio inteiro, rode `npx @allansantos-dev/token-guard audit`.",
            dump_rewrite(what, hit_stmt)
        ),
    })
}

/// Runs the rules in registry order; the first hit wins.
pub fn evaluate(ctx: &Ctx) -> Option<Hit> {
    rule_noise_path(ctx).or_else(|| rule_blind_read(ctx)).or_else(|| rule_broad_scan(ctx)).or_else(|| rule_shell_dump(ctx))
}
