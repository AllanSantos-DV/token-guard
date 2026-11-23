"""Reads native-lens/raw/*.json and prints the markdown tables (median and min-max over the repetitions, per cell).

usage: python harness\\summarize.py [--contenders daemon,noderef] [--profiles weak,none]
"""
import argparse
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import iso  # noqa: E402

ORDER = ["daemon", "noderef", "csharp", "rust", "go"]

START_COLS = [("start to listening (ms)", "start_to_listening_ms", 0), ("start to health (ms)", "start_to_health_ms", 0),
              ("startup CPU (s)", "startup_cpu_s", 2), ("idle RSS 20 s (MB)", "idle_rss_20s_mb", 1),
              ("idle RSS ex-conhost (MB)", "idle_rss_20s_ex_conhost_mb", 1),
              ("idle CPU 10 s (s)", "idle_cpu_10s_s", 3), ("peak WS sampled (MB)", "sampled_peak_ws_mb", 1),
              ("peak WS ex-conhost (MB)", "sampled_peak_ws_ex_conhost_mb", 1),
              ("peak job commit (MB)", "peak_job_commit_mb", 1), ("processes started", "processes_started", 0),
              ("artifact (KB)", "artifact_kb", 0)]
LOAD_COLS = [("first call (ms)", "load.first_call_ms", 2),
             ("seq p50 (ms)", "load.seq_keepalive_300.p50_ms", 2), ("seq p95 (ms)", "load.seq_keepalive_300.p95_ms", 2),
             ("seq CPU/call (ms)", "load.seq_keepalive_300.cpu_ms_per_call", 3),
             ("new-conn p50 (ms)", "load.seq_newconn_300.p50_ms", 2), ("new-conn p95 (ms)", "load.seq_newconn_300.p95_ms", 2),
             ("new-conn CPU/call (ms)", "load.seq_newconn_300.cpu_ms_per_call", 3),
             ("conc 4x75 p50 (ms)", "load.conc_4x75.p50_ms", 2), ("conc p95 (ms)", "load.conc_4x75.p95_ms", 2),
             ("conc CPU/call (ms)", "load.conc_4x75.cpu_ms_per_call", 3), ("conc calls/s", "load.conc_4x75.calls_per_s", 0)]
LOAD_MACHINE_COLS = [("CPU % at start", "machine_load_start.cpu_pct", 1), ("CPU % at end", "machine_load_end.cpu_pct", 1),
                     ("free MB at start", "machine_load_start.free_mem_mb", 0), ("free MB at end", "machine_load_end.free_mem_mb", 0)]


def cell(vals, nd=1):
    """`median (min-max)` of the numeric values, or n/a."""
    vals = [v for v in vals if isinstance(v, (int, float))]
    if not vals:
        return "n/a"
    f = f"{{:.{nd}f}}".format
    return f"{f(statistics.median(vals))} ({f(min(vals))}-{f(max(vals))})"


def get(r, path):
    """Dotted lookup in nested dicts; None when absent."""
    for k in path.split("."):
        if not isinstance(r, dict) or k not in r:
            return None
        r = r[k]
    return r


def _read(name):
    p = os.path.join(iso.RAW, name)
    return json.load(open(p, encoding="utf8")) if os.path.exists(p) else None


def _blocks(contenders, profiles):
    """[(contender, profile, data)] for the files that exist, in the report order."""
    names = [c for c in ORDER if c in contenders] + [c for c in contenders if c not in ORDER]
    out = []
    for c in names:
        for p in profiles:
            d = _read(f"{c}-{p}.json")
            if d:
                out.append((c, p, d))
    return out


def _table(title, blocks, cols, runs_of=lambda d: d["runs"]):
    print(f"\n### {title}\n")
    print("| contender | profile | ok reps | " + " | ".join(c[0] for c in cols) + " |")
    print("|---|---|---|" + "---|" * len(cols))
    errors = []
    for c, p, d in blocks:
        runs = runs_of(d)
        ok = [r for r in runs if r.get("started") and not r.get("error")]
        for r in ok:
            r["artifact_kb"] = (r.get("artifact_bytes") or 0) / 1024 or None
        print(f"| {c} | {p} | {len(ok)}/{len(runs)} | " + " | ".join(cell([get(r, k) for r in ok], nd) for _, k, nd in cols) + " |")
        errors += [(c, p, r["rep"], r["error"]) for r in runs if r.get("error")]
    for c, p, rep, err in errors:
        print(f"\n- {c} {p} rep {rep} ERROR: {err[:200]}")


def _verdicts(blocks):
    print("\n### Verdicts returned over the timed calls (sum over the ok reps; the load is comparable when the mix is the same)\n")
    print("| contender | profile | timed calls | deny | 200-empty | other | differ from expected |\n|---|---|---|---|---|---|---|")
    for c, p, d in blocks:
        ok = [r for r in d["runs"] if r.get("started") and not r.get("error")]
        tot = {}
        for r in ok:
            for k, v in (get(r, "load.verdicts") or {}).items():
                tot[k] = tot.get(k, 0) + v
        other = {k: v for k, v in tot.items() if k not in ("deny", "200-empty")}
        mism = sum(get(r, "load.verdict_mismatch_vs_expected") or 0 for r in ok)
        print(f"| {c} | {p} | {sum(tot.values())} | {tot.get('deny', 0)} | {tot.get('200-empty', 0)} | {other or 0} | {mism} |")


def _hooks(profiles):
    for p in profiles:
        d = _read(f"hook-{p}.json")
        if not d:
            continue
        n = len(next(iter(d["runs"].values())))
        print(f"\n### Short-lived hook processes, profile {p} (median, min-max over {n} reps)\n")
        print(f"hook path: {d.get('path')}\n")
        print("| process | ok reps | wall ms | CPU ms | peak WS MB | processes started | verdict |\n|---|---|---|---|---|---|---|")
        for t, v in d["runs"].items():
            ok = [x for x in v if not x.get("error")]
            verdicts = sorted({str(x.get("verdict")) for x in ok})
            print(f"| {t} | {len(ok)}/{len(v)} | {cell([x['wall_ms'] for x in ok], 0)} | {cell([x['cpu_ms'] for x in ok], 0)} | "
                  f"{cell([x.get('sampled_peak_ws_mb') for x in ok], 1)} | {cell([x.get('processes_started') for x in ok], 0)} | "
                  f"{', '.join(verdicts)} |")
            for x in v:
                if x.get("error"):
                    print(f"\n- {t} {p} rep {x['rep']} ERROR: {x['error'][:200]}")


def print_summary(contenders=None, profiles=None):
    """Prints every table for the given contenders/profiles (default: all that exist in raw/)."""
    contenders = contenders or ORDER
    profiles = profiles or ["weak", "none"]
    meta = _read("_meta.json") or {}
    blocks = _blocks(contenders, profiles)
    print("\n## Summary (median, min-max over the repetitions)")
    for p, c in (meta.get("calibration") or {}).items():
        print(f"- calibration `{p}`: {c['effective_core_equivalents']} core-equivalents "
              f"({c['busy_threads']} busy threads, {c['cpu_s']} CPU s in {c['wall_s']} s wall)")
    for s in meta.get("skipped") or []:
        print(f"- skipped `{s['contender']}`: {s['reason']} ({s['artifact']})")
    if "real_endpoint_unchanged" in meta:
        print(f"- real daemon endpoint file (stat only, once before and once after): unchanged = {meta['real_endpoint_unchanged']}")
    if meta.get("temp_rule"):
        print(f"- isolation: {meta['temp_rule']}")
    print("\n`ex-conhost` leaves out conhost.exe, the hidden console host CREATE_NO_WINDOW adds to every job (one extra process, ~8 MB); "
          "the other memory columns and `processes started` include it.")
    _table("Start, memory and idle", blocks, START_COLS)
    _table("Load: 300 sequential, 300 new-connection, 4 x 75 concurrent (same 20-payload mix)", blocks, LOAD_COLS)
    _verdicts(blocks)
    _table("Machine load sampled at the start and at the end of each rep", blocks, LOAD_MACHINE_COLS)
    _hooks(profiles)


def main():
    """CLI: prints the summary of whatever is in raw/."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--contenders", default=",".join(ORDER))
    ap.add_argument("--profiles", default="weak,none")
    a = ap.parse_args()
    print_summary([c for c in a.contenders.split(",") if c], [p for p in a.profiles.split(",") if p])


if __name__ == "__main__":
    main()
