package main

// JavaScript value semantics the ported rules depend on: truthiness, String(), Number(),
// trim, toLowerCase, JSON.stringify of a string, toFixed and pt-BR toLocaleString.

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// jsWhitespace lists the code points of JavaScript's WhiteSpace and LineTerminator, as RE2 class members.
const jsWhitespace = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// isJSSpace reports whether r is matched by JavaScript's \s and removed by String.prototype.trim.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func jsTrim(s string) string      { return strings.TrimFunc(s, isJSSpace) }
func jsTrimRight(s string) string { return strings.TrimRightFunc(s, isJSSpace) }
func jsFields(s string) []string  { return strings.FieldsFunc(s, isJSSpace) }

// jsLower is String.prototype.toLowerCase: per-rune lowercasing plus the one unconditional special case.
func jsLower(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == 0x130 {
			b.WriteRune('i')
			b.WriteRune(0x307)
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

// asciiLower folds only A-Z, which is how a JavaScript /i regular expression compares ASCII letters.
func asciiLower(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] >= 'A' && s[i] <= 'Z' {
			b := []byte(s)
			for j := i; j < len(b); j++ {
				if b[j] >= 'A' && b[j] <= 'Z' {
					b[j] += 'a' - 'A'
				}
			}
			return string(b)
		}
	}
	return s
}

// indexFold finds the first ASCII-case-insensitive occurrence of lower-case sub in s at or after from.
func indexFold(s, sub string, from int) int {
	n := len(sub)
	for i := from; i+n <= len(s); i++ {
		j := 0
		for ; j < n; j++ {
			c := s[i+j]
			if c >= 'A' && c <= 'Z' {
				c += 'a' - 'A'
			}
			if c != sub[j] {
				break
			}
		}
		if j == n {
			return i
		}
	}
	return -1
}

func containsFold(s, sub string) bool { return indexFold(s, sub, 0) >= 0 }

func hasSuffixFold(s, suffix string) bool {
	return len(s) >= len(suffix) && asciiLower(s[len(s)-len(suffix):]) == suffix
}

func isWordByte(c byte) bool {
	return c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isLetterByte(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }

// parseJSON is JSON.parse over a byte buffer: numbers stay json.Number so out-of-range literals survive.
func parseJSON(b []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	return v, nil
}

// get is optional chaining on a parsed JSON value: only objects have properties.
func get(v any, key string) any {
	if m, ok := v.(map[string]any); ok {
		return m[key]
	}
	return nil
}

func numOf(n json.Number) float64 {
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil && !math.IsInf(f, 0) {
		return math.NaN()
	}
	return f
}

// truthy is JavaScript's ToBoolean.
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case json.Number:
		f := numOf(t)
		return f != 0 && !math.IsNaN(f)
	}
	return true
}

// isFiniteNumber is Number.isFinite: no coercion, only a real number counts.
func isFiniteNumber(v any) (float64, bool) {
	if n, ok := v.(json.Number); ok {
		f := numOf(n)
		if !math.IsNaN(f) && !math.IsInf(f, 0) {
			return f, true
		}
	}
	return 0, false
}

// numToString is Number.prototype.toString (radix 10).
func numToString(x float64) string {
	switch {
	case math.IsNaN(x):
		return "NaN"
	case x == 0:
		return "0"
	case math.IsInf(x, 1):
		return "Infinity"
	case math.IsInf(x, -1):
		return "-Infinity"
	case x < 0:
		return "-" + numToString(-x)
	}
	mant, expS, _ := strings.Cut(strconv.FormatFloat(x, 'e', -1, 64), "e")
	exp, _ := strconv.Atoi(expS)
	digits := strings.Replace(mant, ".", "", 1)
	k, n := len(digits), exp+1
	switch {
	case k <= n && n <= 21:
		return digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + digits
	}
	e, sign := n-1, "+"
	if e < 0 {
		e, sign = -e, "-"
	}
	if k == 1 {
		return digits + "e" + sign + strconv.Itoa(e)
	}
	return digits[:1] + "." + digits[1:] + "e" + sign + strconv.Itoa(e)
}

// toStr is String(v) for a parsed JSON value.
func toStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case bool:
		return strconv.FormatBool(t)
	case string:
		return t
	case json.Number:
		return numToString(numOf(t))
	case []any:
		parts := make([]string, len(t))
		for i, e := range t {
			parts[i] = toStr(e)
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

var decimalLiteral = regexp.MustCompile(`^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

// strToNumber is Number(string): StringToNumber of the spec.
func strToNumber(s string) float64 {
	s = jsTrim(s)
	if s == "" {
		return 0
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			n, ok := new(big.Int).SetString(s[2:], base)
			if !ok || strings.ContainsAny(s[2:], "+-_") {
				return math.NaN()
			}
			f, _ := new(big.Float).SetInt(n).Float64()
			return f
		}
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if !decimalLiteral.MatchString(s) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !math.IsInf(f, 0) {
		return math.NaN()
	}
	return f
}

// toNumber is Number(v) for a parsed JSON value.
func toNumber(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case bool:
		if t {
			return 1
		}
		return 0
	case json.Number:
		return numOf(t)
	case string:
		return strToNumber(t)
	case []any:
		return strToNumber(toStr(t))
	}
	return math.NaN()
}

// jsRound is Math.round: ties go toward +Infinity.
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// jsQuote is JSON.stringify for a string value.
func jsQuote(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 2)
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20:
			b.WriteString(`\u00`)
			b.WriteByte("0123456789abcdef"[r>>4])
			b.WriteByte("0123456789abcdef"[r&15])
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// toFixed is Number.prototype.toFixed: exact decimal expansion, ties rounded up.
func toFixed(x float64, digits int) string {
	if math.IsNaN(x) || math.IsInf(x, 0) || math.Abs(x) >= 1e21 {
		return numToString(x)
	}
	sign := ""
	if x < 0 {
		sign, x = "-", -x
	}
	exact := new(big.Float).SetFloat64(x).Text('f', 1100)
	ip, fp, _ := strings.Cut(exact, ".")
	d := []byte(ip + fp[:digits])
	if fp[digits] >= '5' {
		i := len(d) - 1
		for ; i >= 0; i-- {
			if d[i] == '9' {
				d[i] = '0'
				continue
			}
			d[i]++
			break
		}
		if i < 0 {
			d = append([]byte{'1'}, d...)
		}
	}
	whole := string(d[:len(d)-digits])
	if digits == 0 {
		return sign + whole
	}
	return sign + whole + "." + string(d[len(d)-digits:])
}

// fmtPT is Number(n).toLocaleString('pt-BR'): '.' groups, ',' decimal, at most three fraction digits.
func fmtPT(x float64) string {
	switch {
	case math.IsNaN(x):
		return "NaN"
	case math.IsInf(x, 1):
		return "∞"
	case math.IsInf(x, -1):
		return "-∞"
	}
	sign := ""
	if x < 0 {
		sign, x = "-", -x
	}
	ip, fp, _ := strings.Cut(strconv.FormatFloat(x, 'f', -1, 64), ".")
	if len(fp) > 3 {
		d := []byte(ip + fp[:3])
		if fp[3] >= '5' {
			i := len(d) - 1
			for ; i >= 0; i-- {
				if d[i] == '9' {
					d[i] = '0'
					continue
				}
				d[i]++
				break
			}
			if i < 0 {
				d = append([]byte{'1'}, d...)
			}
		}
		ip, fp = string(d[:len(d)-3]), string(d[len(d)-3:])
	}
	fp = strings.TrimRight(fp, "0")
	var g strings.Builder
	for i := 0; i < len(ip); i++ {
		if i > 0 && (len(ip)-i)%3 == 0 {
			g.WriteByte('.')
		}
		g.WriteByte(ip[i])
	}
	out := sign + g.String()
	if fp != "" {
		out += "," + fp
	}
	return out
}
