using System;
using System.Text;

namespace Slice;

/// <summary>
/// Node's <c>path.win32</c> (resolve, normalize, join, relative, dirname, basename, extname, isAbsolute) and
/// <c>path.posix.normalize</c>, ported so the guard compares paths the way the reference does on Windows, on any OS.
/// </summary>
static class WinPath
{
    static bool IsSep(char c) => c is '/' or '\\';

    static bool IsPosixSep(char c) => c == '/';

    static bool IsDeviceRoot(char c) => char.IsAsciiLetter(c);

    static string NormalizeString(string path, bool allowAboveRoot, char separator, Func<char, bool> isSep)
    {
        var res = "";
        var lastSegmentLength = 0;
        var lastSlash = -1;
        var dots = 0;
        var code = '\0';
        for (var i = 0; i <= path.Length; ++i)
        {
            if (i < path.Length)
            {
                code = path[i];
            }
            else if (isSep(code))
            {
                break;
            }
            else
            {
                code = '/';
            }
            if (isSep(code))
            {
                if (lastSlash == i - 1 || dots == 1)
                {
                }
                else if (dots == 2)
                {
                    if (res.Length < 2 || lastSegmentLength != 2 || res[^1] != '.' || res[^2] != '.')
                    {
                        if (res.Length > 2)
                        {
                            var lastSlashIndex = res.LastIndexOf(separator);
                            if (lastSlashIndex == -1)
                            {
                                res = "";
                                lastSegmentLength = 0;
                            }
                            else
                            {
                                res = res[..lastSlashIndex];
                                lastSegmentLength = res.Length - 1 - res.LastIndexOf(separator);
                            }
                            lastSlash = i;
                            dots = 0;
                            continue;
                        }
                        if (res.Length != 0)
                        {
                            res = "";
                            lastSegmentLength = 0;
                            lastSlash = i;
                            dots = 0;
                            continue;
                        }
                    }
                    if (allowAboveRoot)
                    {
                        res += res.Length > 0 ? separator + ".." : "..";
                        lastSegmentLength = 2;
                    }
                }
                else
                {
                    var part = path.Substring(lastSlash + 1, i - lastSlash - 1);
                    res = res.Length > 0 ? res + separator + part : part;
                    lastSegmentLength = i - lastSlash - 1;
                }
                lastSlash = i;
                dots = 0;
            }
            else if (code == '.' && dots != -1)
            {
                ++dots;
            }
            else
            {
                dots = -1;
            }
        }
        return res;
    }

    public static bool IsAbsolute(string path)
    {
        var len = path.Length;
        if (len == 0)
        {
            return false;
        }
        var code = path[0];
        return IsSep(code) || (len > 2 && IsDeviceRoot(code) && path[1] == ':' && IsSep(path[2]));
    }

    /// <summary>path.win32.resolve(...args); an empty segment is skipped, the process working directory completes a relative result.</summary>
    public static string Resolve(params string[] args)
    {
        var resolvedDevice = "";
        var resolvedTail = "";
        var resolvedAbsolute = false;
        for (var i = args.Length - 1; i >= -1; i--)
        {
            string path;
            if (i >= 0)
            {
                path = args[i];
                if (path.Length == 0)
                {
                    continue;
                }
            }
            else if (resolvedDevice.Length == 0)
            {
                path = Host.Cwd;
            }
            else
            {
                var perDrive = Environment.GetEnvironmentVariable("=" + resolvedDevice);
                path = string.IsNullOrEmpty(perDrive) ? Host.Cwd : perDrive;
                if (JsValue.Lower(Head(path, 2)) != JsValue.Lower(resolvedDevice) && path.Length > 2 && path[2] == '\\')
                {
                    path = resolvedDevice + "\\";
                }
            }
            var len = path.Length;
            var rootEnd = 0;
            var device = "";
            var isAbsolute = false;
            var code = len > 0 ? path[0] : '\0';
            if (len == 1)
            {
                if (IsSep(code))
                {
                    rootEnd = 1;
                    isAbsolute = true;
                }
            }
            else if (len > 1 && IsSep(code))
            {
                isAbsolute = true;
                if (IsSep(path[1]))
                {
                    var j = 2;
                    var last = j;
                    while (j < len && !IsSep(path[j]))
                    {
                        j++;
                    }
                    if (j < len && j != last)
                    {
                        var firstPart = path.Substring(last, j - last);
                        last = j;
                        while (j < len && IsSep(path[j]))
                        {
                            j++;
                        }
                        if (j < len && j != last)
                        {
                            last = j;
                            while (j < len && !IsSep(path[j]))
                            {
                                j++;
                            }
                            if (j == len || j != last)
                            {
                                device = "\\\\" + firstPart + "\\" + path.Substring(last, j - last);
                                rootEnd = j;
                            }
                        }
                    }
                }
                else
                {
                    rootEnd = 1;
                }
            }
            else if (len > 1 && IsDeviceRoot(code) && path[1] == ':')
            {
                device = path[..2];
                rootEnd = 2;
                if (len > 2 && IsSep(path[2]))
                {
                    isAbsolute = true;
                    rootEnd = 3;
                }
            }
            if (device.Length > 0)
            {
                if (resolvedDevice.Length > 0)
                {
                    if (JsValue.Lower(device) != JsValue.Lower(resolvedDevice))
                    {
                        continue;
                    }
                }
                else
                {
                    resolvedDevice = device;
                }
            }
            if (resolvedAbsolute)
            {
                if (resolvedDevice.Length > 0)
                {
                    break;
                }
            }
            else
            {
                resolvedTail = path[rootEnd..] + "\\" + resolvedTail;
                resolvedAbsolute = isAbsolute;
                if (isAbsolute && resolvedDevice.Length > 0)
                {
                    break;
                }
            }
        }
        resolvedTail = NormalizeString(resolvedTail, !resolvedAbsolute, '\\', IsSep);
        if (resolvedAbsolute)
        {
            return resolvedDevice + "\\" + resolvedTail;
        }
        var relative = resolvedDevice + resolvedTail;
        return relative.Length > 0 ? relative : ".";
    }

    static string Head(string s, int n) => s.Length <= n ? s : s[..n];

    /// <summary>path.win32.normalize.</summary>
    public static string Normalize(string path)
    {
        var len = path.Length;
        if (len == 0)
        {
            return ".";
        }
        var rootEnd = 0;
        string? device = null;
        var isAbsolute = false;
        var code = path[0];
        if (len == 1)
        {
            return IsPosixSep(code) ? "\\" : path;
        }
        if (IsSep(code))
        {
            isAbsolute = true;
            if (IsSep(path[1]))
            {
                var j = 2;
                var last = j;
                while (j < len && !IsSep(path[j]))
                {
                    j++;
                }
                if (j < len && j != last)
                {
                    var firstPart = path.Substring(last, j - last);
                    last = j;
                    while (j < len && IsSep(path[j]))
                    {
                        j++;
                    }
                    if (j < len && j != last)
                    {
                        last = j;
                        while (j < len && !IsSep(path[j]))
                        {
                            j++;
                        }
                        if (j == len)
                        {
                            return "\\\\" + firstPart + "\\" + path[last..] + "\\";
                        }
                        if (j != last)
                        {
                            device = "\\\\" + firstPart + "\\" + path.Substring(last, j - last);
                            rootEnd = j;
                        }
                    }
                }
            }
            else
            {
                rootEnd = 1;
            }
        }
        else if (IsDeviceRoot(code) && path[1] == ':')
        {
            device = path[..2];
            rootEnd = 2;
            if (len > 2 && IsSep(path[2]))
            {
                isAbsolute = true;
                rootEnd = 3;
            }
        }
        var tail = rootEnd < len ? NormalizeString(path[rootEnd..], !isAbsolute, '\\', IsSep) : "";
        if (tail.Length == 0 && !isAbsolute)
        {
            tail = ".";
        }
        if (tail.Length > 0 && IsSep(path[len - 1]))
        {
            tail += "\\";
        }
        if (!isAbsolute && device is null && path.Contains(':'))
        {
            if (tail.Length >= 2 && IsDeviceRoot(tail[0]) && tail[1] == ':')
            {
                return ".\\" + tail;
            }
            var index = path.IndexOf(':');
            do
            {
                if (index == len - 1 || IsSep(path[index + 1]))
                {
                    return ".\\" + tail;
                }
            }
            while ((index = path.IndexOf(':', index + 1)) != -1);
        }
        if (device is null)
        {
            return isAbsolute ? "\\" + tail : tail;
        }
        return isAbsolute ? device + "\\" + tail : device + tail;
    }

    /// <summary>path.win32.join(...args).</summary>
    public static string Join(params string[] args)
    {
        string? joined = null;
        string firstPart = "";
        foreach (var arg in args)
        {
            if (arg.Length == 0)
            {
                continue;
            }
            if (joined is null)
            {
                joined = firstPart = arg;
            }
            else
            {
                joined += "\\" + arg;
            }
        }
        if (joined is null)
        {
            return ".";
        }
        var needsReplace = true;
        var slashCount = 0;
        if (IsSep(firstPart[0]))
        {
            ++slashCount;
            var firstLen = firstPart.Length;
            if (firstLen > 1 && IsSep(firstPart[1]))
            {
                ++slashCount;
                if (firstLen > 2)
                {
                    if (IsSep(firstPart[2]))
                    {
                        ++slashCount;
                    }
                    else
                    {
                        needsReplace = false;
                    }
                }
            }
        }
        if (needsReplace)
        {
            while (slashCount < joined.Length && IsSep(joined[slashCount]))
            {
                slashCount++;
            }
            if (slashCount >= 2)
            {
                joined = "\\" + joined[slashCount..];
            }
        }
        return Normalize(joined);
    }

    /// <summary>path.win32.relative(from, to): both sides resolved and compared without case.</summary>
    public static string Relative(string from, string to)
    {
        if (from == to)
        {
            return "";
        }
        var fromOrig = Resolve(from);
        var toOrig = Resolve(to);
        if (fromOrig == toOrig)
        {
            return "";
        }
        from = JsValue.Lower(fromOrig);
        to = JsValue.Lower(toOrig);
        if (from == to)
        {
            return "";
        }
        var fromStart = 0;
        while (fromStart < from.Length && from[fromStart] == '\\')
        {
            fromStart++;
        }
        var fromEnd = from.Length;
        while (fromEnd - 1 > fromStart && from[fromEnd - 1] == '\\')
        {
            fromEnd--;
        }
        var fromLen = fromEnd - fromStart;
        var toStart = 0;
        while (toStart < to.Length && to[toStart] == '\\')
        {
            toStart++;
        }
        var toEnd = to.Length;
        while (toEnd - 1 > toStart && to[toEnd - 1] == '\\')
        {
            toEnd--;
        }
        var toLen = toEnd - toStart;
        var length = fromLen < toLen ? fromLen : toLen;
        var lastCommonSep = -1;
        var i = 0;
        for (; i < length; i++)
        {
            var fromCode = from[fromStart + i];
            if (fromCode != to[toStart + i])
            {
                break;
            }
            if (fromCode == '\\')
            {
                lastCommonSep = i;
            }
        }
        if (i != length)
        {
            if (lastCommonSep == -1)
            {
                return toOrig;
            }
        }
        else
        {
            if (toLen > length)
            {
                if (to[toStart + i] == '\\')
                {
                    return toOrig[(toStart + i + 1)..];
                }
                if (i == 2)
                {
                    return toOrig[(toStart + i)..];
                }
            }
            if (fromLen > length)
            {
                if (from[fromStart + i] == '\\')
                {
                    lastCommonSep = i;
                }
                else if (i == 2)
                {
                    lastCommonSep = 3;
                }
            }
            if (lastCommonSep == -1)
            {
                lastCommonSep = 0;
            }
        }
        var outp = new StringBuilder();
        for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i)
        {
            if (i == fromEnd || from[i] == '\\')
            {
                outp.Append(outp.Length == 0 ? ".." : "\\..");
            }
        }
        toStart += lastCommonSep;
        if (outp.Length > 0)
        {
            return outp + toOrig[toStart..toEnd];
        }
        if (toStart < toOrig.Length && toOrig[toStart] == '\\')
        {
            ++toStart;
        }
        return toOrig[toStart..toEnd];
    }

    /// <summary>path.win32.dirname.</summary>
    public static string Dirname(string path)
    {
        var len = path.Length;
        if (len == 0)
        {
            return ".";
        }
        var rootEnd = -1;
        var offset = 0;
        var code = path[0];
        if (len == 1)
        {
            return IsSep(code) ? path : ".";
        }
        if (IsSep(code))
        {
            rootEnd = offset = 1;
            if (IsSep(path[1]))
            {
                var j = 2;
                var last = j;
                while (j < len && !IsSep(path[j]))
                {
                    j++;
                }
                if (j < len && j != last)
                {
                    last = j;
                    while (j < len && IsSep(path[j]))
                    {
                        j++;
                    }
                    if (j < len && j != last)
                    {
                        last = j;
                        while (j < len && !IsSep(path[j]))
                        {
                            j++;
                        }
                        if (j == len)
                        {
                            return path;
                        }
                        if (j != last)
                        {
                            rootEnd = offset = j + 1;
                        }
                    }
                }
            }
        }
        else if (IsDeviceRoot(code) && path[1] == ':')
        {
            rootEnd = len > 2 && IsSep(path[2]) ? 3 : 2;
            offset = rootEnd;
        }
        var end = -1;
        var matchedSlash = true;
        for (var i = len - 1; i >= offset; --i)
        {
            if (IsSep(path[i]))
            {
                if (!matchedSlash)
                {
                    end = i;
                    break;
                }
            }
            else
            {
                matchedSlash = false;
            }
        }
        if (end == -1)
        {
            if (rootEnd == -1)
            {
                return ".";
            }
            end = rootEnd;
        }
        return path[..end];
    }

    /// <summary>path.win32.basename(path), no suffix.</summary>
    public static string Basename(string path)
    {
        var start = 0;
        var end = -1;
        var matchedSlash = true;
        if (path.Length >= 2 && IsDeviceRoot(path[0]) && path[1] == ':')
        {
            start = 2;
        }
        for (var i = path.Length - 1; i >= start; --i)
        {
            if (IsSep(path[i]))
            {
                if (!matchedSlash)
                {
                    start = i + 1;
                    break;
                }
            }
            else if (end == -1)
            {
                matchedSlash = false;
                end = i + 1;
            }
        }
        return end == -1 ? "" : path[start..end];
    }

    /// <summary>path.win32.extname.</summary>
    public static string Extname(string path)
    {
        var start = 0;
        var startDot = -1;
        var startPart = 0;
        var end = -1;
        var matchedSlash = true;
        var preDotState = 0;
        if (path.Length >= 2 && path[1] == ':' && IsDeviceRoot(path[0]))
        {
            start = startPart = 2;
        }
        for (var i = path.Length - 1; i >= start; --i)
        {
            var code = path[i];
            if (IsSep(code))
            {
                if (!matchedSlash)
                {
                    startPart = i + 1;
                    break;
                }
                continue;
            }
            if (end == -1)
            {
                matchedSlash = false;
                end = i + 1;
            }
            if (code == '.')
            {
                if (startDot == -1)
                {
                    startDot = i;
                }
                else if (preDotState != 1)
                {
                    preDotState = 1;
                }
            }
            else if (startDot != -1)
            {
                preDotState = -1;
            }
        }
        if (startDot == -1 || end == -1 || preDotState == 0 || (preDotState == 1 && startDot == end - 1 && startDot == startPart + 1))
        {
            return "";
        }
        return path[startDot..end];
    }

    /// <summary>
    /// path.win32.toNamespacedPath: the long-path form Node hands to every fs call, so the OS does no
    /// further normalization (a trailing dot or space names a different, usually missing, file).
    /// </summary>
    public static string ToNamespaced(string path)
    {
        if (path.Length == 0)
        {
            return path;
        }
        var resolved = Resolve(path);
        if (resolved.Length <= 2)
        {
            return path;
        }
        if (resolved[0] == '\\')
        {
            if (resolved[1] == '\\' && resolved.Length > 2 && resolved[2] is not ('?' or '.'))
            {
                return "\\\\?\\UNC\\" + resolved[2..];
            }
        }
        else if (IsDeviceRoot(resolved[0]) && resolved[1] == ':' && resolved.Length > 2 && resolved[2] == '\\')
        {
            return "\\\\?\\" + resolved;
        }
        return path;
    }

    /// <summary>path.posix.normalize.</summary>
    public static string PosixNormalize(string path)
    {
        if (path.Length == 0)
        {
            return ".";
        }
        var isAbsolute = path[0] == '/';
        var trailingSeparator = path[^1] == '/';
        path = NormalizeString(path, !isAbsolute, '/', IsPosixSep);
        if (path.Length == 0)
        {
            if (isAbsolute)
            {
                return "/";
            }
            return trailingSeparator ? "./" : ".";
        }
        if (trailingSeparator)
        {
            path += "/";
        }
        return isAbsolute ? "/" + path : path;
    }
}
