"""Load driver shared by every contender (the real daemon and the slices answer the same route, with the same payloads).

Route: `POST /token-guard/pre`, header `X-Token-Guard`, JSON body = a case payload. Health: `GET /token-guard/health`.
The mix is 20 payloads picked by a fixed seed from the cases file (8 deny = 40 %, 12 allow = 60 %; a few that make the guard stat
a large file; shell mixtures), identical for every contender. The verdicts that actually came back are counted per contender.
"""
import http.client
import json
import random
import statistics
import threading
import time

SHELL_TOOLS = {"bash", "powershell", "run_in_terminal"}
LARGE_STAT = ("faixa", "grande", "offset", "limit", "pages", "head", "tail", "view_range", "pdf", "imagem", "notebook")
MIX_SEED = 20261123
# (name, pool filter, how many)
PLAN = [("deny_blindRead", 1), ("deny_broadScan", 2), ("deny_noisePath", 1), ("deny_shell_base", 2), ("deny_shell_mut", 2),
        ("allow_large_stat", 2), ("allow_other_tool", 2), ("allow_shell_base", 4), ("allow_shell_mut", 4)]


def _tool(payload):
    """Tool name across the payload dialects of the cases, lower-cased."""
    for k in ("tool_name", "toolName", "name"):
        if isinstance(payload.get(k), str):
            return payload[k].lower()
    tc = payload.get("toolCall")
    return str(tc.get("toolName", "")).lower() if isinstance(tc, dict) else ""


def _pools(rows):
    pools = {name: [] for name, _ in PLAN}
    for r in rows:
        p, ex = r["payload"], r["expect"]
        tool, deny, grp = _tool(p) if isinstance(p, dict) else "", ex.get("decision") == "deny", r["group"]
        shell = tool in SHELL_TOOLS
        if deny:
            rule = ex.get("rule")
            if rule == "shellDump":
                pools["deny_shell_mut" if grp == "mutation" else "deny_shell_base"].append(r)
            elif grp == "base" and rule in ("blindRead", "broadScan", "noisePath"):
                pools[f"deny_{rule}"].append(r)
        elif grp in ("base", "mutation", "extra") and isinstance(p, dict) and tool:
            if shell:
                pools["allow_shell_mut" if grp == "mutation" else "allow_shell_base"].append(r)
            elif grp == "base":
                reads_file = tool in ("read", "view") or "read_text_file" in tool or "read_media_file" in tool
                label = r["label"].lower()
                big = reads_file and any(w in label for w in LARGE_STAT)
                pools["allow_large_stat" if big else "allow_other_tool"].append(r)
    return pools


def build_mix(cases_path):
    """The 20-payload mix: list of {id, expect, body(bytes)}, in an interleaved deterministic order."""
    rows = [json.loads(line) for line in open(cases_path, encoding="utf8") if line.strip()]
    rng = random.Random(MIX_SEED)
    pools = _pools(rows)
    picked = []
    for name, n in PLAN:
        if len(pools[name]) < n:
            raise RuntimeError(f"case pool {name} has {len(pools[name])} cases, need {n}")
        picked.append([r for r in rng.sample(pools[name], n)])
    mix = []
    while any(picked):
        for group in picked:
            if group:
                mix.append(group.pop())
    rng.shuffle(mix)
    out = [{"id": r["id"], "expect": r["expect"].get("decision") or "allow", "body": json.dumps(r["payload"]).encode("utf8")}
           for r in mix]
    if len(out) != 20:
        raise RuntimeError(f"mix has {len(out)} payloads, expected 20")
    return out


def classify(status, body):
    """'deny', '200-empty' (an empty envelope {}), or a labelled oddity."""
    if status != 200:
        return f"http-{status}"
    try:
        data = json.loads(body)
    except ValueError:
        return "200-notjson"
    if data == {}:
        return "200-empty"
    hso = data.get("hookSpecificOutput") if isinstance(data, dict) else None
    if isinstance(hso, dict) and hso.get("permissionDecision") == "deny":
        return "deny"
    return "200-other"


class Client:
    """Minimal HTTP/1.1 client for the token-guard routes; `new_conn` opens a fresh connection per request."""

    def __init__(self, port, token, new_conn=False):
        self.port, self.token, self.new_conn = port, token, new_conn
        self.conn = http.client.HTTPConnection("127.0.0.1", port, timeout=60)

    def request(self, method, path, body=None):
        """Sends one request with the token header; returns (status, body bytes)."""
        headers = {"X-Token-Guard": self.token}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.new_conn:
            headers["Connection"] = "close"
            self.conn.close()
        self.conn.request(method, path, body, headers)
        resp = self.conn.getresponse()
        return resp.status, resp.read()

    def pre(self, body):
        """POST /token-guard/pre with a pre-serialized JSON body."""
        return self.request("POST", "/token-guard/pre", body)

    def health(self):
        """GET /token-guard/health."""
        return self.request("GET", "/token-guard/health")

    def close(self):
        """Closes the connection."""
        self.conn.close()


def pct(xs, p):
    """The `p` quantile (0-1) of `xs`, nearest-rank."""
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))]


def summarize(lat_ms):
    """p50, p95 and max of a latency list in ms."""
    return {"p50_ms": round(statistics.median(lat_ms), 3), "p95_ms": round(pct(lat_ms, 0.95), 3), "max_ms": round(max(lat_ms), 3)}


class Tally:
    """Counts the verdict that came back per call and how many disagree with the expected one (thread safe)."""

    def __init__(self):
        self.counts, self.mismatch, self.lock = {}, 0, threading.Lock()

    def add(self, item, status, body):
        verdict = classify(status, body)
        want = "deny" if item["expect"] == "deny" else "200-empty"
        with self.lock:
            self.counts[verdict] = self.counts.get(verdict, 0) + 1
            if verdict != want:
                self.mismatch += 1


def run_load(job, port, token, mix):
    """300 sequential on one connection, 300 sequential with a new connection per call, 4 connections x 75 concurrent.
    CPU per call is the job's CPU accounting delta over the phase divided by the calls."""
    out, tally = {}, Tally()
    n = len(mix)

    warm = Client(port, token)
    t = time.perf_counter()
    status, body = warm.pre(mix[0]["body"])
    out["first_call_ms"] = round((time.perf_counter() - t) * 1000, 3)
    tally_warm = Tally()
    tally_warm.add(mix[0], status, body)
    for item in mix[1:]:
        tally_warm.add(item, *warm.pre(item["body"]))
    out["warmup_verdicts"] = tally_warm.counts

    def seq(client, count, label):
        lat, c0 = [], job.cpu_seconds()
        for i in range(count):
            item = mix[i % n]
            t0 = time.perf_counter()
            status, body = client.pre(item["body"])
            lat.append((time.perf_counter() - t0) * 1000)
            tally.add(item, status, body)
        out[label] = {**summarize(lat), "cpu_ms_per_call": round((job.cpu_seconds() - c0) / count * 1000, 3), "calls": count}

    seq(warm, 300, "seq_keepalive_300")
    warm.close()
    fresh = Client(port, token, new_conn=True)
    seq(fresh, 300, "seq_newconn_300")
    fresh.close()

    lat, lock, errs = [], threading.Lock(), []

    def worker(k):
        try:
            cl = Client(port, token)
            for i in range(75):
                item = mix[(i + 5 * k) % n]
                t0 = time.perf_counter()
                status, body = cl.pre(item["body"])
                ms = (time.perf_counter() - t0) * 1000
                tally.add(item, status, body)
                with lock:
                    lat.append(ms)
            cl.close()
        except Exception as e:  # noqa: BLE001
            errs.append(repr(e))

    c0, tw = job.cpu_seconds(), time.perf_counter()
    ths = [threading.Thread(target=worker, args=(k,)) for k in range(4)]
    [t.start() for t in ths]
    [t.join() for t in ths]
    wall = time.perf_counter() - tw
    if errs:
        raise RuntimeError(f"concurrent workers failed: {errs[:2]}")
    out["conc_4x75"] = {**summarize(lat), "cpu_ms_per_call": round((job.cpu_seconds() - c0) / len(lat) * 1000, 3),
                        "calls": len(lat), "calls_per_s": round(len(lat) / wall, 1), "wall_s": round(wall, 3)}
    out["verdicts"] = dict(sorted(tally.counts.items()))
    out["verdict_mismatch_vs_expected"] = tally.mismatch
    out["timed_calls"] = sum(tally.counts.values())
    return out
