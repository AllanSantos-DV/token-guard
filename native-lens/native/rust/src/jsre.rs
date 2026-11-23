//! A small backtracking matcher for the ECMAScript regular-expression subset the guard's rules use.
//!
//! Why it exists: the rules rely on lookahead (`(?=`, `(?!`) and backreferences (`\1`, `\2`), which RE2-style engines
//! (the `regex` crate, Go) do not have, and on JavaScript's `\s` (Unicode white space incl. U+FEFF, not U+0085) and
//! ASCII-only `/i` for ASCII patterns. Matching here has exactly those semantics, so the pattern sources are the ones
//! in `lib/rules.cjs`, character for character.
//!
//! Supported: literals, `.`, classes (`\d \w \s \D \W \S`, ranges, negation), `^ $ \b \B`, groups (capturing,
//! `(?:`), `(?=` `(?!`, backreferences `\1..\9`, `* + ? {n} {n,} {n,m}` with lazy `?`, flags `i` and `g`
//! (the `g` loop lives in the callers). Not supported (not used): lookbehind, named groups, sticky, unicode mode,
//! multiline. Characters are Unicode scalar values rather than UTF-16 units; this is observable only for astral
//! characters next to a counted quantifier or `.`.
//!
//! Loop bodies must consume at least one character (true for every pattern in the rules); an empty body would spin.

type Caps = Vec<usize>;
const UNSET: usize = usize::MAX;
const INF: u32 = u32::MAX;

#[derive(Clone, Copy, Debug)]
enum Item {
    Range(char, char),
    Digit,
    NotDigit,
    Word,
    NotWord,
    Space,
    NotSpace,
}

#[derive(Clone, Debug)]
struct Class {
    items: Vec<Item>,
    negated: bool,
    icase: bool,
    /// ASCII membership, filled when the class is compiled into a program.
    table: Option<Box<[bool; 128]>>,
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn toggle_case(c: char) -> char {
    if c.is_ascii_lowercase() {
        c.to_ascii_uppercase()
    } else {
        c.to_ascii_lowercase()
    }
}

impl Class {
    fn hit(&self, c: char) -> bool {
        self.items.iter().any(|it| match *it {
            Item::Range(a, b) => a <= c && c <= b,
            Item::Digit => c.is_ascii_digit(),
            Item::NotDigit => !c.is_ascii_digit(),
            Item::Word => is_word(c),
            Item::NotWord => !is_word(c),
            Item::Space => crate::jsnum::is_js_ws(c),
            Item::NotSpace => !crate::jsnum::is_js_ws(c),
        })
    }

    fn matches(&self, c: char) -> bool {
        if let Some(t) = &self.table {
            if (c as u32) < 128 {
                return t[c as usize];
            }
        }
        self.matches_slow(c)
    }

    fn matches_slow(&self, c: char) -> bool {
        let found = self.hit(c) || (self.icase && c.is_ascii_alphabetic() && self.hit(toggle_case(c)));
        found != self.negated
    }

    fn with_table(mut self) -> Class {
        let mut t = Box::new([false; 128]);
        for (i, slot) in t.iter_mut().enumerate() {
            *slot = self.matches_slow(i as u8 as char);
        }
        self.table = Some(t);
        self
    }

    fn can_match_non_ascii(&self) -> bool {
        self.negated
            || self.items.iter().any(|it| match *it {
                Item::Range(_, b) => b as u32 >= 128,
                Item::Digit | Item::Word => false,
                _ => true,
            })
    }
}

#[derive(Debug)]
enum Node {
    Empty,
    Char(char),
    Any,
    Class(Class),
    Cat(Vec<Node>),
    Alt(Vec<Node>),
    Rep { n: Box<Node>, min: u32, max: u32, greedy: bool },
    Group(Box<Node>, Option<usize>),
    Bol,
    Eol,
    WordB(bool),
    Look(Box<Node>, bool),
    Backref(usize),
}

struct Parser {
    src: Vec<char>,
    i: usize,
    icase: bool,
    ncap: usize,
}

fn hex_val(chars: &[char]) -> Option<char> {
    let mut n = 0u32;
    for c in chars {
        n = n * 16 + c.to_digit(16)?;
    }
    char::from_u32(n)
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.src.get(self.i).copied()
    }

    fn alt(&mut self) -> Result<Node, String> {
        let mut alts = vec![self.cat()?];
        while self.peek() == Some('|') {
            self.i += 1;
            alts.push(self.cat()?);
        }
        Ok(if alts.len() == 1 { alts.remove(0) } else { Node::Alt(alts) })
    }

    fn cat(&mut self) -> Result<Node, String> {
        let mut v = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            v.push(self.term()?);
        }
        Ok(match v.len() {
            0 => Node::Empty,
            1 => v.remove(0),
            _ => Node::Cat(v),
        })
    }

    fn braces(&mut self) -> Option<(u32, u32)> {
        let mut j = self.i + 1;
        let num = |j: &mut usize, s: &[char]| -> Option<u32> {
            let st = *j;
            while s.get(*j).is_some_and(char::is_ascii_digit) {
                *j += 1;
            }
            if *j == st {
                None
            } else {
                s[st..*j].iter().collect::<String>().parse().ok()
            }
        };
        let min = num(&mut j, &self.src)?;
        let max = if self.src.get(j) == Some(&',') {
            j += 1;
            if self.src.get(j) == Some(&'}') {
                INF
            } else {
                num(&mut j, &self.src)?
            }
        } else {
            min
        };
        if self.src.get(j) != Some(&'}') {
            return None;
        }
        self.i = j + 1;
        Some((min, max))
    }

    fn term(&mut self) -> Result<Node, String> {
        let c = self.src[self.i];
        self.i += 1;
        let atom = match c {
            '^' => return Ok(Node::Bol),
            '$' => return Ok(Node::Eol),
            '.' => Node::Any,
            '*' | '+' | '?' => return Err(format!("nothing to repeat at {}", self.i - 1)),
            '(' => {
                let kind = if self.src[self.i..].starts_with(&['?', ':']) {
                    self.i += 2;
                    0
                } else if self.src[self.i..].starts_with(&['?', '=']) {
                    self.i += 2;
                    1
                } else if self.src[self.i..].starts_with(&['?', '!']) {
                    self.i += 2;
                    2
                } else {
                    3
                };
                let idx = if kind == 3 {
                    self.ncap += 1;
                    Some(self.ncap)
                } else {
                    None
                };
                let inner = self.alt()?;
                if self.peek() != Some(')') {
                    return Err("unterminated group".into());
                }
                self.i += 1;
                match kind {
                    1 => return Ok(Node::Look(Box::new(inner), false)),
                    2 => return Ok(Node::Look(Box::new(inner), true)),
                    _ => Node::Group(Box::new(inner), idx),
                }
            }
            '[' => self.class()?,
            '\\' => self.escape()?,
            ch => Node::Char(ch),
        };
        self.quantifier(atom)
    }

    fn quantifier(&mut self, atom: Node) -> Result<Node, String> {
        let (min, max) = match self.peek() {
            Some('*') => {
                self.i += 1;
                (0, INF)
            }
            Some('+') => {
                self.i += 1;
                (1, INF)
            }
            Some('?') => {
                self.i += 1;
                (0, 1)
            }
            Some('{') => match self.braces() {
                Some(r) => r,
                None => return Ok(atom),
            },
            _ => return Ok(atom),
        };
        let greedy = if self.peek() == Some('?') {
            self.i += 1;
            false
        } else {
            true
        };
        Ok(Node::Rep { n: Box::new(atom), min, max, greedy })
    }

    fn escape_char(&mut self, c: char) -> Option<char> {
        Some(match c {
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'v' => '\u{b}',
            'f' => '\u{c}',
            '0' => '\0',
            'x' => {
                let ch = hex_val(self.src.get(self.i..self.i + 2)?)?;
                self.i += 2;
                ch
            }
            'u' => {
                let ch = hex_val(self.src.get(self.i..self.i + 4)?)?;
                self.i += 4;
                ch
            }
            other => other,
        })
    }

    fn class_item(c: char) -> Option<Item> {
        Some(match c {
            'd' => Item::Digit,
            'D' => Item::NotDigit,
            'w' => Item::Word,
            'W' => Item::NotWord,
            's' => Item::Space,
            'S' => Item::NotSpace,
            _ => return None,
        })
    }

    fn escape(&mut self) -> Result<Node, String> {
        let Some(c) = self.peek() else { return Err("trailing backslash".into()) };
        self.i += 1;
        if let Some(item) = Self::class_item(c) {
            return Ok(Node::Class(Class { items: vec![item], negated: false, icase: self.icase, table: None }));
        }
        match c {
            'b' => Ok(Node::WordB(false)),
            'B' => Ok(Node::WordB(true)),
            '1'..='9' => Ok(Node::Backref(c as usize - '0' as usize)),
            _ => self.escape_char(c).map(Node::Char).ok_or_else(|| "bad escape".to_string()),
        }
    }

    fn class(&mut self) -> Result<Node, String> {
        let negated = if self.peek() == Some('^') {
            self.i += 1;
            true
        } else {
            false
        };
        let mut items = Vec::new();
        loop {
            let Some(c) = self.peek() else { return Err("unterminated class".into()) };
            self.i += 1;
            if c == ']' {
                break;
            }
            let lo = if c == '\\' {
                let Some(e) = self.peek() else { return Err("trailing backslash".into()) };
                self.i += 1;
                if let Some(item) = Self::class_item(e) {
                    items.push(item);
                    continue;
                }
                if e == 'b' {
                    '\u{8}'
                } else {
                    self.escape_char(e).ok_or_else(|| "bad escape".to_string())?
                }
            } else {
                c
            };
            if self.peek() == Some('-') && self.src.get(self.i + 1).is_some_and(|n| *n != ']') {
                self.i += 1;
                let h = self.src[self.i];
                self.i += 1;
                let hi = if h == '\\' {
                    let Some(e) = self.peek() else { return Err("trailing backslash".into()) };
                    self.i += 1;
                    self.escape_char(e).ok_or_else(|| "bad escape".to_string())?
                } else {
                    h
                };
                if hi < lo {
                    return Err("range out of order".into());
                }
                items.push(Item::Range(lo, hi));
            } else {
                items.push(Item::Range(lo, lo));
            }
        }
        Ok(Node::Class(Class { items, negated, icase: self.icase, table: None }))
    }
}

#[derive(Clone, Copy, Debug)]
enum One {
    Char(char),
    CharI(char),
    Any,
    Class(usize),
}

#[derive(Debug)]
enum Inst {
    One(One),
    Rep { one: One, min: u32, max: u32, greedy: bool },
    Bol,
    Eol,
    WordB(bool),
    Split(usize, usize),
    Jmp(usize),
    Save(usize),
    Look { neg: bool, next: usize },
    Backref(usize),
    Match,
}

struct Compiler {
    prog: Vec<Inst>,
    classes: Vec<Class>,
    icase: bool,
}

impl Compiler {
    fn single(&mut self, n: &Node) -> Option<One> {
        match n {
            Node::Char(c) => Some(if self.icase && c.is_ascii_alphabetic() { One::CharI(c.to_ascii_lowercase()) } else { One::Char(*c) }),
            Node::Any => Some(One::Any),
            Node::Class(c) => {
                self.classes.push(c.clone().with_table());
                Some(One::Class(self.classes.len() - 1))
            }
            Node::Group(inner, None) => self.single(inner),
            _ => None,
        }
    }

    fn emit(&mut self, n: &Node) {
        match n {
            Node::Empty => {}
            Node::Char(_) | Node::Any | Node::Class(_) => {
                let one = self.single(n).unwrap_or(One::Any);
                self.prog.push(Inst::One(one));
            }
            Node::Cat(v) => v.iter().for_each(|x| self.emit(x)),
            Node::Alt(v) => {
                let mut jumps = Vec::new();
                for (k, x) in v.iter().enumerate() {
                    if k + 1 < v.len() {
                        let split = self.prog.len();
                        self.prog.push(Inst::Split(split + 1, 0));
                        self.emit(x);
                        jumps.push(self.prog.len());
                        self.prog.push(Inst::Jmp(0));
                        let next = self.prog.len();
                        self.prog[split] = Inst::Split(split + 1, next);
                    } else {
                        self.emit(x);
                    }
                }
                let end = self.prog.len();
                for j in jumps {
                    self.prog[j] = Inst::Jmp(end);
                }
            }
            Node::Group(inner, idx) => match idx {
                Some(i) => {
                    self.prog.push(Inst::Save(2 * i));
                    self.emit(inner);
                    self.prog.push(Inst::Save(2 * i + 1));
                }
                None => self.emit(inner),
            },
            Node::Bol => self.prog.push(Inst::Bol),
            Node::Eol => self.prog.push(Inst::Eol),
            Node::WordB(neg) => self.prog.push(Inst::WordB(*neg)),
            Node::Backref(i) => self.prog.push(Inst::Backref(*i)),
            Node::Look(inner, neg) => {
                let at = self.prog.len();
                self.prog.push(Inst::Look { neg: *neg, next: 0 });
                self.emit(inner);
                self.prog.push(Inst::Match);
                let next = self.prog.len();
                self.prog[at] = Inst::Look { neg: *neg, next };
            }
            Node::Rep { n: body, min, max, greedy } => {
                if let Some(one) = self.single(body) {
                    self.prog.push(Inst::Rep { one, min: *min, max: *max, greedy: *greedy });
                    return;
                }
                for _ in 0..*min {
                    self.emit(body);
                }
                let mut exits = Vec::new();
                if *max == INF {
                    let top = self.prog.len();
                    self.prog.push(Inst::Split(0, 0));
                    self.emit(body);
                    self.prog.push(Inst::Jmp(top));
                    let end = self.prog.len();
                    self.prog[top] = if *greedy { Inst::Split(top + 1, end) } else { Inst::Split(end, top + 1) };
                } else {
                    for _ in *min..*max {
                        exits.push(self.prog.len());
                        self.prog.push(Inst::Split(0, 0));
                        self.emit(body);
                    }
                    let end = self.prog.len();
                    for at in exits {
                        self.prog[at] = if *greedy { Inst::Split(at + 1, end) } else { Inst::Split(end, at + 1) };
                    }
                }
            }
        }
    }
}

/// Characters that can start a match (ASCII bitmap plus a catch-all for non-ASCII), used to skip hopeless start positions.
#[derive(Clone)]
struct FirstSet {
    ascii: [bool; 128],
    high: bool,
}

impl FirstSet {
    fn none() -> Self {
        FirstSet { ascii: [false; 128], high: false }
    }
    fn all() -> Self {
        FirstSet { ascii: [true; 128], high: true }
    }
    fn union(&mut self, o: &FirstSet) {
        for i in 0..128 {
            self.ascii[i] |= o.ascii[i];
        }
        self.high |= o.high;
    }
    fn has(&self, c: char) -> bool {
        let u = c as u32;
        if u < 128 {
            self.ascii[u as usize]
        } else {
            self.high
        }
    }
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// First-character set of `n` for a match starting after position 0 (`^` cannot hold there), and whether `n` can match empty.
fn first(n: &Node, icase: bool) -> (FirstSet, bool) {
    match n {
        Node::Empty => (FirstSet::none(), true),
        Node::Char(c) => {
            let mut s = FirstSet::none();
            if (*c as u32) < 128 {
                s.ascii[*c as usize] = true;
                if icase && c.is_ascii_alphabetic() {
                    s.ascii[toggle_case(*c) as usize] = true;
                }
            } else {
                s.high = true;
            }
            (s, false)
        }
        Node::Any => {
            let mut s = FirstSet::all();
            for c in ['\n', '\r'] {
                s.ascii[c as usize] = false;
            }
            (s, false)
        }
        Node::Class(cl) => {
            let mut s = FirstSet::none();
            for i in 0..128u8 {
                s.ascii[i as usize] = cl.matches(i as char);
            }
            s.high = cl.can_match_non_ascii();
            (s, false)
        }
        Node::Cat(v) => {
            let mut acc = FirstSet::none();
            for x in v {
                let (s, nullable) = first(x, icase);
                acc.union(&s);
                if !nullable {
                    return (acc, false);
                }
            }
            (acc, true)
        }
        Node::Alt(v) => {
            let mut acc = FirstSet::none();
            let mut any_null = false;
            for x in v {
                let (s, nullable) = first(x, icase);
                acc.union(&s);
                any_null |= nullable;
            }
            (acc, any_null)
        }
        Node::Rep { n, min, .. } => {
            let (s, nullable) = first(n, icase);
            (s, nullable || *min == 0)
        }
        Node::Group(inner, _) => first(inner, icase),
        Node::Bol => (FirstSet::none(), false),
        Node::Eol | Node::WordB(_) | Node::Look(..) => (FirstSet::none(), true),
        Node::Backref(_) => (FirstSet::all(), true),
    }
}

#[derive(Debug)]
enum Bt {
    Alt(usize, usize),
    Cap(usize, usize),
    Greedy { pc: usize, min_pos: usize, pos: usize },
    Lazy { pc: usize, pos: usize, count: u32 },
}

/// A compiled pattern.
pub struct Re {
    prog: Vec<Inst>,
    classes: Vec<Class>,
    ncap: usize,
    icase: bool,
    #[cfg_attr(not(test), allow(dead_code))]
    src: String,
    prefilter: Option<FirstSet>,
}

/// Capture spans of a match (`[0]` is the whole match), as char offsets.
pub type Match = Vec<Option<(usize, usize)>>;

impl Re {
    /// Compiles `src` with `flags` (`i` is honoured, `g` is ignored here).
    ///
    /// Panics on a malformed pattern: every pattern is a constant of this program, and the unit tests compile them all.
    pub fn new(src: &str, flags: &str) -> Re {
        let icase = flags.contains('i');
        let mut p = Parser { src: src.chars().collect(), i: 0, icase, ncap: 0 };
        let node = match p.alt() {
            Ok(n) if p.i == p.src.len() => n,
            Ok(_) => panic!("regex {src}: unmatched ) at {}", p.i),
            Err(e) => panic!("regex {src}: {e}"),
        };
        let mut c = Compiler { prog: Vec::new(), classes: Vec::new(), icase };
        c.emit(&node);
        c.prog.push(Inst::Match);
        let (set, nullable) = first(&node, icase);
        Re { prog: c.prog, classes: c.classes, ncap: p.ncap, icase, src: src.to_string(), prefilter: if nullable { None } else { Some(set) } }
    }

    #[cfg(test)]
    /// The pattern text, as `RegExp.prototype.source` would report it.
    pub fn source(&self) -> &str {
        &self.src
    }

    fn one(&self, o: &One, c: char) -> bool {
        match *o {
            One::Char(x) => x == c,
            One::CharI(x) => c.is_ascii() && c.to_ascii_lowercase() == x,
            One::Any => !is_line_terminator(c),
            One::Class(i) => self.classes[i].matches(c),
        }
    }

    fn same(&self, a: char, b: char) -> bool {
        a == b || (self.icase && a.is_ascii_alphabetic() && b.is_ascii_alphabetic() && a.eq_ignore_ascii_case(&b))
    }

    fn run(&self, s: &[char], mut pc: usize, mut pos: usize, caps: &mut Caps, stack: &mut Vec<Bt>) -> Option<usize> {
        let base = stack.len();
        loop {
            let mut fail = false;
            match &self.prog[pc] {
                Inst::Match => {
                    stack.truncate(base);
                    return Some(pos);
                }
                Inst::One(o) => {
                    if pos < s.len() && self.one(o, s[pos]) {
                        pos += 1;
                        pc += 1;
                    } else {
                        fail = true;
                    }
                }
                Inst::Rep { one, min, max, greedy } => {
                    let (min, max) = (*min as usize, *max as usize);
                    if *greedy {
                        let mut n = 0;
                        while n < max && pos + n < s.len() && self.one(one, s[pos + n]) {
                            n += 1;
                        }
                        if n < min {
                            fail = true;
                        } else {
                            if n > min {
                                stack.push(Bt::Greedy { pc: pc + 1, min_pos: pos + min, pos: pos + n });
                            }
                            pos += n;
                            pc += 1;
                        }
                    } else {
                        let mut n = 0;
                        while n < min && pos + n < s.len() && self.one(one, s[pos + n]) {
                            n += 1;
                        }
                        if n < min {
                            fail = true;
                        } else {
                            pos += min;
                            if min < max {
                                stack.push(Bt::Lazy { pc, pos, count: min as u32 });
                            }
                            pc += 1;
                        }
                    }
                }
                Inst::Bol => {
                    if pos == 0 {
                        pc += 1;
                    } else {
                        fail = true;
                    }
                }
                Inst::Eol => {
                    if pos == s.len() {
                        pc += 1;
                    } else {
                        fail = true;
                    }
                }
                Inst::WordB(neg) => {
                    let before = pos > 0 && is_word(s[pos - 1]);
                    let after = pos < s.len() && is_word(s[pos]);
                    if (before != after) != *neg {
                        pc += 1;
                    } else {
                        fail = true;
                    }
                }
                Inst::Split(a, b) => {
                    stack.push(Bt::Alt(*b, pos));
                    pc = *a;
                }
                Inst::Jmp(a) => pc = *a,
                Inst::Save(i) => {
                    stack.push(Bt::Cap(*i, caps[*i]));
                    caps[*i] = pos;
                    pc += 1;
                }
                Inst::Look { neg, next } => {
                    let saved = caps.clone();
                    let found = self.run(s, pc + 1, pos, caps, stack).is_some();
                    *caps = saved;
                    if found != *neg {
                        pc = *next;
                    } else {
                        fail = true;
                    }
                }
                Inst::Backref(n) => {
                    let (a, b) = (caps[2 * n], caps[2 * n + 1]);
                    if a == UNSET || b == UNSET {
                        pc += 1;
                    } else {
                        let len = b - a;
                        if pos + len <= s.len() && (0..len).all(|k| self.same(s[a + k], s[pos + k])) {
                            pos += len;
                            pc += 1;
                        } else {
                            fail = true;
                        }
                    }
                }
            }
            if !fail {
                continue;
            }
            loop {
                if stack.len() <= base {
                    return None;
                }
                let Some(frame) = stack.pop() else { return None };
                match frame {
                    Bt::Cap(i, old) => caps[i] = old,
                    Bt::Alt(p, ps) => {
                        pc = p;
                        pos = ps;
                        break;
                    }
                    Bt::Greedy { pc: p, min_pos, pos: ps } => {
                        // A position where the next single-character instruction cannot match would fail at once: skip it.
                        let next = if let Inst::One(o) = &self.prog[p] { Some(o) } else { None };
                        let mut np = ps;
                        let mut found = false;
                        while np > min_pos {
                            np -= 1;
                            if next.map_or(true, |o| np < s.len() && self.one(o, s[np])) {
                                found = true;
                                break;
                            }
                        }
                        if !found {
                            continue;
                        }
                        if np > min_pos {
                            stack.push(Bt::Greedy { pc: p, min_pos, pos: np });
                        }
                        pc = p;
                        pos = np;
                        break;
                    }
                    Bt::Lazy { pc: p, pos: ps, count } => {
                        if let Inst::Rep { one, max, .. } = &self.prog[p] {
                            if count < *max && ps < s.len() && self.one(one, s[ps]) {
                                let (np, nc) = (ps + 1, count + 1);
                                if nc < *max {
                                    stack.push(Bt::Lazy { pc: p, pos: np, count: nc });
                                }
                                pc = p + 1;
                                pos = np;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    /// `RegExp.prototype.exec` from char offset `from` (the leftmost match at or after it).
    pub fn exec(&self, s: &[char], from: usize) -> Option<Match> {
        let mut caps: Caps = vec![UNSET; 2 * (self.ncap + 1)];
        let mut stack: Vec<Bt> = Vec::new();
        let mut p = from;
        while p <= s.len() {
            if p > 0 && p < s.len() {
                if let Some(f) = &self.prefilter {
                    if !f.has(s[p]) {
                        p += 1;
                        continue;
                    }
                }
            }
            caps.iter_mut().for_each(|c| *c = UNSET);
            stack.clear();
            if let Some(end) = self.run(s, 0, p, &mut caps, &mut stack) {
                let mut m: Match = Vec::with_capacity(self.ncap + 1);
                m.push(Some((p, end)));
                for g in 1..=self.ncap {
                    let (a, b) = (caps[2 * g], caps[2 * g + 1]);
                    m.push(if a == UNSET || b == UNSET { None } else { Some((a, b)) });
                }
                return Some(m);
            }
            p += 1;
        }
        None
    }

    /// `RegExp.prototype.test` on a char slice.
    pub fn test(&self, s: &[char]) -> bool {
        self.exec(s, 0).is_some()
    }

    /// `RegExp.prototype.test` on a string.
    pub fn test_str(&self, s: &str) -> bool {
        self.test(&to_chars(s))
    }

    /// Every non-overlapping match, as `String.prototype.match` with the `g` flag.
    pub fn find_all(&self, s: &[char]) -> Vec<Match> {
        let mut out = Vec::new();
        let mut at = 0;
        while at <= s.len() {
            let Some(m) = self.exec(s, at) else { break };
            let (a, b) = m[0].unwrap_or((at, at));
            at = if b == a { b + 1 } else { b };
            out.push(m);
        }
        out
    }
}

/// A string as scalar values, the unit the matcher walks.
pub fn to_chars(s: &str) -> Vec<char> {
    s.chars().collect()
}

/// `chars[a..b]` as a string, clamped to the slice.
pub fn slice(chars: &[char], a: usize, b: usize) -> String {
    let b = b.min(chars.len());
    let a = a.min(b);
    chars[a..b].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(src: &str, flags: &str, s: &str) -> Option<Vec<Option<String>>> {
        let re = Re::new(src, flags);
        let cs = to_chars(s);
        re.exec(&cs, 0).map(|mm| mm.iter().map(|g| g.map(|(a, b)| slice(&cs, a, b))).collect())
    }

    #[test]
    fn basics() {
        assert!(m("a+b", "", "xaab").is_some());
        assert!(m("^a$", "", "a\n").is_none());
        assert_eq!(m("(a|ab)(c|bcd)", "", "abcd").unwrap()[0].as_deref(), Some("abcd"));
        assert!(m("(?:^|_)(bash)($|_)", "", "mcp_bash").is_some());
        assert!(m("a(?!b)", "", "ab").is_none());
        assert!(m("a(?=b)", "", "ab").is_some());
        assert_eq!(m(r"(['\x22]?)(x)\1y", "", "'x'y").unwrap()[0].as_deref(), Some("'x'y"));
        assert!(m(r"\bls\s+-[a-z]*r[a-z]*\b", "i", "LS -R").is_some());
        assert!(m(r"\s", "", "\u{feff}").is_some());
        assert!(m(r"\s", "", "\u{85}").is_none());
        assert!(m(r"[a-z]", "i", "\u{212a}").is_none());
        assert_eq!(m(r"a*?b", "", "aab").unwrap()[0].as_deref(), Some("aab"));
        assert_eq!(m(r"x{2,3}", "", "xxxxx").unwrap()[0].as_deref(), Some("xxx"));
    }
}
