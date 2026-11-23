//! Port of `lib/payload.cjs`: runtime-agnostic reading of the hook payload.

use crate::json::{parse, Value};
use crate::jsnum::js_trim;
use std::borrow::Cow;

fn path<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(v, |cur, k| cur.get(k))
}

fn first_string(vals: &[Option<&Value>]) -> String {
    for v in vals.iter().flatten() {
        if let Value::Str(s) = v {
            if !s.is_empty() {
                return s.clone();
            }
        }
    }
    String::new()
}

fn first_object<'a>(vals: &[Option<&'a Value>]) -> Option<&'a Value> {
    vals.iter().flatten().copied().find(|v| v.is_object())
}

/// `P.toolName`: empty when no field carries a name.
pub fn tool_name(p: &Value) -> String {
    first_string(&[path(p, &["toolCall", "toolName"]), p.get("tool_name"), p.get("toolName"), p.get("name")])
}

/// `P.toolInput`; `toolArgs` may be a JSON string (Copilot CLI command hook).
pub fn tool_input(p: &Value) -> Cow<'_, Value> {
    let found = first_object(&[path(p, &["toolCall", "input"]), p.get("tool_input"), p.get("toolInput"), p.get("toolArgs"), p.get("input")]);
    if let Some(v) = found {
        return Cow::Borrowed(v);
    }
    if let Some(Value::Str(raw)) = p.get("toolArgs") {
        if let Ok(v @ Value::Obj(_)) = parse(raw) {
            return Cow::Owned(v);
        }
    }
    Cow::Owned(Value::Obj(Vec::new()))
}

/// `P.cwd`: the declared workspace, else the process working directory (`None` when that is unreadable).
pub fn cwd(p: &Value) -> Option<String> {
    let s = first_string(&[p.get("cwd"), p.get("workingDirectory"), p.get("workspaceRoot"), p.get("workspace_root")]);
    if s.is_empty() {
        crate::jspath::cwd().filter(|c| !c.is_empty())
    } else {
        Some(s)
    }
}

/// Target file or folder, whatever the field is called.
pub fn input_path(i: &Value) -> String {
    first_string(&["path", "filePath", "file_path", "absolute_path", "target", "file", "uri", "filename"].map(|k| i.get(k)))
}

/// Paths a grep/glob/read covers (string or array of strings).
pub fn input_paths(i: &Value) -> Vec<String> {
    let present = |k: &str| i.get(k).filter(|v| !matches!(v, Value::Null));
    let raw = present("paths").or_else(|| present("path")).or_else(|| present("searchPaths")).or_else(|| i.get("directories"));
    match raw {
        Some(Value::Arr(items)) => items.iter().filter_map(|x| if let Value::Str(s) = x { Some(s.clone()) } else { None }).collect(),
        Some(Value::Str(s)) if !s.is_empty() => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// Search pattern or glob.
pub fn input_pattern(i: &Value) -> String {
    first_string(&["pattern", "query", "regex", "search", "searchText", "glob"].map(|k| i.get(k)))
}

/// The scope filter (glob/type/include) that makes a content search acceptable.
pub fn input_scope_filter(i: &Value) -> String {
    first_string(&["glob", "type", "include", "includePattern", "filePattern"].map(|k| i.get(k)))
}

/// Shell command line, whatever the field is called.
pub fn input_command(i: &Value) -> String {
    first_string(&["command", "cmd", "script", "commandLine"].map(|k| i.get(k)))
}

/// `Array.isArray(v) && v.length > 0`.
pub fn non_empty_array(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Arr(a)) if !a.is_empty())
}

/// `typeof v === 'string' && v.trim() !== ''`.
pub fn non_blank_string(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Str(s)) if !js_trim(s).is_empty())
}

/// True when the read asked for a line range (or PDF pages) instead of the whole file.
pub fn has_read_range(i: &Value) -> bool {
    if non_empty_array(i.get("view_range")) || non_empty_array(i.get("range")) || non_blank_string(i.get("pages")) {
        return true;
    }
    ["offset", "limit", "startLine", "endLine", "start_line", "end_line", "startLineNumber", "endLineNumber", "head", "tail"]
        .iter()
        .any(|k| matches!(i.get(k), Some(Value::Num(n)) if n.is_finite() && *n > 0.0))
}
