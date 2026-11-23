//! The few JavaScript coercions and formatters the rules depend on: `trim`, `Number()`, `String()`,
//! `toFixed`, and `toLocaleString('pt-BR')`.

use crate::json::Value;

/// ECMAScript WhiteSpace and LineTerminator (what `\s` and `String.prototype.trim` use).
pub fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

/// `String.prototype.split(/\s+/).filter(Boolean)`.
pub fn ws_tokens(s: &str) -> Vec<&str> {
    s.split(is_js_ws).filter(|t| !t.is_empty()).collect()
}

fn decimal_literal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    if matches!(b.first(), Some(b'+' | b'-')) {
        i += 1;
    }
    let int_start = i;
    while b.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let f = i;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        frac_digits = i - f;
    }
    if int_digits + frac_digits == 0 {
        return false;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let e = i;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == e {
            return false;
        }
    }
    i == b.len()
}

/// `Number(string)`.
pub fn string_to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| -> f64 {
        let digits = &t[p.len()..];
        if digits.is_empty() {
            return f64::NAN;
        }
        digits.chars().try_fold(0f64, |acc, c| c.to_digit(r).map(|d| acc * f64::from(r) + f64::from(d))).unwrap_or(f64::NAN)
    };
    if t.starts_with("0x") || t.starts_with("0X") {
        return radix(&t[..2], 16);
    }
    if t.starts_with("0o") || t.starts_with("0O") {
        return radix(&t[..2], 8);
    }
    if t.starts_with("0b") || t.starts_with("0B") {
        return radix(&t[..2], 2);
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if decimal_literal(t) {
        t.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// `String(value)` for the shapes that can come out of JSON.
pub fn to_js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Num(n) => format!("{n}"),
        Value::Str(s) => s.clone(),
        Value::Arr(items) => items
            .iter()
            .map(|x| if matches!(x, Value::Null) { String::new() } else { to_js_string(x) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Obj(_) => "[object Object]".into(),
    }
}

/// `Number(value)`; `None` is `undefined`.
pub fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Num(n)) => *n,
        Some(Value::Str(s)) => string_to_number(s),
        Some(a @ Value::Arr(_)) => string_to_number(&to_js_string(a)),
        Some(Value::Obj(_)) => f64::NAN,
    }
}

/// `Number.isFinite(x) && x > 0` on a raw number.
pub fn finite_positive(n: f64) -> bool {
    n.is_finite() && n > 0.0
}

/// `Number.prototype.toFixed(digits)` for a non-negative finite number, rounding half up on the exact binary value.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if !x.is_finite() || x >= 1e21 {
        return format!("{x}");
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let exact = format!("{:.60}", x.abs());
    let (int_part, frac_part) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut digs: Vec<u8> = int_part.bytes().chain(frac_part.bytes().take(digits)).map(|b| b - b'0').collect();
    if frac_part.as_bytes().get(digits).is_some_and(|b| *b >= b'5') {
        let mut k = digs.len();
        loop {
            if k == 0 {
                digs.insert(0, 1);
                break;
            }
            k -= 1;
            if digs[k] == 9 {
                digs[k] = 0;
            } else {
                digs[k] += 1;
                break;
            }
        }
    }
    let int_len = digs.len() - digits;
    let mut out = String::from(sign);
    out.extend(digs[..int_len].iter().map(|d| (b'0' + d) as char));
    if digits > 0 {
        out.push('.');
        out.extend(digs[int_len..].iter().map(|d| (b'0' + d) as char));
    }
    out
}

fn group_thousands(int_digits: &str) -> String {
    let n = int_digits.len();
    let mut out = String::with_capacity(n + n / 3);
    for (i, c) in int_digits.chars().enumerate() {
        if i > 0 && (n - i) % 3 == 0 {
            out.push('.');
        }
        out.push(c);
    }
    out
}

/// `Number(n).toLocaleString('pt-BR')`: `.` between thousands, `,` before at most three decimals.
pub fn fmt_pt_br(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "\u{221e}".into() } else { "-\u{221e}".into() };
    }
    let sign = if n < 0.0 { "-" } else { "" };
    let a = n.abs();
    if a.fract() == 0.0 {
        return format!("{sign}{}", group_thousands(&format!("{a}")));
    }
    let fixed = to_fixed(a, 3);
    let (int_part, frac) = fixed.split_once('.').unwrap_or((fixed.as_str(), ""));
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() {
        format!("{sign}{}", group_thousands(int_part))
    } else {
        format!("{sign}{},{frac}", group_thousands(int_part))
    }
}

/// `Math.round`: halves go toward positive infinity.
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}
