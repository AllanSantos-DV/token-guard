using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Slice;

/// <summary>The JavaScript coercions and string helpers the decision leans on (truthiness, String(), Number(), trim, toLowerCase, toLocaleString).</summary>
static class JsValue
{
    static readonly Rx DecimalLiteral = new(@"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$");

    /// <summary>JS <c>\s</c> and <c>String.prototype.trim</c> whitespace: not U+0085, not U+200B.</summary>
    public static bool IsWhiteSpace(char c) => c is '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or '\u00A0' or '\u1680'
        or (>= '\u2000' and <= '\u200A') or '\u2028' or '\u2029' or '\u202F' or '\u205F' or '\u3000' or '\uFEFF';

    public static ReadOnlySpan<char> Trim(ReadOnlySpan<char> s)
    {
        var a = 0;
        var b = s.Length;
        while (a < b && IsWhiteSpace(s[a]))
        {
            a++;
        }
        while (b > a && IsWhiteSpace(s[b - 1]))
        {
            b--;
        }
        return s[a..b];
    }

    public static string Trim(string s) => Trim(s.AsSpan()).ToString();

    public static string TrimEnd(string s)
    {
        var b = s.Length;
        while (b > 0 && IsWhiteSpace(s[b - 1]))
        {
            b--;
        }
        return s[..b];
    }

    /// <summary>String.prototype.toLowerCase: the invariant simple mapping plus the one expanding mapping that matters for paths (U+0130).</summary>
    public static string Lower(string s) => s.Contains('\u0130') ? s.Replace("\u0130", "i\u0307").ToLowerInvariant() : s.ToLowerInvariant();

    public static bool Truthy(object? v) => v switch
    {
        null => false,
        bool b => b,
        double d => d != 0 && !double.IsNaN(d),
        string s => s.Length > 0,
        _ => true,
    };

    /// <summary>String(v) for a parsed JSON value.</summary>
    public static string ToJsString(object? v)
    {
        switch (v)
        {
            case null: return "null";
            case bool b: return b ? "true" : "false";
            case double d: return JsNumber.Format(d);
            case string s: return s;
            case List<object?> list:
                var sb = new StringBuilder();
                for (var i = 0; i < list.Count; i++)
                {
                    if (i > 0)
                    {
                        sb.Append(',');
                    }
                    if (list[i] is not null)
                    {
                        sb.Append(ToJsString(list[i]));
                    }
                }
                return sb.ToString();
            default: return "[object Object]";
        }
    }

    /// <summary>Number(v) for a parsed JSON value; NaN when JS would give NaN.</summary>
    public static double ToNumber(object? v) => v switch
    {
        null => 0,
        bool b => b ? 1 : 0,
        double d => d,
        string s => StringToNumber(s),
        List<object?> => StringToNumber(ToJsString(v)),
        _ => double.NaN,
    };

    static double StringToNumber(string text)
    {
        var s = Trim(text);
        if (s.Length == 0)
        {
            return 0;
        }
        if (s.Length > 2 && s[0] == '0')
        {
            var radix = s[1] switch { 'x' or 'X' => 16, 'o' or 'O' => 8, 'b' or 'B' => 2, _ => 0 };
            if (radix != 0)
            {
                double acc = 0;
                for (var i = 2; i < s.Length; i++)
                {
                    var digit = s[i] switch { >= '0' and <= '9' => s[i] - '0', >= 'a' and <= 'f' => s[i] - 'a' + 10, >= 'A' and <= 'F' => s[i] - 'A' + 10, _ => 99 };
                    if (digit >= radix)
                    {
                        return double.NaN;
                    }
                    acc = acc * radix + digit;
                }
                return acc;
            }
        }
        switch (s)
        {
            case "Infinity" or "+Infinity": return double.PositiveInfinity;
            case "-Infinity": return double.NegativeInfinity;
        }
        return DecimalLiteral.IsMatch(s) ? double.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture) : double.NaN;
    }

    /// <summary>Math.round: halves go toward +Infinity.</summary>
    public static double Round(double x) => double.IsFinite(x) && Math.Abs(x) < 4503599627370496.0 ? Math.Floor(x + 0.5) : x;

    /// <summary>Number.prototype.toFixed(digits) for finite non-negative values.</summary>
    public static string ToFixed(double x, int digits) => x.ToString("F" + digits.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);

    /// <summary>Number.prototype.toLocaleString('pt-BR'): '.' groups the integer part, ',' starts at most three decimals.</summary>
    public static string Fmt(double n)
    {
        if (double.IsNaN(n))
        {
            return "NaN";
        }
        if (double.IsInfinity(n))
        {
            return n > 0 ? "\u221E" : "-\u221E";
        }
        var text = Math.Round(Math.Abs(n), 3, MidpointRounding.AwayFromZero).ToString("0.###", CultureInfo.InvariantCulture);
        var dot = text.IndexOf('.');
        var whole = dot < 0 ? text : text[..dot];
        var grouped = new StringBuilder();
        for (var i = 0; i < whole.Length; i++)
        {
            if (i > 0 && (whole.Length - i) % 3 == 0)
            {
                grouped.Append('.');
            }
            grouped.Append(whole[i]);
        }
        if (dot >= 0)
        {
            grouped.Append(',').Append(text, dot + 1, text.Length - dot - 1);
        }
        return (n < 0 && grouped.ToString() != "0" ? "-" : "") + grouped;
    }
}

/// <summary>Number to string the way JSON.stringify prints it.</summary>
static class JsNumber
{
    public static string Format(double d)
    {
        if (d == 0)
        {
            return "0";
        }
        if (d == Math.Floor(d) && Math.Abs(d) < 1e15)
        {
            return ((long)d).ToString(CultureInfo.InvariantCulture);
        }
        var r = d.ToString("R", CultureInfo.InvariantCulture);
        var e = r.IndexOf('E');
        if (e < 0)
        {
            return r;
        }
        var exp = int.Parse(r.AsSpan(e + 1), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        var mantissa = r[..e];
        var negative = mantissa.StartsWith('-');
        var digits = mantissa.TrimStart('-').Replace(".", "");
        if (exp is >= -6 and < 0)
        {
            return (negative ? "-" : "") + "0." + new string('0', -exp - 1) + digits;
        }
        if (exp is >= 15 and < 21)
        {
            return (negative ? "-" : "") + digits.PadRight(exp + 1, '0');
        }
        return mantissa + "e" + (exp > 0 ? "+" : "") + exp.ToString(CultureInfo.InvariantCulture);
    }
}
