package main

import (
	"regexp"
	"strings"
)

// rx compiles a pattern written the way the JavaScript source writes it (flag i, no lookaround, no
// backreference) into RE2: outside a class every ASCII letter becomes a two-case class, so folding is
// ASCII-only like JavaScript's, and \s and \S take JavaScript's whitespace set instead of RE2's.
// Classes are written with both cases explicitly by the caller.
func rx(src string) *regexp.Regexp {
	return regexp.MustCompile(rxSource(src))
}

func rxSource(src string) string {
	var b strings.Builder
	inClass := false
	for i := 0; i < len(src); i++ {
		c := src[i]
		switch {
		case c == '\\' && i+1 < len(src):
			i++
			switch n := src[i]; {
			case n == 's' && inClass:
				b.WriteString(jsWhitespace)
			case n == 's':
				b.WriteString("[" + jsWhitespace + "]")
			case n == 'S' && !inClass:
				b.WriteString("[^" + jsWhitespace + "]")
			case n == 'S':
				panic("rx: \\S inside a class is not supported")
			default:
				b.WriteByte('\\')
				b.WriteByte(n)
			}
		case inClass:
			b.WriteByte(c)
			if c == ']' {
				inClass = false
			}
		case c == '[':
			inClass = true
			b.WriteByte(c)
			if i+1 < len(src) && src[i+1] == '^' {
				b.WriteByte('^')
				i++
			}
		case isLetterByte(c):
			lower := c | 0x20
			b.WriteString("[" + string(lower) + string(lower&^0x20) + "]")
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}
