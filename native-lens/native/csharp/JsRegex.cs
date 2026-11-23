using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;

namespace Slice;

/// <summary>
/// A JavaScript regular expression, given as the exact source of the reference literal, built on first use.
/// The source is translated to .NET syntax by <see cref="JsRegex.Translate"/> so that the matching is the one
/// JavaScript does (non-Unicode mode): ASCII-only <c>\w</c> and <c>\b</c>, the JS whitespace set for <c>\s</c>,
/// <c>$</c> and <c>.</c> with JS line terminators, and ASCII-only case folding for the <c>i</c> flag.
/// </summary>
sealed class Rx(string jsSource, bool ignoreCase = false)
{
    Regex? _re;

    Regex Re => _re ??= new Regex(JsRegex.Translate(jsSource, ignoreCase), RegexOptions.CultureInvariant);

    public bool IsMatch(string s) => Re.IsMatch(s);

    public Match Match(string s) => Re.Match(s);

    public MatchCollection Matches(string s) => Re.Matches(s);

    public string Replace(string s, string replacement) => Re.Replace(s, replacement);

    public string Replace(string s, MatchEvaluator evaluator) => Re.Replace(s, evaluator);

    public string ReplaceFirst(string s, string replacement) => Re.Replace(s, replacement, 1);

    public string[] Split(string s) => Re.Split(s);
}

/// <summary>JavaScript regex source to .NET regex source. Only the constructs the guard uses are accepted; anything else throws, so a new rule cannot silently match differently.</summary>
static class JsRegex
{
    const string Ws = @"\t\n\u000B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";
    const string Word = "A-Za-z0-9_";
    const string WordClass = "[" + Word + "]";
    const string WordBoundary = "(?:(?<=" + WordClass + ")(?!" + WordClass + ")|(?<!" + WordClass + ")(?=" + WordClass + "))";
    const string AnyChar = @"[^\n\r\u2028\u2029]";

    public static string Translate(string s, bool ignoreCase)
    {
        var sb = new StringBuilder(s.Length + 32);
        var i = 0;
        while (i < s.Length)
        {
            var c = s[i];
            switch (c)
            {
                case '\\':
                    i = Escape(s, i, sb);
                    break;
                case '[':
                    i = Class(s, i, sb, ignoreCase);
                    break;
                case '(':
                    sb.Append('(');
                    i++;
                    if (i < s.Length && s[i] == '?')
                    {
                        if (i + 1 >= s.Length || s[i + 1] is not (':' or '=' or '!'))
                        {
                            throw new FormatException("unsupported group syntax in /" + s + "/");
                        }
                        sb.Append('?').Append(s[i + 1]);
                        i += 2;
                    }
                    break;
                case '.':
                    sb.Append(AnyChar);
                    i++;
                    break;
                case '$':
                    sb.Append(@"\z");
                    i++;
                    break;
                default:
                    if (ignoreCase && char.IsAsciiLetter(c))
                    {
                        sb.Append('[').Append(char.ToLowerInvariant(c)).Append(char.ToUpperInvariant(c)).Append(']');
                    }
                    else
                    {
                        sb.Append(c);
                    }
                    i++;
                    break;
            }
        }
        return sb.ToString();
    }

    static int Escape(string s, int i, StringBuilder sb)
    {
        var e = s[i + 1];
        switch (e)
        {
            case 's': sb.Append('[').Append(Ws).Append(']'); break;
            case 'S': sb.Append("[^").Append(Ws).Append(']'); break;
            case 'w': sb.Append(WordClass); break;
            case 'W': sb.Append("[^").Append(Word).Append(']'); break;
            case 'd': sb.Append("[0-9]"); break;
            case 'D': sb.Append("[^0-9]"); break;
            case 'b': sb.Append(WordBoundary); break;
            case 'n' or 'r' or 't' or 'f' or 'v': sb.Append('\\').Append(e); break;
            case >= '1' and <= '9':
                sb.Append(@"\k<").Append(e).Append('>');
                break;
            default:
                if (char.IsAsciiLetterOrDigit(e))
                {
                    throw new FormatException("unsupported escape \\" + e + " in /" + s + "/");
                }
                sb.Append('\\').Append(e);
                break;
        }
        return i + 2;
    }

    static int Class(string s, int i, StringBuilder sb, bool ignoreCase)
    {
        if (string.CompareOrdinal(s, i, @"[\s\S]", 0, 6) == 0)
        {
            sb.Append("(?s:.)");
            return i + 6;
        }
        i++;
        var negated = i < s.Length && s[i] == '^';
        if (negated)
        {
            i++;
        }
        var raw = new StringBuilder();
        var ranges = new List<(int Lo, int Hi)>();
        while (true)
        {
            if (i >= s.Length)
            {
                throw new FormatException("unterminated class in /" + s + "/");
            }
            if (s[i] == ']')
            {
                i++;
                break;
            }
            var lo = Atom(s, ref i, raw);
            if (lo < 0)
            {
                continue;
            }
            var hi = lo;
            if (i + 1 < s.Length && s[i] == '-' && s[i + 1] != ']')
            {
                i++;
                hi = Atom(s, ref i, raw);
                if (hi < lo)
                {
                    throw new FormatException("bad class range in /" + s + "/");
                }
            }
            ranges.Add((lo, hi));
        }
        sb.Append('[');
        if (negated)
        {
            sb.Append('^');
        }
        sb.Append(raw);
        foreach (var (lo, hi) in ranges)
        {
            Emit(sb, lo, hi);
            if (!ignoreCase)
            {
                continue;
            }
            var l1 = Math.Max(lo, 'a');
            var h1 = Math.Min(hi, 'z');
            if (l1 <= h1)
            {
                Emit(sb, l1 - 32, h1 - 32);
            }
            var l2 = Math.Max(lo, 'A');
            var h2 = Math.Min(hi, 'Z');
            if (l2 <= h2)
            {
                Emit(sb, l2 + 32, h2 + 32);
            }
        }
        sb.Append(']');
        return i;
    }

    /// <summary>One class member: the literal code unit, or -1 after appending a shorthand class (\s \w \d) to <paramref name="raw"/>.</summary>
    static int Atom(string s, ref int i, StringBuilder raw)
    {
        var c = s[i++];
        if (c != '\\')
        {
            return c;
        }
        var e = s[i++];
        switch (e)
        {
            case 's': raw.Append(Ws); return -1;
            case 'w': raw.Append(Word); return -1;
            case 'd': raw.Append("0-9"); return -1;
            case 'n': return '\n';
            case 'r': return '\r';
            case 't': return '\t';
            case 'f': return '\f';
            case 'v': return '\v';
            default:
                if (char.IsAsciiLetterOrDigit(e))
                {
                    throw new FormatException("unsupported class escape \\" + e + " in /" + s + "/");
                }
                return e;
        }
    }

    static void Emit(StringBuilder sb, int lo, int hi)
    {
        EmitChar(sb, lo);
        if (hi != lo)
        {
            sb.Append('-');
            EmitChar(sb, hi);
        }
    }

    static void EmitChar(StringBuilder sb, int c)
    {
        if (c is '\\' or ']' or '[' or '^' or '-')
        {
            sb.Append('\\').Append((char)c);
        }
        else if (c < 0x20 || c > 0x7E)
        {
            sb.Append(@"\u").Append(c.ToString("X4"));
        }
        else
        {
            sb.Append((char)c);
        }
    }
}
