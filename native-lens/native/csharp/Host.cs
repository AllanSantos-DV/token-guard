using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Slice;

/// <summary>
/// The machine the guard reads, as Node's <c>os</c> and <c>statedir.cjs</c> see it on Windows: home, temp,
/// the per-user data folder, the project root and the repo-stats cache. Nothing here writes.
/// </summary>
static class Host
{
    static readonly string[] Markers = [".git", "package.json", "token-guard.config.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle"];
    static readonly string[] UserFolders = ["desktop", "documents", "downloads", "pictures", "videos", "music", "onedrive"];
    static readonly string[] SystemSegments = ["appdata", "node_modules", "windows", "program files", "program files (x86)", "programdata", "system32"];
    static readonly string[] SystemLeaves = ["bin", "sbin", "etc", "usr", "var"];
    static readonly Rx PathSeparators = new(@"[\\/]");

    /// <summary>process.cwd().</summary>
    public static string Cwd => Directory.GetCurrentDirectory();

    static string? Env(string name)
    {
        var v = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrEmpty(v) ? null : v;
    }

    /// <summary>os.homedir(): USERPROFILE, else HOMEDRIVE + HOMEPATH.</summary>
    public static string Home()
    {
        var profile = Env("USERPROFILE");
        if (profile is not null)
        {
            return profile;
        }
        var drivePath = (Env("HOMEDRIVE") ?? "") + (Env("HOMEPATH") ?? "");
        return drivePath.Length > 0 ? drivePath : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    /// <summary>os.tmpdir(): TEMP, else TMP, else %SystemRoot%\temp, without a trailing backslash.</summary>
    public static string TmpDir()
    {
        var path = Env("TEMP") ?? Env("TMP") ?? ((Env("SystemRoot") ?? Env("windir") ?? "undefined") + "\\temp");
        if (path.Length > 1 && path.EndsWith('\\') && !path.EndsWith(":\\"))
        {
            path = path[..^1];
        }
        return path;
    }

    /// <summary>The per-user folder outside any project: %LOCALAPPDATA%\token-guard.</summary>
    public static string DataHome() =>
        WinPath.Join(Env("LOCALAPPDATA") ?? WinPath.Join(Home(), "AppData", "Local"), "token-guard");

    static string Sha1Hex(string text) => Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    static bool SameDir(string a, string b) => JsValue.Lower(WinPath.Resolve(a)) == JsValue.Lower(WinPath.Resolve(b));

    static bool Contains(string[] set, string value) => Array.IndexOf(set, value) >= 0;

    /// <summary>True when the folder can never be a project root (home, a personal folder, the system, a drive root).</summary>
    static bool NeverProject(string dir)
    {
        var abs = WinPath.Resolve(dir);
        if (WinPath.Dirname(abs) == abs)
        {
            return true;
        }
        var home = Home();
        if (SameDir(abs, home))
        {
            return true;
        }
        if (SameDir(WinPath.Dirname(abs), home) && Contains(UserFolders, JsValue.Lower(WinPath.Basename(abs))))
        {
            return true;
        }
        var rel = WinPath.Relative(home, abs);
        var inHome = rel.Length > 0 && !rel.StartsWith("..", StringComparison.Ordinal) && !WinPath.IsAbsolute(rel);
        if (Contains(SystemLeaves, JsValue.Lower(WinPath.Basename(abs))))
        {
            return true;
        }
        var parts = PathSeparators.Split(inHome ? rel : abs);
        var segments = new string[parts.Length];
        for (var i = 0; i < parts.Length; i++)
        {
            segments[i] = JsValue.Lower(parts[i]);
        }
        var tempIdx = -1;
        for (var i = 0; i < segments.Length; i++)
        {
            if (segments[i] == "appdata" && i + 2 < segments.Length && segments[i + 1] == "local" && segments[i + 2] == "temp")
            {
                tempIdx = i;
                break;
            }
        }
        for (var i = tempIdx >= 0 ? tempIdx + 3 : 0; i < segments.Length; i++)
        {
            if (Contains(SystemSegments, segments[i]))
            {
                return true;
            }
        }
        return false;
    }

    static bool Exists(string path)
    {
        try
        {
            var full = WinPath.ToNamespaced(path);
            return File.Exists(full) || Directory.Exists(full);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>First ancestor of <paramref name="dir"/> holding a project marker, or null.</summary>
    static string? ProjectRoot(string dir)
    {
        var cur = WinPath.Resolve(dir);
        while (true)
        {
            if (NeverProject(cur))
            {
                return null;
            }
            foreach (var marker in Markers)
            {
                if (Exists(WinPath.Join(cur, marker)))
                {
                    return cur;
                }
            }
            var up = WinPath.Dirname(cur);
            if (up == cur)
            {
                return null;
            }
            cur = up;
        }
    }

    /// <summary>stateDir(root) without a session id: <c>&lt;project&gt;\.token-guard</c> inside a project, else a hashed folder in the user data folder.</summary>
    public static string StateDir(string root)
    {
        var origin = WinPath.Resolve(root.Length > 0 ? root : Cwd);
        var project = ProjectRoot(origin);
        return project is not null
            ? WinPath.Join(project, ".token-guard")
            : WinPath.Join(DataHome(), "state", Sha1Hex(JsValue.Lower(origin))[..16]);
    }

    /// <summary>repoStats(root): the parsed repo-stats.json, or null when it is missing, unreadable or not JSON. A JSON null is also "no stats".</summary>
    public static object? RepoStats(string root)
    {
        try
        {
            var file = WinPath.Join(StateDir(root), "repo-stats.json");
            if (!Exists(file))
            {
                return null;
            }
            return Json.Parse(new UTF8Encoding(false).GetString(File.ReadAllBytes(WinPath.ToNamespaced(file))));
        }
        catch
        {
            return null;
        }
    }
}
