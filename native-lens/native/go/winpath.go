package main

// Node's Windows path functions rewritten over two-byte code units (so lengths match JavaScript
// strings), the posix normalize, and the home and temp directory lookups as Node reads them on
// Windows. The slice behaves as Windows on every OS.

import (
	"os"
	"strings"
	"unicode/utf16"
)

type u16 = []uint16

func enc(s string) u16 { return utf16.Encode([]rune(s)) }
func dec(u u16) string { return string(utf16.Decode(u)) }

func isSep(c uint16) bool      { return c == '/' || c == '\\' }
func isPosixSep(c uint16) bool { return c == '/' }
func isDevRoot(c uint16) bool  { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') }

func at(p u16, i int) uint16 {
	if i < 0 || i >= len(p) {
		return 0
	}
	return p[i]
}

func lastIndexU16(p u16, c uint16) int {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == c {
			return i
		}
	}
	return -1
}

func lowerU16(p u16) u16 { return enc(jsLower(dec(p))) }

func normalizeString(path u16, allowAboveRoot bool, sep uint16, isSepFn func(uint16) bool) u16 {
	res := u16{}
	lastSegmentLength := 0
	lastSlash := -1
	dots := 0
	var code uint16
	for i := 0; i <= len(path); i++ {
		if i < len(path) {
			code = path[i]
		} else if isSepFn(code) {
			break
		} else {
			code = '/'
		}
		if isSepFn(code) {
			if lastSlash == i-1 || dots == 1 {
				// empty or "." segment
			} else if dots == 2 {
				if len(res) < 2 || lastSegmentLength != 2 || res[len(res)-1] != '.' || res[len(res)-2] != '.' {
					if len(res) > 2 {
						if idx := lastIndexU16(res, sep); idx == -1 {
							res = res[:0]
							lastSegmentLength = 0
						} else {
							res = res[:idx]
							lastSegmentLength = len(res) - 1 - lastIndexU16(res, sep)
						}
						lastSlash = i
						dots = 0
						continue
					} else if len(res) != 0 {
						res = res[:0]
						lastSegmentLength = 0
						lastSlash = i
						dots = 0
						continue
					}
				}
				if allowAboveRoot {
					if len(res) > 0 {
						res = append(res, sep, '.', '.')
					} else {
						res = append(res, '.', '.')
					}
					lastSegmentLength = 2
				}
			} else {
				if len(res) > 0 {
					res = append(res, sep)
				}
				res = append(res, path[lastSlash+1:i]...)
				lastSegmentLength = i - lastSlash - 1
			}
			lastSlash = i
			dots = 0
		} else if code == '.' && dots != -1 {
			dots++
		} else {
			dots = -1
		}
	}
	return res
}

// posixNormalize is path.posix.normalize.
func posixNormalize(s string) string {
	p := enc(s)
	if len(p) == 0 {
		return "."
	}
	isAbs := p[0] == '/'
	trailing := p[len(p)-1] == '/'
	n := normalizeString(p, !isAbs, '/', isPosixSep)
	if len(n) == 0 {
		if isAbs {
			return "/"
		}
		if trailing {
			return "./"
		}
		return "."
	}
	out := dec(n)
	if trailing {
		out += "/"
	}
	if isAbs {
		return "/" + out
	}
	return out
}

// uncRoot scans a `\\server\share` prefix. ok is false when the prefix is not a complete UNC root;
// j is where the share name ends.
func uncRoot(path u16) (firstPart, share u16, j int, ok bool) {
	n := len(path)
	j = 2
	last := j
	for j < n && !isSep(path[j]) {
		j++
	}
	if j < n && j != last {
		firstPart = path[last:j]
		last = j
		for j < n && isSep(path[j]) {
			j++
		}
		if j < n && j != last {
			last = j
			for j < n && !isSep(path[j]) {
				j++
			}
			if j == n || j != last {
				return firstPart, path[last:j], j, true
			}
		}
	}
	return nil, nil, j, false
}

func cwd() string {
	d, err := os.Getwd()
	if err != nil {
		return ""
	}
	return d
}

// win32Resolve is path.win32.resolve.
func win32Resolve(args ...string) string {
	resolvedDevice := ""
	var resolvedTail u16
	resolvedAbsolute := false
	for i := len(args) - 1; i >= -1; i-- {
		var path u16
		if i >= 0 {
			path = enc(args[i])
			if len(path) == 0 {
				continue
			}
		} else if resolvedDevice == "" {
			path = enc(cwd())
		} else {
			s := os.Getenv("=" + resolvedDevice)
			if s == "" {
				s = cwd()
			}
			path = enc(s)
			head := path
			if len(head) > 2 {
				head = head[:2]
			}
			if jsLower(dec(head)) != jsLower(resolvedDevice) && at(path, 2) == '\\' {
				path = enc(resolvedDevice + "\\")
			}
		}

		n := len(path)
		rootEnd := 0
		device := ""
		isAbsolute := false
		code := at(path, 0)

		if n == 1 {
			if isSep(code) {
				rootEnd = 1
				isAbsolute = true
			}
		} else if isSep(code) {
			isAbsolute = true
			if isSep(at(path, 1)) {
				if first, share, j, ok := uncRoot(path); ok {
					device = `\\` + dec(first) + `\` + dec(share)
					rootEnd = j
				}
			} else {
				rootEnd = 1
			}
		} else if isDevRoot(code) && at(path, 1) == ':' {
			device = dec(path[:2])
			rootEnd = 2
			if n > 2 && isSep(at(path, 2)) {
				isAbsolute = true
				rootEnd = 3
			}
		}

		if len(device) > 0 {
			if len(resolvedDevice) > 0 {
				if jsLower(device) != jsLower(resolvedDevice) {
					continue
				}
			} else {
				resolvedDevice = device
			}
		}

		if resolvedAbsolute {
			if len(resolvedDevice) > 0 {
				break
			}
		} else {
			tail := append(u16{}, path[rootEnd:]...)
			tail = append(tail, '\\')
			resolvedTail = append(tail, resolvedTail...)
			resolvedAbsolute = isAbsolute
			if isAbsolute && len(resolvedDevice) > 0 {
				break
			}
		}
	}

	tail := dec(normalizeString(resolvedTail, !resolvedAbsolute, '\\', isSep))
	if resolvedAbsolute {
		return resolvedDevice + `\` + tail
	}
	if r := resolvedDevice + tail; r != "" {
		return r
	}
	return "."
}

// win32Normalize is path.win32.normalize.
func win32Normalize(s string) string {
	path := enc(s)
	n := len(path)
	if n == 0 {
		return "."
	}
	rootEnd := 0
	device := ""
	hasDevice := false
	isAbsolute := false
	code := path[0]
	if n == 1 {
		if isPosixSep(code) {
			return `\`
		}
		return s
	}
	if isSep(code) {
		isAbsolute = true
		if isSep(path[1]) {
			j := 2
			last := j
			for j < n && !isSep(path[j]) {
				j++
			}
			if j < n && j != last {
				firstPart := path[last:j]
				last = j
				for j < n && isSep(path[j]) {
					j++
				}
				if j < n && j != last {
					last = j
					for j < n && !isSep(path[j]) {
						j++
					}
					if j == n {
						return `\\` + dec(firstPart) + `\` + dec(path[last:]) + `\`
					}
					if j != last {
						device = `\\` + dec(firstPart) + `\` + dec(path[last:j])
						hasDevice = true
						rootEnd = j
					}
				}
			}
		} else {
			rootEnd = 1
		}
	} else if isDevRoot(code) && path[1] == ':' {
		device = dec(path[:2])
		hasDevice = true
		rootEnd = 2
		if n > 2 && isSep(path[2]) {
			isAbsolute = true
			rootEnd = 3
		}
	}

	tail := ""
	if rootEnd < n {
		tail = dec(normalizeString(path[rootEnd:], !isAbsolute, '\\', isSep))
	}
	if tail == "" && !isAbsolute {
		tail = "."
	}
	if tail != "" && isSep(path[n-1]) {
		tail += `\`
	}
	if !hasDevice {
		if isAbsolute {
			return `\` + tail
		}
		return tail
	}
	if isAbsolute {
		return device + `\` + tail
	}
	return device + tail
}

// win32IsAbsolute is path.win32.isAbsolute.
func win32IsAbsolute(s string) bool {
	p := enc(s)
	if len(p) == 0 {
		return false
	}
	return isSep(p[0]) || (len(p) > 2 && isDevRoot(p[0]) && p[1] == ':' && isSep(p[2]))
}

// win32Join is path.win32.join.
func win32Join(args ...string) string {
	var joined, firstPart string
	started := false
	for _, a := range args {
		if len(a) > 0 {
			if !started {
				joined, firstPart, started = a, a, true
			} else {
				joined += `\` + a
			}
		}
	}
	if !started {
		return "."
	}
	needsReplace := true
	slashCount := 0
	fp := enc(firstPart)
	if isSep(fp[0]) {
		slashCount++
		if len(fp) > 1 && isSep(fp[1]) {
			slashCount++
			if len(fp) > 2 {
				if isSep(fp[2]) {
					slashCount++
				} else {
					needsReplace = false
				}
			}
		}
	}
	if needsReplace {
		j := enc(joined)
		for slashCount < len(j) && isSep(j[slashCount]) {
			slashCount++
		}
		if slashCount >= 2 {
			joined = `\` + dec(j[slashCount:])
		}
	}
	return win32Normalize(joined)
}

// sliceU16 is String.prototype.slice for non-negative bounds: out-of-range clamps.
func sliceU16(p u16, from, to int) u16 {
	if to > len(p) {
		to = len(p)
	}
	if from > to {
		from = to
	}
	return p[from:to]
}

// win32Relative is path.win32.relative.
func win32Relative(fromArg, toArg string) string {
	if fromArg == toArg {
		return ""
	}
	fromOrigS := win32Resolve(fromArg)
	toOrigS := win32Resolve(toArg)
	if fromOrigS == toOrigS {
		return ""
	}
	toOrig := enc(toOrigS)
	from := lowerU16(enc(fromOrigS))
	to := lowerU16(toOrig)
	if dec(from) == dec(to) {
		return ""
	}

	fromStart := 0
	for fromStart < len(from) && from[fromStart] == '\\' {
		fromStart++
	}
	fromEnd := len(from)
	for fromEnd-1 > fromStart && from[fromEnd-1] == '\\' {
		fromEnd--
	}
	fromLen := fromEnd - fromStart

	toStart := 0
	for toStart < len(to) && to[toStart] == '\\' {
		toStart++
	}
	toEnd := len(to)
	for toEnd-1 > toStart && to[toEnd-1] == '\\' {
		toEnd--
	}
	toLen := toEnd - toStart

	length := fromLen
	if toLen < fromLen {
		length = toLen
	}
	lastCommonSep := -1
	i := 0
	for ; i < length; i++ {
		fc := from[fromStart+i]
		if fc != to[toStart+i] {
			break
		} else if fc == '\\' {
			lastCommonSep = i
		}
	}

	if i != length {
		if lastCommonSep == -1 {
			return toOrigS
		}
	} else {
		if toLen > length {
			if to[toStart+i] == '\\' {
				return dec(sliceU16(toOrig, toStart+i+1, len(toOrig)))
			}
			if i == 2 {
				return dec(sliceU16(toOrig, toStart+i, len(toOrig)))
			}
		}
		if fromLen > length {
			if from[fromStart+i] == '\\' {
				lastCommonSep = i
			} else if i == 2 {
				lastCommonSep = 3
			}
		}
		if lastCommonSep == -1 {
			lastCommonSep = 0
		}
	}

	out := ""
	for i = fromStart + lastCommonSep + 1; i <= fromEnd; i++ {
		if i == fromEnd || from[i] == '\\' {
			if out == "" {
				out += ".."
			} else {
				out += `\..`
			}
		}
	}

	toStart += lastCommonSep
	if len(out) > 0 {
		return out + dec(sliceU16(toOrig, toStart, toEnd))
	}
	if at(toOrig, toStart) == '\\' {
		toStart++
	}
	return dec(sliceU16(toOrig, toStart, toEnd))
}

// win32Dirname is path.win32.dirname.
func win32Dirname(s string) string {
	path := enc(s)
	n := len(path)
	if n == 0 {
		return "."
	}
	rootEnd := -1
	offset := 0
	code := path[0]
	if n == 1 {
		if isSep(code) {
			return s
		}
		return "."
	}
	if isSep(code) {
		rootEnd, offset = 1, 1
		if isSep(path[1]) {
			j := 2
			last := j
			for j < n && !isSep(path[j]) {
				j++
			}
			if j < n && j != last {
				last = j
				for j < n && isSep(path[j]) {
					j++
				}
				if j < n && j != last {
					last = j
					for j < n && !isSep(path[j]) {
						j++
					}
					if j == n {
						return s
					}
					if j != last {
						rootEnd, offset = j+1, j+1
					}
				}
			}
		}
	} else if isDevRoot(code) && path[1] == ':' {
		rootEnd = 2
		if n > 2 && isSep(path[2]) {
			rootEnd = 3
		}
		offset = rootEnd
	}

	end := -1
	matchedSlash := true
	for i := n - 1; i >= offset; i-- {
		if isSep(path[i]) {
			if !matchedSlash {
				end = i
				break
			}
		} else {
			matchedSlash = false
		}
	}
	if end == -1 {
		if rootEnd == -1 {
			return "."
		}
		end = rootEnd
	}
	return dec(path[:end])
}

// win32Basename is path.win32.basename without the suffix argument.
func win32Basename(s string) string {
	path := enc(s)
	start := 0
	end := -1
	matchedSlash := true
	if len(path) >= 2 && isDevRoot(path[0]) && path[1] == ':' {
		start = 2
	}
	for i := len(path) - 1; i >= start; i-- {
		if isSep(path[i]) {
			if !matchedSlash {
				start = i + 1
				break
			}
		} else if end == -1 {
			matchedSlash = false
			end = i + 1
		}
	}
	if end == -1 {
		return ""
	}
	return dec(path[start:end])
}

// win32Extname is path.win32.extname.
func win32Extname(s string) string {
	path := enc(s)
	start := 0
	startDot := -1
	startPart := 0
	end := -1
	matchedSlash := true
	preDotState := 0
	if len(path) >= 2 && path[1] == ':' && isDevRoot(path[0]) {
		start, startPart = 2, 2
	}
	for i := len(path) - 1; i >= start; i-- {
		code := path[i]
		if isSep(code) {
			if !matchedSlash {
				startPart = i + 1
				break
			}
			continue
		}
		if end == -1 {
			matchedSlash = false
			end = i + 1
		}
		if code == '.' {
			if startDot == -1 {
				startDot = i
			} else if preDotState != 1 {
				preDotState = 1
			}
		} else if startDot != -1 {
			preDotState = -1
		}
	}
	if startDot == -1 || end == -1 || preDotState == 0 ||
		(preDotState == 1 && startDot == end-1 && startDot == startPart+1) {
		return ""
	}
	return dec(path[startDot:end])
}

// toNamespaced is path.win32.toNamespacedPath, which Node applies to every path it hands to the file
// system: the long-path prefix switches off Win32 normalisation, so a name with a trailing dot or space
// is looked up as written.
func toNamespaced(s string) string {
	if s == "" {
		return s
	}
	r := enc(win32Resolve(s))
	if len(r) <= 2 {
		return s
	}
	if r[0] == '\\' {
		if r[1] == '\\' && r[2] != '?' && r[2] != '.' {
			return `\\?\UNC\` + dec(r[2:])
		}
	} else if isDevRoot(r[0]) && r[1] == ':' && r[2] == '\\' {
		return `\\?\` + dec(r)
	}
	return s
}

func envOr(names ...string) string {
	for _, n := range names {
		if v := os.Getenv(n); v != "" {
			return v
		}
	}
	return ""
}

// homedir is os.homedir() as the spec seeds it: USERPROFILE, else HOMEDRIVE + HOMEPATH.
func homedir() string {
	if v := os.Getenv("USERPROFILE"); v != "" {
		return v
	}
	return os.Getenv("HOMEDRIVE") + os.Getenv("HOMEPATH")
}

// tmpdir is os.tmpdir() on Windows, including Node's literal "undefined" when no system root is set.
func tmpdir() string {
	p := envOr("TEMP", "TMP")
	if p == "" {
		root := envOr("SystemRoot", "windir")
		if root == "" {
			root = "undefined"
		}
		p = root + `\temp`
	}
	if len(p) > 1 && strings.HasSuffix(p, `\`) && !strings.HasSuffix(p, `:\`) {
		p = p[:len(p)-1]
	}
	return p
}
