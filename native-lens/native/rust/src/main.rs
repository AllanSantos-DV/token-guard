//! token-guard PreToolUse slice: the guard behind an HTTP/1.1 hook listener (`native-lens/SPEC.md`).
//!
//!     slice --port N --token T
//!
//! Binds 127.0.0.1 only, one thread per connection, keep-alive. Standard library only; writes no file.

mod decide;
mod json;
mod jsnum;
mod jspath;
mod jsre;
mod payload;
mod rules;
mod sha1;
mod statedir;

#[cfg(test)]
mod battery;

use json::{parse, ParseError, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

const IMPL: &str = "rust";
/// A body above this is drained without being kept and answered fail-open.
const MAX_BODY: usize = 64 << 20;
const MAX_LINE: u64 = 16 * 1024;
const MAX_HEADERS: usize = 200;
const IDLE: Duration = Duration::from_secs(120);

struct Request {
    method: String,
    target: String,
    token: Option<String>,
    /// `None` when the body exceeded [`MAX_BODY`].
    body: Option<Vec<u8>>,
    keep_alive: bool,
}

struct Response {
    status: u16,
    body: String,
    rule: Option<&'static str>,
}

enum ReadError {
    Closed,
    Bad,
}

fn read_line<R: BufRead>(r: &mut R) -> Result<Option<String>, ReadError> {
    let mut buf = Vec::new();
    let n = r.by_ref().take(MAX_LINE + 1).read_until(b'\n', &mut buf).map_err(|_| ReadError::Closed)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.len() as u64 > MAX_LINE {
        return Err(ReadError::Bad);
    }
    while matches!(buf.last(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

fn discard<R: Read>(r: &mut R, mut n: usize) -> Result<(), ReadError> {
    let mut sink = [0u8; 8192];
    while n > 0 {
        let k = n.min(sink.len());
        r.read_exact(&mut sink[..k]).map_err(|_| ReadError::Closed)?;
        n -= k;
    }
    Ok(())
}

fn read_chunked<R: BufRead>(r: &mut R) -> Result<Option<Vec<u8>>, ReadError> {
    let mut body = Vec::new();
    let mut total = 0usize;
    let mut keep = true;
    loop {
        let line = read_line(r)?.ok_or(ReadError::Closed)?;
        let size = usize::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16).map_err(|_| ReadError::Bad)?;
        if size == 0 {
            while read_line(r)?.is_some_and(|l| !l.is_empty()) {}
            return Ok(if keep { Some(body) } else { None });
        }
        total = total.saturating_add(size);
        if total > MAX_BODY {
            keep = false;
            body = Vec::new();
        }
        if keep {
            let at = body.len();
            body.resize(at + size, 0);
            r.read_exact(&mut body[at..]).map_err(|_| ReadError::Closed)?;
        } else {
            discard(r, size)?;
        }
        read_line(r)?.ok_or(ReadError::Closed)?;
    }
}

fn read_request<R: BufRead>(r: &mut R, w: &mut TcpStream) -> Result<Request, ReadError> {
    let line = loop {
        match read_line(r)? {
            None => return Err(ReadError::Closed),
            Some(l) if l.is_empty() => continue,
            Some(l) => break l,
        }
    };
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(ReadError::Bad);
    };
    let mut token: Option<String> = None;
    let mut length: Option<usize> = None;
    let mut chunked = false;
    let mut connection = String::new();
    let mut expect_continue = false;
    for _ in 0..=MAX_HEADERS {
        let l = read_line(r)?.ok_or(ReadError::Closed)?;
        if l.is_empty() {
            let keep_alive = if version == "HTTP/1.0" { connection.contains("keep-alive") } else { !connection.contains("close") };
            if expect_continue {
                w.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").map_err(|_| ReadError::Closed)?;
            }
            let body = if chunked {
                read_chunked(r)?
            } else {
                match length {
                    Some(n) if n > MAX_BODY => {
                        discard(r, n)?;
                        None
                    }
                    Some(n) => {
                        let mut b = vec![0u8; n];
                        r.read_exact(&mut b).map_err(|_| ReadError::Closed)?;
                        Some(b)
                    }
                    None => Some(Vec::new()),
                }
            };
            return Ok(Request { method: method.to_string(), target: target.to_string(), token, body, keep_alive });
        }
        let (k, v) = l.split_once(':').ok_or(ReadError::Bad)?;
        let v = v.trim_matches([' ', '\t']);
        match k.trim().to_ascii_lowercase().as_str() {
            "x-token-guard" => token = Some(match token.take() {
                Some(prev) => format!("{prev}, {v}"),
                None => v.to_string(),
            }),
            "content-length" => length = Some(v.parse().map_err(|_| ReadError::Bad)?),
            "transfer-encoding" => chunked = v.to_ascii_lowercase().contains("chunked"),
            "connection" => connection = v.to_ascii_lowercase(),
            "expect" => expect_continue = v.eq_ignore_ascii_case("100-continue"),
            _ => {}
        }
    }
    Err(ReadError::Bad)
}

/// Length-first, then XOR over every byte, so the time does not reveal where the first difference is.
fn same_token(given: &str, want: &str) -> bool {
    let (a, b) = (given.as_bytes(), want.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn json_response(status: u16, body: String) -> Response {
    Response { status, body, rule: None }
}

fn error_body(msg: &str) -> String {
    format!("{{\"error\":{}}}", json::quoted(msg))
}

fn envelope(reason: &str) -> String {
    format!(
        "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":{}}}}}",
        json::quoted(reason)
    )
}

fn route(req: &Request, token: &str) -> Response {
    let path = req.target.split('?').next().unwrap_or("");
    let health = req.method == "GET" && path == "/token-guard/health";
    if !health && !(req.method == "POST" && path == "/token-guard/pre") {
        return json_response(404, error_body("rota desconhecida"));
    }
    if !same_token(req.token.as_deref().unwrap_or(""), token) {
        return json_response(401, error_body("token ausente ou invalido"));
    }
    if health {
        return json_response(200, format!("{{\"ok\":true,\"pid\":{},\"impl\":\"{IMPL}\"}}", std::process::id()));
    }
    let Some(bytes) = &req.body else { return json_response(200, "{}".into()) };
    let payload: Value = match parse(&String::from_utf8_lossy(bytes)) {
        Ok(v) => v,
        Err(ParseError::Syntax) => return json_response(400, error_body("JSON invalido")),
        Err(ParseError::TooDeep) => return json_response(200, "{}".into()),
    };
    match decide::decide(&payload) {
        Some(v) => Response { status: 200, body: envelope(&v.reason), rule: Some(v.rule) },
        None => json_response(200, "{}".into()),
    }
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Error",
    }
}

fn write_response(w: &mut TcpStream, res: &Response, keep_alive: bool) -> std::io::Result<()> {
    let mut out = format!("HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n", res.status, status_text(res.status), res.body.len());
    if let Some(rule) = res.rule {
        out.push_str(&format!("x-tg-rule: {rule}\r\n"));
    }
    if !keep_alive {
        out.push_str("Connection: close\r\n");
    }
    out.push_str("\r\n");
    out.push_str(&res.body);
    w.write_all(out.as_bytes())
}

fn serve(stream: TcpStream, token: Arc<str>) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(IDLE));
    let Ok(read_half) = stream.try_clone() else { return };
    let mut write_half = stream;
    let mut reader = BufReader::with_capacity(64 * 1024, read_half);
    loop {
        match read_request(&mut reader, &mut write_half) {
            Ok(req) => {
                let res = route(&req, &token);
                if write_response(&mut write_half, &res, req.keep_alive).is_err() || !req.keep_alive {
                    return;
                }
            }
            Err(ReadError::Bad) => {
                let _ = write_response(&mut write_half, &json_response(400, error_body("requisicao invalida")), false);
                return;
            }
            Err(ReadError::Closed) => return,
        }
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(port), Some(token)) = (flag(&args, "--port").and_then(|p| p.parse::<u16>().ok()), flag(&args, "--token")) else {
        eprintln!("usage: slice --port N --token T");
        std::process::exit(2);
    };
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap_or_else(|e| {
        eprintln!("listen 127.0.0.1:{port}: {e}");
        std::process::exit(1);
    });
    println!("READY port={port} impl={IMPL}");
    let _ = std::io::stdout().flush();
    let token: Arc<str> = Arc::from(token);
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let token = Arc::clone(&token);
        let _ = std::thread::Builder::new().stack_size(2 << 20).spawn(move || serve(stream, token));
    }
}
