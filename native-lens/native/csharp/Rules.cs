using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Slice;

/// <summary>A rule's refusal: the rule id and the reason, which carries the cheap rewrite the agent follows.</summary>
sealed record Hit(string Id, string Reason);

/// <summary>
/// The four context-economy rules of <c>rules.cjs</c> (noisePath, blindRead, broadScan, shellDump), in registry order,
/// with the default configuration. Every regular expression is the reference source verbatim, built through <see cref="Rx"/>;
/// the few tests that are a plain character check (split on <c>|;&amp;</c>, trailing-whitespace trim, "pipe on the next line")
/// are written by hand. The <c>read_document</c> hint never fires: Smart Tool counts as not installed.
/// </summary>
static class Rules
{
    const double ReadBytesWithoutRange = 51200;
    const double MinRepoFilesForScanGuard = 400;
    const double CharsPerToken = 4;
    const double ContextWindow = 200000;
    const string Dash = "\u2014";

    static readonly string[] NoiseDirs =
    [
        "node_modules", "target", "dist", "build", "out", ".git", ".svn", ".hg",
        "venv", ".venv", "env", "__pycache__", ".pytest_cache", ".mypy_cache",
        ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache",
        "vendor", "coverage", ".gradle", ".mvn", ".idea", ".vs", ".vscode-test",
        "bin", "obj", "Pods", "DerivedData", "bower_components", "jspm_packages",
        "instantclient", ".terraform", "site-packages", ".tox", ".nyc_output",
        ".mcp-memory", ".token-guard", ".playwright-mcp", ".ruff_cache",
        "logs", "tmp", "temp", ".tmp",
    ];

    static readonly HashSet<string> DepDirs = ["node_modules", "vendor", "bower_components", "jspm_packages", "site-packages", "venv", ".venv", "env", "pods", ".terraform", ".tox", "instantclient"];
    static readonly HashSet<string> VcsDirs = [".git", ".svn", ".hg"];
    static readonly HashSet<string> LogDirs = ["logs", "tmp", "temp", ".tmp", ".cache", ".playwright-mcp", ".mcp-memory", ".token-guard"];

    static readonly (string Fam, Rx Re)[] Families =
    [
        ("read", new Rx(@"^(view|read|read_file|readfile|cat_file|open_file|get_file_contents|str_replace_editor)$|(^|_)(read_file|read_media_file|read_text_file|read_multiple_files)$")),
        ("grep", new Rx(@"(^|_)(grep|ripgrep|search_text|text_search|grep_search|search_in_files)($|_)")),
        ("glob", new Rx(@"(^|_)(glob|file_search|find_files|list_dir|list_files|list_directory|listdirectory|search_files)($|_)")),
        ("tree", new Rx(@"(^|_)directory_tree$")),
        ("shell", new Rx(@"(^|_)(bash|sh|shell|zsh|powershell|pwsh|run_in_terminal|run_command|execute_command|terminal|run_shell)($|_)")),
    ];

    static readonly Rx RasterImage = new(@"\.(png|jpe?g|gif|webp)$", true);
    static readonly Rx RenderedByRead = new(@"\.(png|jpe?g|gif|webp|pdf)$", true);
    static readonly Rx BinaryFile = new(@"\.(" + string.Join("|",
        "png", "jpe?g", "gif", "webp", "bmp", "ico", "tiff?", "heic", "avif", "psd", "pdf",
        "docx?", "xlsx?", "pptx?", "odt", "ods", "odp",
        "zip", "gz", "tgz", "tar", "7z", "rar", "xz", "bz2", "zst", "iso", "dmg", "msi", "jar", "war", "nupkg",
        "class", "exe", "dll", "so", "dylib", "bin", "wasm", "pyc", "o", "a", "lib", "obj", "pdb", "dmp", "pcap",
        "db", "sqlite3?", "parquet", "h5", "npy", "pkl", "pt", "onnx", "safetensors",
        "mp3", "mp4", "mov", "avi", "mkv", "webm", "wav", "flac", "ogg", "m4a", "aac",
        "woff2?", "ttf", "otf") + @")$", true);
    static readonly Rx ResultsDir = new(@"(?:^|[\\/])\.token-guard[\\/]results[\\/]", true);
    static readonly Rx ExtSuffix = new(@"\.[^.]*$");
    static readonly Rx NameSyntax = new(@"[*?[\]{},]");
    static readonly Rx NameLiteral = new(@"[A-Za-z0-9_-]{3,}");
    static readonly Rx ExtDot = new(@"\.[a-z0-9]{1,10}(?:\}|,|$)", true);
    static readonly Rx Braces = new(@"\{[^}]*\}");
    static readonly Rx ExtAlt = new(@"^\*?[a-z0-9]{1,10}$", true);
    static readonly Rx LeadDotSlash = new(@"^\.\/");
    static readonly Rx LeadGlobChar = new(@"^[*{]");
    static readonly Rx TrailSlashes = new(@"\/+$");
    static readonly Rx LeadDot = new(@"^\.\/?");
    static readonly Rx DriveOnly = new(@"^[a-z]:$", true);
    static readonly Rx AbsStart = new(@"^(?:\/|[a-z]:\/)", true);

    const string EnvPrefix = @"(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:""[^""]*""|'[^']*'|\S+)\s+){0,6})";
    const string CmdPos = @"(?:^|[|;&]\s*)" + EnvPrefix;

    static readonly (Rx Re, string What)[] DumpPatterns =
    [
        (new Rx(CmdPos + @"(?:get-childitem|gci|dir)\s[^|;&]*-recurse", true), "Get-ChildItem -Recurse"),
        (new Rx(CmdPos + @"(?:gci|dir)\s[^|;&]*-r(?=[\s|;&]|$)", true), "gci -r"),
        (new Rx(@"\bls\s+-[a-z]*r[a-z]*\b", true), "ls -R"),
        (new Rx(@"\bdir\s+\/s\b", true), "dir /s"),
        (new Rx(CmdPos + @"find\s+(?!""|'|-)(?!\/[a-z]{1,2}(?:$|[\s""]))[^\s|;&]+", true), "find <path>"),
        (new Rx(CmdPos + @"tree\b(?![^|;&]*(?:-[lL][\s\/]\d*|-l\b|\/l|--level))", true), "tree"),
        (new Rx(@"\bfindstr\s+\/s", true), "findstr /s"),
        (new Rx(@"\brg\s+[^|;&]*--files\b(?![^|;&]*\|)", true), "rg --files"),
        (new Rx(CmdPos + @"(?:fd|fdfind)\b(?![^|;&]*(?:-e\s|--extension|-t\s|--type|-g\s|--glob))", true), "fd"),
    ];

    static readonly Rx Grepish = new(@"(?:^|[|;&]\s*)" + EnvPrefix + @"(?:[\w.-]+[\\/])?(?:grep|egrep|fgrep|rg)\b", true);
    static readonly Rx RgFiles = new(@"\brg\s+[^|;&]*--files\b", true);
    static readonly Rx ShellWordRe = new(@"""((?:[^""\\]|\\.)*)""|'([^']*)'|(\S+)");
    static readonly Rx ValueLong = new(@"^--(?:max-count|after-context|before-context|context|include|exclude|exclude-dir|glob|iglob|type|type-not|max-columns|threads|max-depth|replace|colors?|encoding)$");
    static readonly Rx StopWord = new(@"^(?:[|;&]+|\d*>.*|<.*)$");
    static readonly Rx LongFlag = new(@"^--[a-z]", true);
    static readonly Rx PatternFlagExact = new(@"^--(?:regexp|file)$");
    static readonly Rx PatternFlagEq = new(@"^--(?:regexp|file)=");
    static readonly Rx ShortFlags = new(@"^-[A-Za-z]+$");
    static readonly Rx EnvAssign = new(@"^[A-Za-z_][A-Za-z0-9_]*=");
    static readonly Rx PipeOrChain = new(@"^[|;&]$");
    static readonly Rx GrepCommand = new(@"^(?:[\w.-]+[\\/])?(?:grep|egrep|fgrep|rg)$", true);
    static readonly Rx RgCommand = new(@"(?:^|[\\/])rg$", true);
    static readonly Rx RecursiveShort = new(@"^-[A-Za-z]*[rR][A-Za-z]*$");
    static readonly Rx RecursiveLong = new(@"^--(?:dereference-)?recursive$");
    static readonly Rx Heredoc = new(@"<<-?\s*(['""]?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\r?\n|$)");
    static readonly Rx FindTarget = new(@"\bfind\s+(""[^""]+""|'[^']+'|\S+)", true);
    static readonly Rx FileExt = new(@"\.[A-Za-z0-9]{1,8}$");
    static readonly Rx Quotes = new(@"[""']");
    static readonly Rx LsFilesHead = new(@"^.*?\bgit\s+ls-files\b", true);
    static readonly Rx LsFilesOpt = new(@"^--(?:others|modified|deleted|unmerged|killed)$");
    static readonly Rx LsFilesShort = new(@"^-[a-z]+$");
    static readonly Rx LsFilesStatus = new(@"[omduk]");
    static readonly Rx DotPath = new(@"^\.{1,2}\/?$");
    static readonly Rx Whitespace = new(@"\s+");
    static readonly Rx GrepSplit = new(@"^((?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)((?:[\w.-]+[\\/])?(?:grep|egrep|fgrep|rg))\b\s*(.*)$", true);
    static readonly Rx LsRe = new("^" + EnvPrefix + @"git\s+ls-files\b", true);
    static readonly Rx GciHead = new(@"^.*?(?:get-childitem|gci|dir)\b", true);
    static readonly Rx LsHead = new(@"^.*?\bls\b", true);
    static readonly Rx FindHead = new(@"^.*?\bfind\b", true);
    static readonly Rx TreeHead = new(@"^.*?\btree\b", true);

    static readonly Rx CapHints = new(
        @"(>\s*[^\s|;&>]" +
        @"|\|\s*(?:select-object|select-string|measure-object|sort-object" +
        @"|head|tail|wc|uniq|less|more|awk|sed|grep|findstr|rg)\b" +
        @"|-first\s+\d|-totalcount\s+\d|\bhead\s+-n" +
        @"|maxdepth[=\s]+\d|-L\s*\d|--level|\/l\b" +
        @"|-m\s+\d|--max-count" +
        @"|(?:^|\s)-name\s|(?:^|\s)-iname\s|(?:^|\s)-path\s|(?:^|\s)-regex\s" +
        @"|(?:^|\s)-(?:newer[a-z]*|[acm]time|[acm]min|size|ipath|iregex|i?wholename|perm|user|group)\s|(?:^|\s)-empty\b" +
        @"|(?:^|\s)-filter\s|\|\s*(?:where-object|where)\b|\|\s*\?\s*\{|(?:^|\s)-depth\s+\d" +
        @"|\bselect-string\b" +
        @"|--include|-include\b)",
        true);

    const string ValueShortGrep = "efmABCdD";
    const string ValueShortRg = "efgtTmABCjMEdr";

    static readonly Func<string, JObj, string, object?, Hit?>[] Registry = [NoisePath, BlindRead, BroadScan, ShellDump];

    /// <summary>Runs the rules in registry order; a rule that throws counts as no hit. Returns the first hit or null.</summary>
    public static Hit? Evaluate(string name, JObj input, string root, object? stats)
    {
        foreach (var rule in Registry)
        {
            Hit? hit;
            try
            {
                hit = rule(name, input, root, stats);
            }
            catch
            {
                hit = null;
            }
            if (hit is not null)
            {
                return hit;
            }
        }
        return null;
    }

    static string ToolKey(string name)
    {
        var lower = JsValue.Lower(name);
        var sb = new StringBuilder(lower.Length);
        foreach (var c in lower)
        {
            sb.Append(c is (>= 'a' and <= 'z') or (>= '0' and <= '9') or '_' ? c : '_');
        }
        return sb.ToString().Trim('_');
    }

    static string? Family(string name)
    {
        var key = ToolKey(name);
        foreach (var (fam, re) in Families)
        {
            if (re.IsMatch(key))
            {
                return fam;
            }
        }
        return null;
    }

    static string Normalize(string? p) => (p ?? "").Replace('\\', '/');

    static string? HitsNoise(string p)
    {
        var segs = new List<string>();
        foreach (var s in Normalize(p).Split('/'))
        {
            if (s.Length > 0)
            {
                segs.Add(JsValue.Lower(s));
            }
        }
        foreach (var d in NoiseDirs)
        {
            if (segs.Contains(JsValue.Lower(d)))
            {
                return d;
            }
        }
        return null;
    }

    static bool HasNameFilter(string pattern)
    {
        var parts = Normalize(pattern).Split('/');
        return NameLiteral.IsMatch(NameSyntax.Replace(parts[^1], " "));
    }

    static bool HasExtensionFilter(string pattern)
    {
        if (ExtDot.IsMatch(pattern))
        {
            return true;
        }
        foreach (Match m in Braces.Matches(pattern))
        {
            foreach (var alt in m.Value[1..^1].Split(','))
            {
                if (ExtAlt.IsMatch(JsValue.Trim(alt)))
                {
                    return true;
                }
            }
        }
        return false;
    }

    static bool IsAnchored(string pattern)
    {
        var p = LeadDotSlash.ReplaceFirst(Normalize(pattern), "");
        return p.Length > 0 && !LeadGlobChar.IsMatch(p);
    }

    static string ComparablePath(string p)
    {
        var n = TrailSlashes.ReplaceFirst(WinPath.PosixNormalize(Normalize(p)), "");
        return JsValue.Lower(n);
    }

    /// <summary>Is there a real directory scope? The disk root, the payload cwd and any ancestor of it narrow nothing.</summary>
    static bool HasRealPathScope(List<string> paths, string? root)
    {
        var r = root is { Length: > 0 } ? ComparablePath(root) : null;
        foreach (var p in paths)
        {
            var n = TrailSlashes.ReplaceFirst(LeadDot.ReplaceFirst(Normalize(p), ""), "");
            if (n.Length == 0 || n == "." || n == "/" || DriveOnly.IsMatch(n))
            {
                continue;
            }
            if (r is null)
            {
                return true;
            }
            var abs = ComparablePath(AbsStart.IsMatch(n) ? n : r + "/" + n);
            if (abs != r && !r.StartsWith(abs + "/", StringComparison.Ordinal))
            {
                return true;
            }
        }
        return false;
    }

    static string BytesHuman(double b)
    {
        if (b >= 1073741824)
        {
            return JsValue.ToFixed(b / 1073741824, 2).Replace('.', ',') + " GB";
        }
        if (b >= 1048576)
        {
            return JsValue.ToFixed(b / 1048576, 1).Replace('.', ',') + " MB";
        }
        if (b >= 1024)
        {
            return ((long)JsValue.Round(b / 1024)).ToString(CultureInfo.InvariantCulture) + " KB";
        }
        return ((long)b).ToString(CultureInfo.InvariantCulture) + " B";
    }

    static bool IsInside(string child, string parent)
    {
        var rel = WinPath.Relative(parent, child);
        return !rel.StartsWith("..", StringComparison.Ordinal) && !WinPath.IsAbsolute(rel);
    }

    static string NoiseAdvice(string dir, string target)
    {
        var d = JsValue.Lower(dir);
        var rel = Normalize(target);
        var baseName = WinPath.Basename(rel);
        var stem = ExtSuffix.ReplaceFirst(baseName, "");
        if (stem.Length == 0)
        {
            stem = baseName;
        }
        var binary = BinaryFile.IsMatch(rel);
        if (DepDirs.Contains(d))
        {
            return "DO THIS INSTEAD: (1) see how the project uses the dependency " + Dash + " search the project's own code for the import (Grep pattern=\"from '<package>'\" or \"require('<package>')\"), which shows the API actually used; " +
                "(2) for the API itself, read the package docs: `npm view <package> readme` (Python: `pip show <package>`); " +
                "(3) only if this exact file is required, add \"" + rel + "\" to \"allowlist\" in token-guard.config.json.";
        }
        if (VcsDirs.Contains(d))
        {
            return "DO THIS INSTEAD: ask git, not the object store " + Dash + " `git log -n 5 --oneline -- <path>`, `git show HEAD:<path>`, `git diff`. " +
                "Files under " + dir + "/ are binary or packed and never useful as text.";
        }
        if (LogDirs.Contains(d) && !binary)
        {
            return "DO THIS INSTEAD: read only the tail through the shell " + Dash + " `tail -n 100 \"" + rel + "\"` (PowerShell: `Get-Content \"" + rel + "\" -Tail 100`) " + Dash + " " +
                "or search it for the error you chase (`grep -n \"ERROR\" \"" + rel + "\" | tail -20`). If you need the file whole, add \"" + rel + "\" to \"allowlist\" in token-guard.config.json.";
        }
        return "DO THIS INSTEAD: (1) find the source that generates it " + Dash + " Glob pattern=\"**/" + stem + ".*\" (the name filter keeps the answer to a few paths) " + Dash + " and read that source, not the artifact; " +
            "(2) if you need the compiled output's behavior, run it or its tests and read the result; " +
            "(3) only if this exact file is required, add \"" + rel + "\" to \"allowlist\" in token-guard.config.json.";
    }

    static Hit? NoisePath(string name, JObj input, string root, object? stats)
    {
        var targets = new List<string>();
        var single = Payload.InputPath(input);
        if (single.Length > 0)
        {
            targets.Add(single);
        }
        foreach (var p in Payload.InputPaths(input))
        {
            if (p.Length > 0)
            {
                targets.Add(p);
            }
        }
        var reading = Family(name) == "read";
        foreach (var t in targets)
        {
            if (ResultsDir.IsMatch(t))
            {
                continue;
            }
            var probe = t;
            if (root.Length > 0)
            {
                try
                {
                    var abs = WinPath.IsAbsolute(t) ? t : WinPath.Resolve(root, t);
                    var rel = WinPath.Relative(root, abs);
                    if (rel.Length == 0 || rel.StartsWith("..", StringComparison.Ordinal))
                    {
                        continue;
                    }
                    probe = rel;
                    var tmp = Host.TmpDir();
                    if (IsInside(abs, tmp) && !IsInside(root, tmp))
                    {
                        probe = WinPath.Relative(tmp, abs);
                    }
                }
                catch
                {
                    probe = t;
                }
            }
            var dir = HitsNoise(probe);
            if (dir is null)
            {
                continue;
            }
            if (reading && LogDirs.Contains(JsValue.Lower(dir)) && RenderedByRead.IsMatch(t))
            {
                continue;
            }
            return new Hit("noisePath",
                "token-guard/noisePath: the path crosses \"" + dir + "\", a build/dependency directory. " +
                "Its contents are generated or vendored and never belong in context.\n" +
                NoiseAdvice(dir, probe) + "\n" +
                "(PT-BR) O caminho passa por \"" + dir + "\" (build/dependência). " +
                "Leia a fonte que gera o artefato, não o artefato. " +
                "Se precisa mesmo deste arquivo, inclua o caminho em \"allowlist\" no token-guard.config.json.");
        }
        return null;
    }

    static Hit? BlindRead(string name, JObj input, string root, object? stats)
    {
        if (Family(name) != "read")
        {
            return null;
        }
        var single = Payload.InputPath(input);
        var targets = single.Length > 0 ? [single] : Payload.InputPaths(input);
        foreach (var target in targets)
        {
            var verdict = BlindReadOne(input, root, target);
            if (verdict is not null)
            {
                return verdict;
            }
        }
        return null;
    }

    static Hit? BlindReadOne(JObj input, string root, string target)
    {
        var ext = JsValue.Lower(WinPath.Extname(target));
        var notebook = ext == ".ipynb";
        bool ranged;
        if (notebook)
        {
            ranged = Payload.Get(input, "view_range") is List<object?> { Count: > 0 };
        }
        else if (ext == ".pdf")
        {
            ranged = Payload.Get(input, "pages") is string pages && JsValue.Trim(pages).Length > 0;
        }
        else
        {
            ranged = Payload.HasReadRange(input);
        }
        if (ranged || target.Length == 0)
        {
            return null;
        }

        var abs = WinPath.IsAbsolute(target) ? WinPath.Normalize(target) : WinPath.Resolve(root.Length > 0 ? root : Host.Cwd, target);
        if (RasterImage.IsMatch(abs))
        {
            return null;
        }

        long length;
        try
        {
            var info = new System.IO.FileInfo(WinPath.ToNamespaced(abs));
            if (!info.Exists)
            {
                return null;
            }
            length = info.Length;
        }
        catch
        {
            return null;
        }
        if (length <= ReadBytesWithoutRange)
        {
            return null;
        }

        var baseName = WinPath.Basename(target);
        var size = BytesHuman(length);

        if (ext == ".pdf")
        {
            return new Hit("blindRead",
                "token-guard/blindRead: \"" + baseName + "\" is a " + size + " PDF requested with no \"pages\".\n" +
                "DO THIS INSTEAD: pass pages for the part you need (e.g. pages: \"1-5\"; at most 20 per call) " + Dash + " " +
                "start with the first pages or the table of contents to find where the content lives. " +
                "If this harness has no page parameter, convert first (pdftotext \"" + baseName + "\" out.txt) and read ranges of the text.\n" +
                "(PT-BR) \"" + baseName + "\" é um PDF de " + size + " pedido sem \"pages\". Passe pages com o trecho necessário " +
                "(ex.: pages: \"1-5\"; até 20 por chamada). Sem parâmetro de páginas, converta antes (pdftotext) e leia faixas do texto.");
        }

        var tokensNum = JsValue.Round(length / CharsPerToken);
        var tokens = JsValue.Fmt(tokensNum);
        var pctWindow = JsValue.ToFixed(tokensNum / ContextWindow * 100, 1).Replace('.', ',');
        var window = JsValue.Fmt(ContextWindow);

        if (BinaryFile.IsMatch(baseName))
        {
            return new Hit("blindRead",
                "token-guard/blindRead: \"" + baseName + "\" is a " + size + " binary file " + Dash + " reading it as text costs ~" + tokens + " tokens and shows nothing useful.\n" +
                "DO THIS INSTEAD: inspect it by format " + Dash + " `file \"" + baseName + "\"` says what it is; archives list their contents " +
                "(`unzip -l \"" + baseName + "\"`, `tar -tf \"" + baseName + "\"`); databases list their tables (`sqlite3 \"" + baseName + "\" \".tables\"`); " +
                "otherwise read the source or the command that produced it.\n" +
                "(PT-BR) \"" + baseName + "\" é um binário de " + size + ": lido como texto custa ~" + tokens + " tokens e não mostra nada útil. " +
                "Inspecione pelo formato (file, unzip -l, tar -tf, sqlite3 .tables) ou leia a fonte que o gerou.");
        }

        if (notebook)
        {
            return new Hit("blindRead",
                "token-guard/blindRead: notebook \"" + baseName + "\" is " + size + " (~" + tokens + " tokens, " + pctWindow + "% of a " +
                window + "-token window). Read loads notebooks whole " + Dash + " offset/limit are ignored.\n" +
                "DO THIS INSTEAD: (1) find the cell index " + Dash + " `jq -r '.cells | to_entries[] | select(.value.source | join(\"\")  | test(\"<text>\")) | .key' \"" + baseName + "\"`; " +
                "(2) extract only that cell " + Dash + " `jq -r '.cells[3].source | join(\"\")' \"" + baseName + "\"` " +
                "(no jq: `node -e \"const nb=JSON.parse(require('fs').readFileSync('" + baseName + "','utf8'));console.log(nb.cells[3].source.join(''))\"`). " +
                "Outputs (images, tables) are usually the bulk " + Dash + " skip them unless needed.\n" +
                "(PT-BR) O notebook \"" + baseName + "\" tem " + size + " (~" + tokens + " tokens, " + pctWindow + "% da janela) e o Read " +
                "carrega notebook inteiro (ignora offset/limit). Localize as células com uma busca restrita ao arquivo " +
                "e extraia só essas células (node -e / jq).");
        }

        return new Hit("blindRead",
            "token-guard/blindRead: \"" + baseName + "\" is " + size + " (~" + tokens + " tokens, " +
            pctWindow + "% of a " + window + "-token window) and you requested it with no line range.\n" +
            "DO THIS INSTEAD: (1) find the line " + Dash + " Grep pattern=\"<symbol or text you need>\" path=\"" + target + "\" output_mode=\"content\" head_limit=20 " +
            "(shell: `grep -n \"<text>\" \"" + baseName + "\" | head -20`); " +
            "(2) read around the hit " + Dash + " Read file_path=\"" + target + "\" offset=<hit line - 20> limit=80 " +
            "(shell: `sed -n '<from>,<to>p' \"" + baseName + "\"`; PowerShell: `Get-Content \"" + baseName + "\" | Select-Object -Skip <from-1> -First 80`). " +
            "Most tasks need 40-80 lines, not the whole file. If you truly need a full pass, delegate it to a sub-agent so the bulk never " +
            "enters this window; import only its conclusion.\n" +
            "(PT-BR) \"" + baseName + "\" tem " + size + " (~" + tokens + " tokens, " + pctWindow + "% da janela) " +
            "e foi pedido sem faixa de linhas. Localize o trecho com uma busca restrita a este arquivo e releia " +
            "só a faixa relevante. Se precisa varrer tudo, delegue a um sub-agente e traga só a conclusão.");
    }

    /// <summary>stats.totalFiles when it is a finite number, else null.</summary>
    static double? RepoFiles(object? stats) =>
        Payload.Get(stats, "totalFiles") is double d && double.IsFinite(d) ? d : null;

    static Hit? BroadScan(string name, JObj input, string root, object? stats)
    {
        var fam = Family(name);
        if (fam is not ("glob" or "grep" or "tree"))
        {
            return null;
        }
        var repoFiles = RepoFiles(stats);
        if (repoFiles is double rf && rf < MinRepoFilesForScanGuard)
        {
            return null;
        }
        if (fam == "tree")
        {
            if (HasRealPathScope(Payload.InputPaths(input), root))
            {
                return null;
            }
            var treeScale = repoFiles is > 0 or < 0 ? "about " + JsValue.Fmt(repoFiles.Value) + " files" : "every file in the repository";
            return new Hit("broadScan",
                "token-guard/broadScan: a recursive tree of the repository root returns the path of " + treeScale + ", with no cap.\n" +
                "DO THIS INSTEAD: list one directory with `list_directory` on `src`, or run `directory_tree` on the subdirectory you need (`src/...`).\n" +
                "(PT-BR) A árvore recursiva da raiz devolve o caminho de " + (repoFiles is > 0 or < 0 ? JsValue.Fmt(repoFiles.Value) + " arquivos" : "todo o repositório") + ", sem teto. " +
                "Liste um diretório com `list_directory` em `src` ou use `directory_tree` num subdiretório (`src/...`).");
        }
        var pattern = Payload.InputPattern(input);
        var paths = Payload.InputPaths(input);
        if (pattern.Length == 0)
        {
            return null;
        }
        var scoped = HasRealPathScope(paths, root);

        if (fam == "glob")
        {
            if (scoped || IsAnchored(pattern) || HasExtensionFilter(pattern) || HasNameFilter(pattern))
            {
                return null;
            }
            var scale = repoFiles is > 0 or < 0 ? "about " + JsValue.Fmt(repoFiles.Value) + " files" : "every file in the repository";
            return new Hit("broadScan",
                "token-guard/broadScan: the pattern \"" + pattern + "\" is unbounded in both breadth and type, " +
                "so it returns the path of " + scale + ". A bare file listing is pure overhead: it answers " +
                "\"what exists\", never \"where is the thing I need\".\n" +
                "DO THIS INSTEAD: bound it on at least one axis " + Dash + " " +
                "(a) by type: pattern=\"**/*.{ts,tsx,js}\" (or \"**/*.java\"); " +
                "(b) by directory: pattern=\"" + pattern + "\" with paths=[\"src\"]; " +
                "(c) by name: pattern=\"**/*Service*\" (a literal fragment of 3+ characters). " +
                "To find code by meaning rather than by filename, search content instead of listing paths: Grep pattern=\"<text>\" output_mode=\"files_with_matches\".\n" +
                "(PT-BR) O padrão \"" + pattern + "\" não limita nem escopo nem tipo: devolve o caminho de " +
                (repoFiles is > 0 or < 0 ? JsValue.Fmt(repoFiles.Value) + " arquivos" : "todo o repositório") + ". " +
                "Limite por extensão (\"**/*.java\"), por diretório (paths=[\"src/...\"]) ou por nome (\"**/*Service*\").");
        }

        var modeRaw = JsValue.Truthy(Payload.Get(input, "output_mode")) ? Payload.Get(input, "output_mode")
            : JsValue.Truthy(Payload.Get(input, "outputMode")) ? Payload.Get(input, "outputMode") : "";
        var mode = JsValue.Lower(JsValue.ToJsString(modeRaw));
        var wantsContent = mode == "content" || JsValue.Truthy(Payload.Get(input, "includeContent"));
        if (!wantsContent)
        {
            return null;
        }

        foreach (var key in new[] { "head_limit", "headLimit", "maxResults", "limit", "max_results" })
        {
            var n = JsValue.ToNumber(Payload.Get(input, key));
            if (double.IsFinite(n) && n > 0)
            {
                return null;
            }
        }

        if (Payload.InputScopeFilter(input).Length > 0 || scoped)
        {
            return null;
        }

        var quoted = Json.Quote(pattern);
        return new Hit("broadScan",
            "token-guard/broadScan: content-mode search across the whole repository with no result cap " +
            "and no file filter. The scan itself is cheap; the OUTPUT is what enters the context window, " +
            "and here it is unbounded.\n" +
            "DO THIS INSTEAD: (1) run the same query as Grep pattern=" + quoted + " output_mode=\"files_with_matches\" first to see where " +
            "it lives " + Dash + " that answer is a handful of lines; then (2) re-run in content mode narrowed to one of those files: " +
            "Grep pattern=" + quoted + " output_mode=\"content\" path=\"<file from step 1>\" head_limit=50. " +
            "Or cap it now: add head_limit=50 and a file filter (glob=\"*.ts\" or type=\"ts\").\n" +
            "(PT-BR) Busca por conteúdo em todo o repositório, sem teto de resultado e sem filtro de arquivo. " +
            "O custo não é a varredura, é a SAÍDA que entra na janela. " +
            "Rode antes com output_mode=\"files_with_matches\" para descobrir onde está, depois volte em modo " +
            "conteúdo só nesses arquivos " + Dash + " ou aplique head_limit + filtro (glob/type) agora.");
    }

    /// <summary>Words of the line honoring quotes (<c>rg "a b" src</c> has 2 arguments, not 3).</summary>
    static List<string> ShellWords(string seg)
    {
        var words = new List<string>();
        foreach (Match m in ShellWordRe.Matches(seg))
        {
            words.Add(m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value);
        }
        return words;
    }

    /// <summary>Paths the search walks: the positional arguments minus the pattern (the first one, unless -e/-f).</summary>
    static List<string> SearchPaths(bool isRg, List<string> words)
    {
        var valueShort = isRg ? ValueShortRg : ValueShortGrep;
        var positional = new List<string>();
        var patternByFlag = false;
        for (var k = 0; k < words.Count; k++)
        {
            var w = words[k];
            if (StopWord.IsMatch(w))
            {
                break;
            }
            if (w == "--")
            {
                positional.AddRange(words.GetRange(k + 1, words.Count - k - 1));
                break;
            }
            if (LongFlag.IsMatch(w))
            {
                if (PatternFlagExact.IsMatch(w))
                {
                    patternByFlag = true;
                    k += 1;
                }
                else if (PatternFlagEq.IsMatch(w))
                {
                    patternByFlag = true;
                }
                else if (ValueLong.IsMatch(w))
                {
                    k += 1;
                }
                continue;
            }
            if (ShortFlags.IsMatch(w))
            {
                var last = w[^1];
                if (valueShort.Contains(last))
                {
                    if (last is 'e' or 'f')
                    {
                        patternByFlag = true;
                    }
                    k += 1;
                }
                continue;
            }
            if (w.StartsWith('-') && w.Length > 1)
            {
                continue;
            }
            positional.Add(w);
        }
        return patternByFlag ? positional : positional.Count > 0 ? positional.GetRange(1, positional.Count - 1) : positional;
    }

    /// <summary>True when the search starting at <paramref name="seg"/> is an unbounded dump: rg is recursive by nature, grep only with -r/-R; no path or only "." is the whole repo; after a pipe it filters stdin.</summary>
    static bool GrepUnbounded(string seg, string root)
    {
        var toks = ShellWords(JsValue.Trim(seg));
        var i = 0;
        var piped = false;
        while (i < toks.Count && (EnvAssign.IsMatch(toks[i]) || PipeOrChain.IsMatch(toks[i])))
        {
            if (toks[i] == "|")
            {
                piped = true;
            }
            i += 1;
        }
        if (i >= toks.Count || toks[i].Length == 0 || !GrepCommand.IsMatch(toks[i]))
        {
            return false;
        }
        var isRg = RgCommand.IsMatch(toks[i]);
        var rest = toks.GetRange(i + 1, toks.Count - i - 1);
        var recursive = isRg;
        if (!recursive)
        {
            foreach (var t in rest)
            {
                if (t.StartsWith('-') && (RecursiveShort.IsMatch(t) || RecursiveLong.IsMatch(t)))
                {
                    recursive = true;
                    break;
                }
            }
        }
        if (!recursive)
        {
            return false;
        }
        var paths = SearchPaths(isRg, rest);
        if (paths.Count == 0)
        {
            return !piped;
        }
        foreach (var p in paths)
        {
            if (HasRealPathScope([p], root))
            {
                return false;
            }
        }
        return true;
    }

    /// <summary>Heredoc body is data (commit message, file content), not a command: only the line that opens it stays.</summary>
    static string StripHeredocs(string cmd) =>
        Heredoc.Replace(cmd, m => m.Value[..m.Value.IndexOf('\n')]);

    static bool PipeStartsNextLine(string cmd, int from)
    {
        var j = from;
        while (j < cmd.Length && JsValue.IsWhiteSpace(cmd[j]))
        {
            j++;
        }
        return j < cmd.Length && cmd[j] == '|';
    }

    /// <summary>Independent commands of the line: split at newline, ';', '&amp;&amp;' and '||', never inside quotes, a PowerShell { } block, or a continued line.</summary>
    static List<string> Statements(string cmd)
    {
        var raw = new List<string>();
        var cur = new StringBuilder();
        char quote = '\0';
        var depth = 0;
        for (var i = 0; i < cmd.Length; i++)
        {
            var ch = cmd[i];
            var nx = i + 1 < cmd.Length ? cmd[i + 1] : '\0';
            if (quote != '\0')
            {
                cur.Append(ch);
                if (ch == quote && !(quote == '"' && i > 0 && cmd[i - 1] == '\\'))
                {
                    quote = '\0';
                }
                continue;
            }
            if (ch is '"' or '\'')
            {
                quote = ch;
                cur.Append(ch);
                continue;
            }
            if (ch == '{')
            {
                depth += 1;
            }
            if (ch == '}' && depth > 0)
            {
                depth -= 1;
            }
            if (depth > 0)
            {
                cur.Append(ch);
                continue;
            }
            if (ch == '\n' || (ch == '\r' && nx == '\n'))
            {
                if (ch == '\r')
                {
                    i += 1;
                }
                var t = JsValue.TrimEnd(cur.ToString());
                if ((t.Length > 0 && t[^1] is '\\' or '`' or '|') || PipeStartsNextLine(cmd, i + 1))
                {
                    if (t.Length > 0 && t[^1] is '\\' or '`')
                    {
                        t = t[..^1];
                    }
                    cur.Clear().Append(t).Append(' ');
                    continue;
                }
                raw.Add(cur.ToString());
                cur.Clear();
                continue;
            }
            if (ch == ';')
            {
                raw.Add(cur.ToString());
                cur.Clear();
                continue;
            }
            if ((ch == '&' && nx == '&') || (ch == '|' && nx == '|'))
            {
                raw.Add(cur.ToString());
                cur.Clear();
                i += 1;
                continue;
            }
            cur.Append(ch);
        }
        raw.Add(cur.ToString());
        var result = new List<string>();
        foreach (var x in raw)
        {
            var trimmed = JsValue.Trim(x);
            if (trimmed.Length > 0)
            {
                result.Add(trimmed);
            }
        }
        return result;
    }

    /// <summary>text up to the first '|', ';' or '&amp;'.</summary>
    static string BeforeChain(string s)
    {
        var at = s.IndexOfAny(['|', ';', '&']);
        return at < 0 ? s : s[..at];
    }

    static List<string> SplitWords(string s)
    {
        var result = new List<string>();
        foreach (var part in Whitespace.Split(s))
        {
            if (part.Length > 0)
            {
                result.Add(part);
            }
        }
        return result;
    }

    /// <summary><c>find path/file.ext</c> checks existence, it does not scan.</summary>
    static bool FindTargetsFile(string stmt)
    {
        var m = FindTarget.Match(stmt);
        return m.Success && FileExt.IsMatch(Quotes.Replace(m.Groups[1].Value, ""));
    }

    /// <summary>git ls-files bounded by a path, a status set (-o/-m/-d/-u/-k) or a cap on the pipe.</summary>
    static bool LsFilesBounded(string stmt)
    {
        var afterCmd = LsFilesHead.ReplaceFirst(stmt, "");
        var toks = SplitWords(afterCmd.Split('|')[0]);
        foreach (var t in toks)
        {
            if (LsFilesOpt.IsMatch(t) || (LsFilesShort.IsMatch(t) && LsFilesStatus.IsMatch(t) && !t.Contains('s')))
            {
                return true;
            }
        }
        foreach (var t in toks)
        {
            if (!t.StartsWith('-') && !DotPath.IsMatch(t))
            {
                return true;
            }
        }
        return CapHints.IsMatch(stmt);
    }

    /// <summary>First non-flag argument after the command: the dump's target ('.' when there is none).</summary>
    static string TargetArg(string stmt, Rx cmdRe)
    {
        var rest = SplitWords(JsValue.Trim(BeforeChain(cmdRe.ReplaceFirst(stmt, ""))));
        foreach (var t in rest)
        {
            if (!t.StartsWith('-') && !t.StartsWith('/'))
            {
                return t;
            }
        }
        return ".";
    }

    /// <summary>The agent's command redone with a filter and a cap; each form goes through the guard itself.</summary>
    static string DumpRewrite(string what, string stmt)
    {
        switch (what)
        {
            case "Get-ChildItem -Recurse":
            case "gci -r":
                return "Get-ChildItem " + TargetArg(stmt, GciHead) + " -Recurse -Filter *.ts | Select-Object -First 50";
            case "ls -R":
                return "ls " + TargetArg(stmt, LsHead) + " | head -50";
            case "dir /s":
                return "dir /s /b *.ts | findstr /i \"<name fragment>\"";
            case "find <path>":
                return "find " + TargetArg(stmt, FindHead) + " -name '*.ts' | head -50";
            case "tree":
                return "tree -L 2 " + TargetArg(stmt, TreeHead);
            case "findstr /s":
                return "Select-String -Path \"src\\*.ts\" -Pattern \"<text>\" | Select-Object -First 50";
            case "rg --files":
                return "rg --files -g '*.ts' | head -50";
            case "fd":
                return "fd -e ts <name fragment>";
            default:
                return stmt + " | head -50";
        }
    }

    /// <summary>The same search, only the names of the files that match, capped.</summary>
    static string GrepFilesFirst(string seg)
    {
        var m = GrepSplit.Match(JsValue.Trim(seg));
        if (!m.Success)
        {
            return "grep -rl \"<text>\" src | head -50";
        }
        var body = JsValue.Trim(BeforeChain(m.Groups[3].Value));
        return m.Groups[2].Value + " -l " + body + " | head -50";
    }

    /// <summary>The same search, restricted to a directory and with an output cap.</summary>
    static string GrepCapped(string seg)
    {
        var m = GrepSplit.Match(JsValue.Trim(seg));
        if (!m.Success)
        {
            return "grep -rn \"<text>\" src | head -50";
        }
        var toks = SplitWords(JsValue.Trim(BeforeChain(m.Groups[3].Value)));
        var last = toks.Count > 0 ? toks[^1] : null;
        var body = new List<string>(toks);
        if (body.Count > 0 && (string.IsNullOrEmpty(last) || DotPath.IsMatch(last)))
        {
            body.RemoveAt(body.Count - 1);
        }
        body.Add("src");
        return m.Groups[2].Value + " " + string.Join(' ', body) + " | head -50";
    }

    static Hit? ShellDump(string name, JObj input, string root, object? stats)
    {
        if (Family(name) != "shell")
        {
            return null;
        }
        var raw = Payload.InputCommand(input);
        if (raw.Length == 0)
        {
            return null;
        }
        var cmd = StripHeredocs(raw);

        var repoFiles = RepoFiles(stats);
        if (repoFiles is double rf && rf < MinRepoFilesForScanGuard)
        {
            return null;
        }

        var gm = Grepish.Match(cmd);
        if (gm.Success && !RgFiles.IsMatch(cmd))
        {
            if (!CapHints.IsMatch(cmd) && GrepUnbounded(cmd[gm.Index..], root))
            {
                return new Hit("shellDump",
                    "token-guard/shellDump: content search from the repository root with no result cap. " +
                    "The scan itself is cheap; the OUTPUT is what enters the context window.\n" +
                    "DO THIS INSTEAD: (1) list the matching files first " + Dash + " `" + GrepFilesFirst(cmd[gm.Index..]) + "` " + Dash + " " +
                    "then re-run scoped to those paths; or (2) cap it now with a path argument and a pipe limit: `" + GrepCapped(cmd[gm.Index..]) + "`.\n" +
                    "(PT-BR) Busca por conteúdo a partir da raiz, sem teto de saída. Liste primeiro os arquivos " +
                    "que casam e refaça restrito a eles, ou limite já com caminho-alvo e pipe (`| head -50`).");
            }
            return null;
        }

        var stmts = Statements(cmd);
        string? lsStmt = null;
        foreach (var x in stmts)
        {
            if (LsRe.IsMatch(x))
            {
                lsStmt = x;
                break;
            }
        }
        if (lsStmt is not null)
        {
            if (!LsFilesBounded(lsStmt))
            {
                return new Hit("shellDump",
                    "token-guard/shellDump: \"git ls-files\" with no path argument lists the whole tree.\n" +
                    "DO THIS INSTEAD: scope it to what you actually need " + Dash + " `git ls-files src/` " + Dash + " or pipe it: `git ls-files | head -50`; to find a file by name: `git ls-files \"*Service*\"`.\n" +
                    "(PT-BR) \"git ls-files\" sem caminho lista a árvore inteira. Escopoie (\"git ls-files src/\") ou limite (\"| head -50\").");
            }
            return null;
        }

        string? hitWhat = null;
        var hitStmt = "";
        foreach (var stmt in stmts)
        {
            foreach (var (re, what) in DumpPatterns)
            {
                if (!re.IsMatch(stmt))
                {
                    continue;
                }
                if (!CapHints.IsMatch(stmt) && !(what == "find <path>" && FindTargetsFile(stmt)))
                {
                    hitWhat = what;
                    hitStmt = stmt;
                }
                break;
            }
            if (hitWhat is not null)
            {
                break;
            }
        }
        if (hitWhat is null)
        {
            return null;
        }

        string scale;
        if (repoFiles is > 0 or < 0)
        {
            var pathChars = Payload.Get(stats, "pathChars");
            var chars = JsValue.Truthy(pathChars) ? JsValue.ToNumber(pathChars) : 0;
            scale = "This repository has " + JsValue.Fmt(repoFiles.Value) + " files; the raw listing alone is roughly " +
                JsValue.Fmt(JsValue.Round(chars / CharsPerToken)) + " tokens.";
        }
        else
        {
            scale = "On a large repository this alone can exceed the entire context window.";
        }

        return new Hit("shellDump",
            "token-guard/shellDump: \"" + hitWhat + "\" walks the tree with no filter and no cap, and every line " +
            "it prints is billed as context. " + scale + "\n" +
            "DO THIS INSTEAD: (1) use the harness search tool instead of the shell " + Dash + " it respects ignore rules " +
            "and returns structured, bounded results (Glob pattern=\"**/*.ts\" paths=[\"src\"]); (2) if the shell is genuinely required, " +
            "run the capped form of your command: `" + DumpRewrite(hitWhat, hitStmt) + "`; " +
            "(3) for a whole-tree survey, run the audit " + Dash + " `npx @allansantos-dev/token-guard audit` (repo installs: " +
            "`node .github/token-guard/token-audit.cjs`) " + Dash + " which reports aggregates instead of dumping paths.\n" +
            "(PT-BR) \"" + hitWhat + "\" percorre a árvore sem filtro e sem teto, e cada linha impressa vira contexto. " +
            "Prefira a ferramenta de busca do harness; se precisar do shell, filtre por nome/extensão e limite " +
            "a saída (`| Select-Object -First 50` ou `| head -50`). " +
            "Para um panorama do repositório inteiro, rode `npx @allansantos-dev/token-guard audit`.");
    }
}
