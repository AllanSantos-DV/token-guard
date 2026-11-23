//! Node's `path.win32` (and the `path.posix.normalize` the rules call) plus the `os` seams, ported function by
//! function so that string results match Node on Windows whatever OS runs the slice.

fn is_sep(c: char) -> bool {
    c == '/' || c == '\\'
}

fn is_posix_sep(c: char) -> bool {
    c == '/'
}

fn is_drive(c: char) -> bool {
    c.is_ascii_alphabetic()
}

fn cs(s: &str) -> Vec<char> {
    s.chars().collect()
}

fn st(v: &[char]) -> String {
    v.iter().collect()
}

fn sub(v: &[char], a: i64, b: i64) -> Vec<char> {
    let n = v.len() as i64;
    let b = b.clamp(0, n);
    let a = a.clamp(0, b);
    v[a as usize..b as usize].to_vec()
}

fn lower(s: &str) -> String {
    s.to_lowercase()
}

/// Case-insensitive environment lookup, as `process.env` behaves on Windows.
pub fn env(name: &str) -> Option<String> {
    if let Ok(v) = std::env::var(name) {
        return Some(v);
    }
    std::env::vars_os().find(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case(name)).map(|(_, v)| v.to_string_lossy().into_owned())
}

/// `process.env.NAME || undefined`: a variable set to the empty string counts as unset.
pub fn env_nonempty(name: &str) -> Option<String> {
    env(name).filter(|v| !v.is_empty())
}

/// `process.cwd()`.
pub fn cwd() -> Option<String> {
    std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned())
}

/// `os.homedir()` on Windows: `USERPROFILE`, else `HOMEDRIVE` + `HOMEPATH`.
pub fn homedir() -> String {
    if let Some(p) = env_nonempty("USERPROFILE") {
        return p;
    }
    format!("{}{}", env("HOMEDRIVE").unwrap_or_default(), env("HOMEPATH").unwrap_or_default())
}

/// `os.tmpdir()` on Windows.
pub fn tmpdir() -> String {
    let mut p = env_nonempty("TEMP")
        .or_else(|| env_nonempty("TMP"))
        .unwrap_or_else(|| format!("{}\\temp", env_nonempty("SystemRoot").or_else(|| env_nonempty("windir")).unwrap_or_else(|| "undefined".into())));
    if p.chars().count() > 1 && p.ends_with('\\') && !p.ends_with(":\\") {
        p.pop();
    }
    p
}

fn normalize_string(path: &[char], allow_above_root: bool, sep: char, issep: fn(char) -> bool) -> Vec<char> {
    let mut res: Vec<char> = Vec::new();
    let mut last_seg_len: i64 = 0;
    let mut last_slash: i64 = -1;
    let mut dots: i64 = 0;
    let mut code = '\0';
    let n = path.len() as i64;
    let mut i: i64 = 0;
    while i <= n {
        if i < n {
            code = path[i as usize];
        } else if issep(code) {
            break;
        } else {
            code = '/';
        }
        if issep(code) {
            if last_slash == i - 1 || dots == 1 {
                // empty segment or "."
            } else if dots == 2 {
                let rl = res.len();
                if rl < 2 || last_seg_len != 2 || res[rl - 1] != '.' || res[rl - 2] != '.' {
                    if rl > 2 {
                        match res.iter().rposition(|&c| c == sep) {
                            None => {
                                res.clear();
                                last_seg_len = 0;
                            }
                            Some(li) => {
                                res.truncate(li);
                                let prev = res.iter().rposition(|&c| c == sep).map_or(-1, |x| x as i64);
                                last_seg_len = res.len() as i64 - 1 - prev;
                            }
                        }
                        last_slash = i;
                        dots = 0;
                        i += 1;
                        continue;
                    } else if rl != 0 {
                        res.clear();
                        last_seg_len = 0;
                        last_slash = i;
                        dots = 0;
                        i += 1;
                        continue;
                    }
                }
                if allow_above_root {
                    if !res.is_empty() {
                        res.push(sep);
                    }
                    res.extend(['.', '.']);
                    last_seg_len = 2;
                }
            } else {
                let seg = sub(path, last_slash + 1, i);
                if !res.is_empty() {
                    res.push(sep);
                }
                res.extend(seg);
                last_seg_len = i - last_slash - 1;
            }
            last_slash = i;
            dots = 0;
        } else if code == '.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
        i += 1;
    }
    res
}

/// Root parsed off the front of a path: (device, root_end, is_absolute).
struct Root {
    device: Vec<char>,
    end: usize,
    absolute: bool,
}

fn parse_root(p: &[char]) -> Root {
    let len = p.len();
    let mut r = Root { device: Vec::new(), end: 0, absolute: false };
    let Some(&code) = p.first() else { return r };
    if len == 1 {
        if is_sep(code) {
            r.end = 1;
            r.absolute = true;
        }
    } else if is_sep(code) {
        r.absolute = true;
        if is_sep(p[1]) {
            let mut j = 2;
            let mut last = j;
            while j < len && !is_sep(p[j]) {
                j += 1;
            }
            if j < len && j != last {
                let first_part = sub(p, last as i64, j as i64);
                last = j;
                while j < len && is_sep(p[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_sep(p[j]) {
                        j += 1;
                    }
                    if j == len || j != last {
                        if st(&first_part) != "." && st(&first_part) != "?" {
                            r.device = cs("\\\\");
                            r.device.extend(first_part);
                            r.device.push('\\');
                            r.device.extend(sub(p, last as i64, j as i64));
                            r.end = j;
                        } else {
                            r.device = cs("\\\\");
                            r.device.extend(first_part);
                            r.end = 4;
                        }
                    }
                }
            }
        } else {
            r.end = 1;
        }
    } else if is_drive(code) && p[1] == ':' {
        r.device = p[..2].to_vec();
        r.end = 2;
        if len > 2 && is_sep(p[2]) {
            r.absolute = true;
            r.end = 3;
        }
    }
    r
}

/// `path.win32.resolve(...args)`.
pub fn resolve(args: &[&str]) -> String {
    let mut resolved_device: Vec<char> = Vec::new();
    let mut resolved_tail: Vec<char> = Vec::new();
    let mut resolved_absolute = false;
    let mut idx = args.len() as i64 - 1;
    while idx >= -1 {
        let path: Vec<char>;
        if idx >= 0 {
            let a = cs(args[idx as usize]);
            if a.is_empty() {
                idx -= 1;
                continue;
            }
            path = a;
        } else if resolved_device.is_empty() {
            let here = cwd().unwrap_or_default();
            let only_here = args.is_empty() || (args.len() == 1 && (args[0].is_empty() || args[0] == ".") && here.chars().next().is_some_and(is_sep));
            if only_here {
                return here;
            }
            path = cs(&here);
        } else {
            let dev = st(&resolved_device);
            let mut p = cs(&env_nonempty(&format!("={dev}")).or_else(cwd).unwrap_or_default());
            let head = lower(&st(&sub(&p, 0, 2)));
            if head != lower(&dev) && p.get(2) == Some(&'\\') {
                p = cs(&format!("{dev}\\"));
            }
            path = p;
        }
        let root = parse_root(&path);
        if !root.device.is_empty() {
            if !resolved_device.is_empty() {
                if lower(&st(&root.device)) != lower(&st(&resolved_device)) {
                    idx -= 1;
                    continue;
                }
            } else {
                resolved_device = root.device.clone();
            }
        }
        if resolved_absolute {
            if !resolved_device.is_empty() {
                break;
            }
        } else {
            let mut t = path[root.end.min(path.len())..].to_vec();
            t.push('\\');
            t.extend(resolved_tail);
            resolved_tail = t;
            resolved_absolute = root.absolute;
            if root.absolute && !resolved_device.is_empty() {
                break;
            }
        }
        idx -= 1;
    }
    let tail = normalize_string(&resolved_tail, !resolved_absolute, '\\', is_sep);
    let out = if resolved_absolute {
        format!("{}\\{}", st(&resolved_device), st(&tail))
    } else {
        format!("{}{}", st(&resolved_device), st(&tail))
    };
    if out.is_empty() {
        ".".into()
    } else {
        out
    }
}

const RESERVED: [&str; 28] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7",
    "LPT8", "LPT9", "COM\u{b9}", "COM\u{b2}", "COM\u{b3}", "LPT\u{b9}", "LPT\u{b2}", "LPT\u{b3}",
];

fn index_of(p: &[char], c: char, from: usize) -> Option<usize> {
    p.iter().enumerate().skip(from).find(|(_, x)| **x == c).map(|(i, _)| i)
}

/// `isWindowsReservedName(path, colonIndex)`, including `slice(0, -1)` when there is no colon (`-1`).
fn is_reserved(p: &[char], colon: Option<usize>) -> bool {
    let end = match colon {
        Some(i) => i,
        None => p.len().saturating_sub(1),
    };
    let head: String = p[..end.min(p.len())].iter().collect();
    RESERVED.contains(&head.to_uppercase().as_str())
}

/// `path.win32.normalize`.
pub fn normalize(path: &str) -> String {
    let p = cs(path);
    let len = p.len();
    if len == 0 {
        return ".".into();
    }
    if len == 1 {
        return if is_posix_sep(p[0]) { "\\".into() } else { path.to_string() };
    }
    let mut root_end = 0usize;
    let mut device: Option<Vec<char>> = None;
    let mut absolute = false;
    let code = p[0];
    if is_sep(code) {
        absolute = true;
        if is_sep(p[1]) {
            let mut j = 2;
            let mut last = j;
            while j < len && !is_sep(p[j]) {
                j += 1;
            }
            if j < len && j != last {
                let first_part = sub(&p, last as i64, j as i64);
                last = j;
                while j < len && is_sep(p[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_sep(p[j]) {
                        j += 1;
                    }
                    if j == len || j != last {
                        let fp = st(&first_part);
                        if fp == "." || fp == "?" {
                            let mut d = cs("\\\\");
                            d.extend(first_part);
                            device = Some(d);
                            root_end = 4;
                            let colon = index_of(&p, ':', 0);
                            let possible: Vec<char> = match colon {
                                Some(ci) => sub(&p, 4, ci as i64 + 1),
                                None => Vec::new(),
                            };
                            if !possible.is_empty() && is_reserved(&possible, Some(possible.len() - 1)) {
                                let mut d = cs("\\\\?\\");
                                d.extend(possible.iter());
                                device = Some(d);
                                root_end = 4 + possible.len();
                            }
                        } else if j == len {
                            return format!("\\\\{}\\{}\\", fp, st(&sub(&p, last as i64, len as i64)));
                        } else {
                            let mut d = cs("\\\\");
                            d.extend(first_part);
                            d.push('\\');
                            d.extend(sub(&p, last as i64, j as i64));
                            device = Some(d);
                            root_end = j;
                        }
                    }
                }
            }
        } else {
            root_end = 1;
        }
    } else if let Some(ci) = index_of(&p, ':', 0).filter(|&i| i > 0) {
        if is_drive(code) && ci == 1 {
            device = Some(p[..2].to_vec());
            root_end = 2;
            if len > 2 && is_sep(p[2]) {
                absolute = true;
                root_end = 3;
            }
        } else if is_reserved(&p, Some(ci)) {
            device = Some(p[..ci + 1].to_vec());
            root_end = ci + 1;
        }
    }
    let mut tail = if root_end < len { normalize_string(&p[root_end..], !absolute, '\\', is_sep) } else { Vec::new() };
    if tail.is_empty() && !absolute {
        tail = cs(".");
    }
    if !tail.is_empty() && is_sep(p[len - 1]) {
        tail.push('\\');
    }
    if !absolute && device.is_none() && p.contains(&':') {
        // CVE-2024-36139: a relative path must not turn into something Windows reads as drive-absolute.
        if tail.len() >= 2 && is_drive(tail[0]) && tail[1] == ':' {
            return format!(".\\{}", st(&tail));
        }
        let mut index = index_of(&p, ':', 0);
        while let Some(i) = index {
            if i == len - 1 || is_sep(p[i + 1]) {
                return format!(".\\{}", st(&tail));
            }
            index = index_of(&p, ':', i + 1);
        }
    }
    if is_reserved(&p, index_of(&p, ':', 0)) {
        return format!(".\\{}{}", device.as_ref().map(|d| st(d)).unwrap_or_default(), st(&tail));
    }
    match device {
        None => {
            if absolute {
                format!("\\{}", st(&tail))
            } else {
                st(&tail)
            }
        }
        Some(d) => {
            if absolute {
                format!("{}\\{}", st(&d), st(&tail))
            } else {
                format!("{}{}", st(&d), st(&tail))
            }
        }
    }
}

/// `path.posix.normalize`.
pub fn posix_normalize(path: &str) -> String {
    let p = cs(path);
    if p.is_empty() {
        return ".".into();
    }
    let absolute = p[0] == '/';
    let trailing = p[p.len() - 1] == '/';
    let mut n = st(&normalize_string(&p, !absolute, '/', is_posix_sep));
    if n.is_empty() {
        if absolute {
            return "/".into();
        }
        return if trailing { "./".into() } else { ".".into() };
    }
    if trailing {
        n.push('/');
    }
    if absolute {
        format!("/{n}")
    } else {
        n
    }
}

/// `path.win32.join(...args)`.
pub fn join(args: &[&str]) -> String {
    let mut joined: Option<String> = None;
    let mut first_part: Vec<char> = Vec::new();
    for a in args.iter().filter(|a| !a.is_empty()) {
        match &mut joined {
            None => {
                joined = Some((*a).to_string());
                first_part = cs(a);
            }
            Some(j) => {
                j.push('\\');
                j.push_str(a);
            }
        }
    }
    let Some(joined) = joined else { return ".".into() };
    let mut needs_replace = true;
    let mut slash_count = 0usize;
    if is_sep(first_part[0]) {
        slash_count += 1;
        if first_part.len() > 1 && is_sep(first_part[1]) {
            slash_count += 1;
            if first_part.len() > 2 {
                if is_sep(first_part[2]) {
                    slash_count += 1;
                } else {
                    needs_replace = false;
                }
            }
        }
    }
    let mut jc = cs(&joined);
    if needs_replace {
        while slash_count < jc.len() && is_sep(jc[slash_count]) {
            slash_count += 1;
        }
        if slash_count >= 2 {
            let mut t = vec!['\\'];
            t.extend_from_slice(&jc[slash_count..]);
            jc = t;
        }
    }
    let joined_s = st(&jc);
    let mut parts: Vec<String> = Vec::new();
    let mut part = String::new();
    let jchars: Vec<char> = joined_s.chars().collect();
    let mut k = 0;
    while k < jchars.len() {
        if jchars[k] == '\\' {
            if !part.is_empty() {
                parts.push(std::mem::take(&mut part));
            }
            while k + 1 < jchars.len() && jchars[k + 1] == '\\' {
                k += 1;
            }
        } else {
            part.push(jchars[k]);
        }
        k += 1;
    }
    if !part.is_empty() {
        parts.push(part);
    }
    if parts.iter().any(|x| {
        let pc = cs(x);
        index_of(&pc, ':', 0).is_some_and(|ci| is_reserved(&pc, Some(ci)))
    }) {
        return joined_s.replace('/', "\\");
    }
    normalize(&joined_s)
}

/// `path.win32.isAbsolute`.
pub fn is_absolute(path: &str) -> bool {
    let p = cs(path);
    let Some(&code) = p.first() else { return false };
    is_sep(code) || (p.len() > 2 && is_drive(code) && p[1] == ':' && is_sep(p[2]))
}

/// `path.win32.dirname`.
pub fn dirname(path: &str) -> String {
    let p = cs(path);
    let len = p.len();
    if len == 0 {
        return ".".into();
    }
    let code = p[0];
    if len == 1 {
        return if is_sep(code) { path.to_string() } else { ".".into() };
    }
    let mut root_end: i64 = -1;
    let mut offset = 0usize;
    if is_sep(code) {
        root_end = 1;
        offset = 1;
        if is_sep(p[1]) {
            let mut j = 2;
            let mut last = j;
            while j < len && !is_sep(p[j]) {
                j += 1;
            }
            if j < len && j != last {
                last = j;
                while j < len && is_sep(p[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_sep(p[j]) {
                        j += 1;
                    }
                    if j == len {
                        return path.to_string();
                    }
                    if j != last {
                        root_end = j as i64 + 1;
                        offset = j + 1;
                    }
                }
            }
        }
    } else if is_drive(code) && p[1] == ':' {
        root_end = if len > 2 && is_sep(p[2]) { 3 } else { 2 };
        offset = root_end as usize;
    }
    let mut end: i64 = -1;
    let mut matched_slash = true;
    let mut i = len as i64 - 1;
    while i >= offset as i64 {
        if is_sep(p[i as usize]) {
            if !matched_slash {
                end = i;
                break;
            }
        } else {
            matched_slash = false;
        }
        i -= 1;
    }
    if end == -1 {
        if root_end == -1 {
            return ".".into();
        }
        end = root_end;
    }
    st(&sub(&p, 0, end))
}

/// `path.win32.basename(path)`.
pub fn basename(path: &str) -> String {
    let p = cs(path);
    let mut start: i64 = 0;
    let mut end: i64 = -1;
    let mut matched_slash = true;
    if p.len() >= 2 && is_drive(p[0]) && p[1] == ':' {
        start = 2;
    }
    let mut i = p.len() as i64 - 1;
    while i >= start {
        if is_sep(p[i as usize]) {
            if !matched_slash {
                start = i + 1;
                break;
            }
        } else if end == -1 {
            matched_slash = false;
            end = i + 1;
        }
        i -= 1;
    }
    if end == -1 {
        return String::new();
    }
    st(&sub(&p, start, end))
}

/// `path.win32.extname`.
pub fn extname(path: &str) -> String {
    let p = cs(path);
    let mut start: i64 = 0;
    let mut start_dot: i64 = -1;
    let mut start_part: i64 = 0;
    let mut end: i64 = -1;
    let mut matched_slash = true;
    let mut pre_dot_state: i64 = 0;
    if p.len() >= 2 && p[1] == ':' && is_drive(p[0]) {
        start = 2;
        start_part = 2;
    }
    let mut i = p.len() as i64 - 1;
    while i >= start {
        let code = p[i as usize];
        if is_sep(code) {
            if !matched_slash {
                start_part = i + 1;
                break;
            }
            i -= 1;
            continue;
        }
        if end == -1 {
            matched_slash = false;
            end = i + 1;
        }
        if code == '.' {
            if start_dot == -1 {
                start_dot = i;
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot != -1 {
            pre_dot_state = -1;
        }
        i -= 1;
    }
    if start_dot == -1 || end == -1 || pre_dot_state == 0 || (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1) {
        return String::new();
    }
    st(&sub(&p, start_dot, end))
}

/// `path.win32.relative(from, to)`.
pub fn relative(from_in: &str, to_in: &str) -> String {
    if from_in == to_in {
        return String::new();
    }
    let from_orig = resolve(&[from_in]);
    let to_orig = resolve(&[to_in]);
    if from_orig == to_orig {
        return String::new();
    }
    let from = cs(&lower(&from_orig));
    let to = cs(&lower(&to_orig));
    let to_orig_c = cs(&to_orig);
    if from == to {
        return String::new();
    }
    let at = |v: &[char], i: i64| -> char { usize::try_from(i).ok().and_then(|i| v.get(i)).copied().unwrap_or('\0') };
    let mut from_start: i64 = 0;
    while (from_start as usize) < from.len() && from[from_start as usize] == '\\' {
        from_start += 1;
    }
    let mut from_end = from.len() as i64;
    while from_end - 1 > from_start && from[(from_end - 1) as usize] == '\\' {
        from_end -= 1;
    }
    let from_len = from_end - from_start;
    let mut to_start: i64 = 0;
    while (to_start as usize) < to.len() && to[to_start as usize] == '\\' {
        to_start += 1;
    }
    let mut to_end = to.len() as i64;
    while to_end - 1 > to_start && to[(to_end - 1) as usize] == '\\' {
        to_end -= 1;
    }
    let to_len = to_end - to_start;
    let length = from_len.min(to_len);
    let mut last_common_sep: i64 = -1;
    let mut i: i64 = 0;
    while i < length {
        let fc = at(&from, from_start + i);
        if fc != at(&to, to_start + i) {
            break;
        } else if fc == '\\' {
            last_common_sep = i;
        }
        i += 1;
    }
    if i != length {
        if last_common_sep == -1 {
            return to_orig;
        }
    } else {
        if to_len > length {
            if at(&to, to_start + i) == '\\' {
                return st(&sub(&to_orig_c, to_start + i + 1, to_orig_c.len() as i64));
            }
            if i == 2 {
                return st(&sub(&to_orig_c, to_start + i, to_orig_c.len() as i64));
            }
        }
        if from_len > length {
            if at(&from, from_start + i) == '\\' {
                last_common_sep = i;
            } else if i == 2 {
                last_common_sep = 3;
            }
        }
        if last_common_sep == -1 {
            last_common_sep = 0;
        }
    }
    let mut out = String::new();
    let mut k = from_start + last_common_sep + 1;
    while k <= from_end {
        if k == from_end || at(&from, k) == '\\' {
            out.push_str(if out.is_empty() { ".." } else { "\\.." });
        }
        k += 1;
    }
    to_start += last_common_sep;
    if !out.is_empty() {
        return format!("{out}{}", st(&sub(&to_orig_c, to_start, to_end)));
    }
    if at(&to_orig_c, to_start) == '\\' {
        to_start += 1;
    }
    st(&sub(&to_orig_c, to_start, to_end))
}
