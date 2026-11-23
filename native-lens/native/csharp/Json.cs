using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Slice;

/// <summary>JSON object; a repeated key keeps its first position and the last value, like a JS object.</summary>
sealed class JObj : Dictionary<string, object?>
{
}

sealed class JsonParseException(string message) : Exception(message);

/// <summary>Valid-looking JSON nested past what the recursive reader accepts; answered as a hostile payload (200 {}), never as invalid JSON.</summary>
sealed class JsonTooDeepException() : Exception("nesting too deep");

/// <summary>
/// Strict JSON (RFC 8259) into null/bool/double/string/List/JObj. Hand-written because a lone surrogate escape
/// must survive as a string the way JSON.parse keeps it, which System.Text.Json refuses, and because the
/// payload needs JS value semantics without reflection.
/// </summary>
static class Json
{
    const int MaxDepth = 2000;

    public static object? Parse(string text)
    {
        var pos = 0;
        var value = ParseValue(text, ref pos, 0);
        SkipWs(text, ref pos);
        if (pos != text.Length)
        {
            throw new JsonParseException($"unexpected character at {pos}");
        }
        return value;
    }

    static void SkipWs(string s, ref int pos)
    {
        while (pos < s.Length && s[pos] is ' ' or '\t' or '\n' or '\r')
        {
            pos++;
        }
    }

    static object? ParseValue(string s, ref int pos, int depth)
    {
        if (depth > MaxDepth)
        {
            throw new JsonTooDeepException();
        }
        SkipWs(s, ref pos);
        if (pos >= s.Length)
        {
            throw new JsonParseException("unexpected end");
        }
        switch (s[pos])
        {
            case '{':
                return ParseObject(s, ref pos, depth);
            case '[':
                return ParseArray(s, ref pos, depth);
            case '"':
                return ParseString(s, ref pos);
            case 't':
                Expect(s, ref pos, "true");
                return true;
            case 'f':
                Expect(s, ref pos, "false");
                return false;
            case 'n':
                Expect(s, ref pos, "null");
                return null;
            default:
                return ParseNumber(s, ref pos);
        }
    }

    static void Expect(string s, ref int pos, string word)
    {
        if (string.CompareOrdinal(s, pos, word, 0, word.Length) != 0)
        {
            throw new JsonParseException($"unexpected token at {pos}");
        }
        pos += word.Length;
    }

    static JObj ParseObject(string s, ref int pos, int depth)
    {
        var obj = new JObj();
        pos++;
        SkipWs(s, ref pos);
        if (pos < s.Length && s[pos] == '}')
        {
            pos++;
            return obj;
        }
        while (true)
        {
            SkipWs(s, ref pos);
            if (pos >= s.Length || s[pos] != '"')
            {
                throw new JsonParseException($"expected a key at {pos}");
            }
            var key = ParseString(s, ref pos);
            SkipWs(s, ref pos);
            if (pos >= s.Length || s[pos] != ':')
            {
                throw new JsonParseException($"expected ':' at {pos}");
            }
            pos++;
            obj[key] = ParseValue(s, ref pos, depth + 1);
            SkipWs(s, ref pos);
            if (pos < s.Length && s[pos] == ',')
            {
                pos++;
                continue;
            }
            if (pos < s.Length && s[pos] == '}')
            {
                pos++;
                return obj;
            }
            throw new JsonParseException($"expected ',' or '}}' at {pos}");
        }
    }

    static List<object?> ParseArray(string s, ref int pos, int depth)
    {
        var list = new List<object?>();
        pos++;
        SkipWs(s, ref pos);
        if (pos < s.Length && s[pos] == ']')
        {
            pos++;
            return list;
        }
        while (true)
        {
            list.Add(ParseValue(s, ref pos, depth + 1));
            SkipWs(s, ref pos);
            if (pos < s.Length && s[pos] == ',')
            {
                pos++;
                continue;
            }
            if (pos < s.Length && s[pos] == ']')
            {
                pos++;
                return list;
            }
            throw new JsonParseException($"expected ',' or ']' at {pos}");
        }
    }

    static string ParseString(string s, ref int pos)
    {
        pos++;
        var start = pos;
        StringBuilder? sb = null;
        while (true)
        {
            if (pos >= s.Length)
            {
                throw new JsonParseException("unterminated string");
            }
            var c = s[pos];
            if (c == '"')
            {
                var tail = sb is null ? s.Substring(start, pos - start) : sb.Append(s, start, pos - start).ToString();
                pos++;
                return tail;
            }
            if (c < 0x20)
            {
                throw new JsonParseException($"control character in string at {pos}");
            }
            if (c != '\\')
            {
                pos++;
                continue;
            }
            sb ??= new StringBuilder();
            sb.Append(s, start, pos - start);
            pos++;
            if (pos >= s.Length)
            {
                throw new JsonParseException("unterminated escape");
            }
            switch (s[pos])
            {
                case '"': sb.Append('"'); break;
                case '\\': sb.Append('\\'); break;
                case '/': sb.Append('/'); break;
                case 'b': sb.Append('\b'); break;
                case 'f': sb.Append('\f'); break;
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case 'u':
                    if (pos + 4 >= s.Length || !ushort.TryParse(s.AsSpan(pos + 1, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var unit))
                    {
                        throw new JsonParseException($"bad \\u escape at {pos}");
                    }
                    sb.Append((char)unit);
                    pos += 4;
                    break;
                default:
                    throw new JsonParseException($"bad escape at {pos}");
            }
            pos++;
            start = pos;
        }
    }

    static double ParseNumber(string s, ref int pos)
    {
        var start = pos;
        if (pos < s.Length && s[pos] == '-')
        {
            pos++;
        }
        if (pos < s.Length && s[pos] == '0')
        {
            pos++;
        }
        else if (!Digits(s, ref pos))
        {
            throw new JsonParseException($"unexpected token at {start}");
        }
        if (pos < s.Length && s[pos] == '.')
        {
            pos++;
            if (!Digits(s, ref pos))
            {
                throw new JsonParseException($"bad fraction at {pos}");
            }
        }
        if (pos < s.Length && s[pos] is 'e' or 'E')
        {
            pos++;
            if (pos < s.Length && s[pos] is '+' or '-')
            {
                pos++;
            }
            if (!Digits(s, ref pos))
            {
                throw new JsonParseException($"bad exponent at {pos}");
            }
        }
        return double.Parse(s.AsSpan(start, pos - start), NumberStyles.Float, CultureInfo.InvariantCulture);
    }

    static bool Digits(string s, ref int pos)
    {
        var from = pos;
        while (pos < s.Length && s[pos] is >= '0' and <= '9')
        {
            pos++;
        }
        return pos > from;
    }

    /// <summary>JSON.stringify of a string literal: only quote, backslash, controls and lone surrogates are escaped.</summary>
    public static string Quote(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        AppendQuoted(sb, s);
        return sb.ToString();
    }

    public static void AppendQuoted(StringBuilder sb, string s)
    {
        sb.Append('"');
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    var loneSurrogate = char.IsHighSurrogate(c) ? !(i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) : char.IsLowSurrogate(c) && !(i > 0 && char.IsHighSurrogate(s[i - 1]));
                    if (c < 0x20 || loneSurrogate)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }
                    break;
            }
        }
        sb.Append('"');
    }

    /// <summary>JSON.stringify of a parsed value (used to echo a request id).</summary>
    public static void Append(StringBuilder sb, object? v)
    {
        switch (v)
        {
            case null: sb.Append("null"); break;
            case bool b: sb.Append(b ? "true" : "false"); break;
            case double d: sb.Append(double.IsFinite(d) ? JsNumber.Format(d) : "null"); break;
            case string str: AppendQuoted(sb, str); break;
            case List<object?> list:
                sb.Append('[');
                for (var i = 0; i < list.Count; i++)
                {
                    if (i > 0)
                    {
                        sb.Append(',');
                    }
                    Append(sb, list[i]);
                }
                sb.Append(']');
                break;
            case JObj obj:
                sb.Append('{');
                var first = true;
                foreach (var (key, value) in obj)
                {
                    if (!first)
                    {
                        sb.Append(',');
                    }
                    first = false;
                    AppendQuoted(sb, key);
                    sb.Append(':');
                    Append(sb, value);
                }
                sb.Append('}');
                break;
            default:
                throw new InvalidOperationException("unsupported JSON value " + v.GetType().Name);
        }
    }
}
