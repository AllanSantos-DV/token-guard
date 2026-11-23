//! Differential test of `jsre` against V8: the corpus file (path in `RE_BATTERY`) holds, for every pattern of the
//! rules, the sources and every `matchAll` result V8 produced over real and fuzzed command strings.
//! Skipped when the variable is unset.

use crate::json::{parse, Value};
use crate::jsre::{slice, to_chars};
use crate::rules::rx;

fn utf16_at(chars: &[char], idx: usize) -> usize {
    chars[..idx.min(chars.len())].iter().map(|c| c.len_utf16()).sum()
}

fn s_of(v: &Value) -> &str {
    match v {
        Value::Str(s) => s,
        other => panic!("expected string, got {other:?}"),
    }
}

/// `path.win32` port, lower-casing and the number helpers against Node (`PATH_BATTERY`); run from the same cwd as the generator.
#[test]
fn paths_and_numbers_match_node() {
    use crate::jsnum::{fmt_pt_br, js_round, string_to_number, to_fixed};
    use crate::jspath as jp;
    let Ok(file) = std::env::var("PATH_BATTERY") else { return };
    let doc = parse(&std::fs::read_to_string(file).expect("battery file")).ok().expect("battery json");
    assert_eq!(s_of(doc.get("cwd").unwrap()), std::env::current_dir().unwrap().to_string_lossy(), "run the test from the generator's cwd");
    let mut bad: Vec<String> = Vec::new();
    let mut n = 0usize;
    let Some(Value::Arr(rows)) = doc.get("rows") else { panic!() };
    for r in rows {
        let fname = s_of(r.get("fn").unwrap());
        let Some(Value::Arr(args)) = r.get("args") else { panic!() };
        let a: Vec<&str> = args.iter().map(s_of).collect();
        let got = match fname {
            "normalize" => jp::normalize(a[0]),
            "isAbsolute" => jp::is_absolute(a[0]).to_string(),
            "dirname" => jp::dirname(a[0]),
            "basename" => jp::basename(a[0]),
            "extname" => jp::extname(a[0]),
            "resolve1" => jp::resolve(&[a[0]]),
            "pnormalize" => jp::posix_normalize(a[0]),
            "relative" => jp::relative(a[0], a[1]),
            "join" => jp::join(&[a[0], a[1]]),
            "join3" => jp::join(&[a[0], a[1], a[2]]),
            "resolve2" => jp::resolve(&[a[0], a[1]]),
            other => panic!("unknown fn {other}"),
        };
        let want = match r.get("out").unwrap() {
            Value::Bool(b) => b.to_string(),
            v => s_of(v).to_string(),
        };
        n += 1;
        if got != want && bad.len() < 25 {
            bad.push(format!("{fname}({a:?}): got {got:?} node {want:?}"));
        }
    }
    let Some(Value::Arr(lo)) = doc.get("lo") else { panic!() };
    for r in lo {
        n += 1;
        let s = s_of(r.get("s").unwrap());
        if s.to_lowercase() != s_of(r.get("out").unwrap()) {
            bad.push(format!("lowercase({s:?})"));
        }
    }
    let Some(Value::Arr(nums)) = doc.get("nums") else { panic!() };
    for r in nums {
        n += 1;
        let k = s_of(r.get("k").unwrap());
        let num = |key: &str| if let Some(Value::Num(x)) = r.get(key) { *x } else { f64::NAN };
        let (got, want) = match k {
            "fixed" => (to_fixed(num("x"), num("d") as usize), s_of(r.get("out").unwrap()).to_string()),
            "fmt" => (fmt_pt_br(num("x")), s_of(r.get("out").unwrap()).to_string()),
            "round" => (format!("{}", js_round(num("x")) + 0.0), s_of(r.get("out").unwrap()).replace("-0", "0")),
            "str" => {
                let g = string_to_number(s_of(r.get("s").unwrap()));
                let g = if g.is_nan() { "NaN".to_string() } else if g.is_infinite() { if g > 0.0 { "Infinity".into() } else { "-Infinity".into() } } else if g == 0.0 && g.is_sign_negative() { "-0".into() } else { format!("{g}") };
                (g, s_of(r.get("out").unwrap()).to_string())
            }
            other => panic!("unknown kind {other}"),
        };
        if got != want && bad.len() < 25 {
            bad.push(format!("{k} {:?}: got {got:?} node {want:?}", r));
        }
    }
    assert!(bad.is_empty(), "{} shown mismatches of {n}:\n{}", bad.len(), bad.join("\n"));
    println!("paths+numbers: {n} comparisons, 0 mismatches");
}

#[test]
fn engine_matches_v8() {
    let Ok(file) = std::env::var("RE_BATTERY") else { return };
    let doc = parse(&std::fs::read_to_string(file).expect("battery file")).ok().expect("battery json");
    let named = rx().named();

    let Some(Value::Obj(sources)) = doc.get("sources") else { panic!("no sources") };
    assert_eq!(sources.len(), named.len(), "pattern count differs between rules.rs and the V8 list");
    for (name, spec) in sources {
        let (_, re) = named.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("pattern {name} missing in rules.rs"));
        let Some(Value::Str(src)) = spec.get("source") else { panic!() };
        assert_eq!(re.source(), src, "source text of {name}");
    }

    let Some(Value::Arr(entries)) = doc.get("entries") else { panic!("no entries") };
    let mut compared = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for e in entries {
        let Some(Value::Str(s)) = e.get("s") else { panic!() };
        let Some(Value::Obj(expect)) = e.get("r") else { panic!() };
        let chars = to_chars(s);
        for (name, re) in &named {
            let got = re.find_all(&chars);
            let want = match expect.iter().find(|(k, _)| k == name) {
                Some((_, Value::Arr(v))) => v.as_slice(),
                _ => &[],
            };
            compared += 1;
            let mut ok = got.len() == want.len();
            if ok {
                for (g, w) in got.iter().zip(want) {
                    let Value::Arr(w) = w else { panic!() };
                    let (Value::Num(wi), Value::Str(wt), Value::Arr(wg)) = (&w[0], &w[1], &w[2]) else { panic!() };
                    let (a, b) = g[0].unwrap();
                    ok &= utf16_at(&chars, a) == *wi as usize && slice(&chars, a, b) == *wt;
                    ok &= g.len() - 1 == wg.len();
                    for (k, wv) in wg.iter().enumerate() {
                        let mine = g.get(k + 1).copied().flatten().map(|(x, y)| slice(&chars, x, y));
                        ok &= match (wv, &mine) {
                            (Value::Null, None) => true,
                            (Value::Str(t), Some(m)) => t == m,
                            _ => false,
                        };
                    }
                }
            }
            if !ok && failures.len() < 20 {
                failures.push(format!("{name} on {s:?}: got {} matches, V8 {}", got.len(), want.len()));
            }
        }
    }
    assert!(failures.is_empty(), "{} mismatches of {compared}; first:\n{}", failures.len(), failures.join("\n"));
    println!("battery: {} strings x {} patterns = {compared} comparisons, 0 mismatches", entries.len(), named.len());
}
