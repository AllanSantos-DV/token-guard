"""Paths, contender registry and the isolation of every measured process.

Nothing here is absolute: the project root, the native-lens folder and the raw folder come from this file's location; the cases
folder comes from NL_WORK or `<system temp>/tg-native-lens`; node comes from NODE or PATH.

Isolation rule (the same for EVERY contender, the real daemon included):
  HOME = USERPROFILE = LOCALAPPDATA = APPDATA = a fresh empty temporary directory per run (the real home is never visible);
  TEMP = TMP = TMPDIR = the fixtures folder of the cases, because `noisePath` judges paths against os.tmpdir() and the expected
  verdicts were produced with that temp dir (one rule for all contenders keeps the decisions comparable);
  every TOKEN_GUARD*, CLAUDE*, CODEX* and CURSOR* variable of the parent is deleted, then TOKEN_GUARD_SID (a unique pipe name)
  and, for the daemon, the settings below are set.
"""
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LENS = os.path.dirname(HERE)
ROOT = os.path.dirname(LENS)
RAW = os.path.join(LENS, "raw")
NODE = os.environ.get("NODE") or shutil.which("node")
WORK = os.environ.get("NL_WORK") or os.path.join(tempfile.gettempdir(), "tg-native-lens")
CASES = os.path.join(WORK, "cases.jsonl")
FIXTURES = os.path.join(WORK, "fixtures")
REAL_HOME = os.path.expanduser("~")
REAL_ENDPOINT = os.path.join(REAL_HOME, ".token-guard", "daemon-http.json")
AVOID_PORTS = range(47321, 47324)
DROP_PREFIXES = ("TOKEN_GUARD", "CLAUDE", "CODEX", "CURSOR", "NODE_OPTIONS")

CONTENDERS = {
    "daemon": {"kind": "daemon", "label": "real daemon", "artifact": os.path.join(ROOT, "adapters", "daemon-server.cjs"),
               "cmd": lambda: [NODE, os.path.join(ROOT, "adapters", "daemon-server.cjs")]},
    "noderef": {"kind": "slice", "label": "node slice", "artifact": os.path.join(LENS, "node-ref", "slice.cjs"),
                "cmd": lambda: [NODE, os.path.join(LENS, "node-ref", "slice.cjs")]},
}
for _lang in ("csharp", "rust", "go"):
    _exe = os.path.join(LENS, "native", _lang, "out", "slice.exe")
    CONTENDERS[_lang] = {"kind": "slice", "label": f"{_lang} slice", "artifact": _exe, "cmd": (lambda e=_exe: [e])}


def resolve_contenders(names):
    """Splits the requested names into (runnable, skipped); a contender whose artifact is missing is skipped and said so."""
    runnable, skipped = [], []
    for n in names:
        if n not in CONTENDERS:
            raise SystemExit(f"unknown contender {n!r}; known: {', '.join(CONTENDERS)}")
        c = CONTENDERS[n]
        if os.path.exists(c["artifact"]):
            runnable.append(n)
        else:
            skipped.append({"contender": n, "reason": "artifact missing", "artifact": rel(c["artifact"])})
            print(f"SKIP {n}: artifact missing ({rel(c['artifact'])})", flush=True)
    return runnable, skipped


def rel(path):
    """Path relative to the project root when inside it, else as is (keeps absolute user paths out of the records)."""
    try:
        r = os.path.relpath(path, ROOT)
        return path if r.startswith("..") else r.replace("\\", "/")
    except ValueError:
        return path


def redact(obj):
    """Replaces the real home path and the user name by placeholders in every string of a JSON-able structure."""
    user = os.environ.get("USERNAME") or os.path.basename(REAL_HOME)

    def fix(s):
        s = s.replace(REAL_HOME, "<home>").replace(REAL_HOME.replace("\\", "/"), "<home>")
        return s.replace(user, "<user>") if user else s

    if isinstance(obj, str):
        return fix(obj)
    if isinstance(obj, dict):
        return {fix(str(k)): redact(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [redact(v) for v in obj]
    return obj


def dump_json(path, obj):
    """Writes `obj` as indented JSON to `path` atomically, with the real home path and user name redacted."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(redact(obj), f, indent=1)
    os.replace(tmp, path)


def free_port():
    """A port the OS reports free right now, outside the range the real daemon uses (47321-47323)."""
    for _ in range(50):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port not in AVOID_PORTS:
            return port
    raise RuntimeError("no free port outside 47321-47323 after 50 tries")


def unique_sid(tag):
    """A unique TOKEN_GUARD_SID (it names the daemon pipe), so no run can meet another daemon."""
    return f"nl-{tag}-{os.getpid()}-{secrets.token_hex(4)}"


def real_endpoint_stat():
    """The ONLY look at the owner's real daemon: os.stat of its endpoint file (mtime and size). Never opens, reads or connects."""
    try:
        st = os.stat(REAL_ENDPOINT)
        return {"exists": True, "mtime_ns": st.st_mtime_ns, "size": st.st_size}
    except OSError as e:
        return {"exists": False, "error": type(e).__name__}


def iso_env(home, sid, extra=None):
    """Clean child environment for the run (see the module docstring); `home` is the fresh empty directory."""
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(DROP_PREFIXES)}
    drive, tail = os.path.splitdrive(home)
    env.update({
        "HOME": home, "USERPROFILE": home, "HOMEDRIVE": drive, "HOMEPATH": tail, "LOCALAPPDATA": home, "APPDATA": home,
        "XDG_STATE_HOME": os.path.join(home, "state"), "npm_config_cache": os.path.join(home, "npm-cache"),
        "TEMP": FIXTURES, "TMP": FIXTURES, "TMPDIR": FIXTURES, "TOKEN_GUARD_SID": sid,
    })
    env.update(extra or {})
    return env


def daemon_env(port):
    """Extra settings only the real daemon reads."""
    return {"TOKEN_GUARD_HTTP_PORT": str(port), "TOKEN_GUARD_DAEMON_IDLE_MS": "0", "TOKEN_GUARD_TRAY": "off",
            "TOKEN_GUARD_NO_AUTOSTART": "1", "TOKEN_GUARD_NO_DAEMON_SWAP": "1"}


def write_http_token(home, token):
    """Writes the http token where adapters/daemon-http.cjs httpTokenPath() reads it (`<home>/.token-guard/daemon-http.token`)."""
    d = os.path.join(home, ".token-guard")
    os.makedirs(d)
    with open(os.path.join(d, "daemon-http.token"), "w", encoding="utf8") as f:
        f.write(token)


PROBE_JS = (
    "const fs=require('fs'),os=require('os'),p=require('path');const h=os.homedir();"
    "const ex=(...a)=>fs.existsSync(p.join(h,...a));"
    "console.log(JSON.stringify({homedir:h,tmpdir:os.tmpdir(),localappdata:process.env.LOCALAPPDATA,appdata:process.env.APPDATA,"
    "dot_claude:ex('.claude'),dot_codex:ex('.codex'),dot_copilot:ex('.copilot'),dot_cursor:ex('.cursor'),"
    "user_config:ex('.token-guard','token-guard.config.json'),home_entries:fs.readdirSync(h),"
    "env_guard_vars:Object.keys(process.env).filter(k=>/^(TOKEN_GUARD|CLAUDE|CODEX|CURSOR)/i.test(k)).sort()}))"
)


def visibility_probe(env, cwd):
    """Runs a short node process with the child environment and reports what it can see of home, temp and config."""
    out = subprocess.run([NODE, "-e", PROBE_JS], env=env, cwd=cwd, capture_output=True, text=True, timeout=30,
                         creationflags=0x08000000)
    if out.returncode != 0:
        raise RuntimeError(f"visibility probe failed: {out.stderr[:300]}")
    return json.loads(out.stdout)


def home_files(home, limit=60):
    """Relative file list (with sizes) found under `home`: what the measured process wrote there."""
    found = []
    for base, _, files in os.walk(home):
        for name in files:
            p = os.path.join(base, name)
            try:
                found.append({"file": os.path.relpath(p, home).replace("\\", "/"), "bytes": os.path.getsize(p)})
            except OSError:
                pass
    return sorted(found, key=lambda x: x["file"])[:limit]


def rmtree_retry(path, tries=20):
    """Deletes a directory this harness created; Windows may hold a handle for a moment after the job is killed."""
    for i in range(tries):
        try:
            shutil.rmtree(path)
            return True
        except FileNotFoundError:
            return True
        except OSError:
            time.sleep(0.1)
    return False


def fixtures_listing():
    """Top-level names of the fixtures folder."""
    return sorted(os.listdir(FIXTURES)) if os.path.isdir(FIXTURES) else []


def remove_own_locks(sid):
    """Removes the singleton lock file the daemon wrote under the fixtures temp dir for THIS run's SID, and nothing else."""
    d = os.path.join(FIXTURES, "token-guard-locks")
    removed = []
    if os.path.isdir(d):
        for name in os.listdir(d):
            if sid in name:
                try:
                    os.unlink(os.path.join(d, name))
                    removed.append(name)
                except OSError:
                    pass
        try:
            os.rmdir(d)
        except OSError:
            pass
    return removed


def check_environment():
    """Fails loud when something the harness needs is missing."""
    problems = []
    if not NODE:
        problems.append("node not found (set NODE or put it on PATH)")
    if not os.path.isfile(CASES):
        problems.append(f"cases file missing: {CASES} (set NL_WORK to the folder with cases.jsonl and fixtures/)")
    if not os.path.isdir(FIXTURES):
        problems.append(f"fixtures folder missing: {FIXTURES}")
    if sys.platform != "win32":
        problems.append("Windows only (Job Objects)")
    if problems:
        raise SystemExit("harness cannot run:\n  - " + "\n  - ".join(problems))
