"""Runs the whole measurement: N repetitions ALTERNATING across the contenders (rep 1 of every contender, then rep 2, ...), for each
profile, plus the short-lived hook processes. Writes one JSON per contender and profile into native-lens/raw/ (git-ignored),
`raw/hook-<profile>.json` and `raw/_meta.json`, then prints the markdown summary.

usage: python harness\\run_all.py [--reps 7] [--contenders daemon,noderef,csharp,rust,go] [--profiles weak,none]
                                  [--no-hooks] [--skip-calibration] [--weak-cap-pct 25]

A contender whose artifact is missing (a native exe that is not built yet) is skipped, and the skip is printed and recorded.
The owner's real daemon is never contacted: its endpoint file gets exactly one `stat` before the first run and one after the last.
Needs the cases folder (NL_WORK, default `<system temp>/tg-native-lens`) and node (NODE or PATH). Windows only.
"""
import argparse
import datetime
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import iso  # noqa: E402
import jobrun  # noqa: E402
import load  # noqa: E402
import measure_hook  # noqa: E402
import measure_slice  # noqa: E402
import summarize  # noqa: E402

DEFAULT_CONTENDERS = "daemon,noderef,csharp,rust,go"


def _node_version():
    return subprocess.run([iso.NODE, "-v"], capture_output=True, text=True, timeout=30).stdout.strip()


def _line(res):
    """One progress line for a finished run."""
    if res.get("error"):
        return f"ERROR {res['error'][:160]}"
    ld = res["load"]
    return (f"listen {res['start_to_listening_ms']} ms, idle {res['idle_rss_20s_mb']} MB, seq p50 {ld['seq_keepalive_300']['p50_ms']} ms, "
            f"conc {ld['conc_4x75']['calls_per_s']}/s, verdicts {ld['verdicts']}, "
            f"load cpu {res['machine_load_start']['cpu_pct']}->{res['machine_load_end']['cpu_pct']} %")


def main():
    """Parses the arguments, runs the alternating repetitions, writes raw/ and prints the summary."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--reps", type=int, default=7)
    ap.add_argument("--contenders", default=DEFAULT_CONTENDERS)
    ap.add_argument("--profiles", default="weak,none")
    ap.add_argument("--no-hooks", action="store_true")
    ap.add_argument("--skip-calibration", action="store_true")
    ap.add_argument("--weak-cap-pct", type=float, default=None,
                    help="CPU hard cap of profile weak in %% of the whole machine (default 25; ~3.125 gives ~0.5 core-equivalent on 16 threads)")
    a = ap.parse_args()
    if a.weak_cap_pct is not None:
        jobrun.PROFILES["weak"]["cpu_share_pct"] = a.weak_cap_pct
    iso.check_environment()
    profiles = [p for p in a.profiles.split(",") if p]
    for p in profiles:
        if p not in jobrun.PROFILES:
            raise SystemExit(f"unknown profile {p!r}; known: {', '.join(jobrun.PROFILES)}")
    contenders, skipped = iso.resolve_contenders([c for c in a.contenders.split(",") if c])
    if not contenders and a.no_hooks:
        raise SystemExit("nothing to run")

    mix = load.build_mix(iso.CASES)
    print(f"mix: {len(mix)} payloads, expected {sum(m['expect'] == 'deny' for m in mix)} deny / "
          f"{sum(m['expect'] != 'deny' for m in mix)} allow; ids {[m['id'] for m in mix]}", flush=True)

    before = iso.real_endpoint_stat()
    started = datetime.datetime.now().isoformat(timespec="seconds")
    calibration = {}
    if not a.skip_calibration:
        for p in profiles:
            calibration[p] = jobrun.calibrate(p, iso.NODE)
            print(f"calibration {p}: {calibration[p]['effective_core_equivalents']} core-equivalents "
                  f"({calibration[p]['busy_threads']} busy threads, {calibration[p]['cpu_s']} CPU s in {calibration[p]['wall_s']} s)", flush=True)

    results = {(c, p): [] for c in contenders for p in profiles}
    hooks = {p: {t: [] for t in measure_hook.TARGETS} for p in profiles}
    payloads = None if a.no_hooks else measure_hook._payloads()

    def flush(after=None):
        for (c, p), runs in results.items():
            iso.dump_json(os.path.join(iso.RAW, f"{c}-{p}.json"), {
                "contender": c, "profile": p, "label": iso.CONTENDERS[c]["label"], "calibration": calibration.get(p),
                "real_endpoint_stat_before": before, "real_endpoint_stat_after": after,
                "real_endpoint_unchanged": None if after is None else before == after, "runs": runs})
        if not a.no_hooks:
            for p in profiles:
                measure_hook.save(p, hooks[p], os.path.join(iso.RAW, f"hook-{p}.json"))

    for rep in range(1, a.reps + 1):
        for p in profiles:
            for c in contenders:
                print(f"[rep {rep}/{a.reps}] {c} {p} ...", flush=True)
                res = measure_slice.one_run(c, p, rep, mix)
                results[(c, p)].append(res)
                print(f"    {_line(res)}", flush=True)
                flush()
            if not a.no_hooks:
                floor = None
                for t in measure_hook.TARGETS:
                    r = measure_hook.once(p, t, rep, payloads, floor)
                    hooks[p][t].append(r)
                    floor = hooks[p]["node_floor"][-1].get("processes_started")
                    print(f"[rep {rep}/{a.reps}] hook {t} {p}: wall {r.get('wall_ms')} ms, cpu {r.get('cpu_ms')} ms"
                          + (f" ERROR {r['error']}" if r.get("error") else ""), flush=True)
                flush()

    after = iso.real_endpoint_stat()
    flush(after)
    iso.dump_json(os.path.join(iso.RAW, "_meta.json"), {
        "started": started, "finished": datetime.datetime.now().isoformat(timespec="seconds"), "args": vars(a),
        "node": _node_version(), "python": sys.version.split()[0], "logical_cores": jobrun.logical_cores(),
        "profiles": {p: jobrun.PROFILES[p] for p in profiles}, "calibration": calibration, "skipped": skipped,
        "contenders": contenders, "mix_ids": [m["id"] for m in mix],
        "temp_rule": "TEMP=TMP=TMPDIR=fixtures folder for every contender; HOME=USERPROFILE=LOCALAPPDATA=APPDATA=fresh empty dir per run",
        "real_endpoint_stat_before": before, "real_endpoint_stat_after": after, "real_endpoint_unchanged": before == after})
    print(f"real daemon endpoint file unchanged: {before == after}")
    summarize.print_summary(contenders, profiles)


if __name__ == "__main__":
    main()
