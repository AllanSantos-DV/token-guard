"""Short-lived hook processes in a Job Object profile: wall ms (spawn to exit), CPU ms (job accounting), peak working set (5 ms sampler).

usage: python harness\\measure_hook.py <weak|none> [--reps N] [--out file.json]

Targets:
  node_floor            `node -e 0`, the runtime floor every command hook pays.
  hook_cmd_deny/allow   the REAL adapters/hook-cmd.cjs fed a Claude Code PreToolUse payload on stdin (a deny case and an allow
                        case of the cases file), same isolation and TEMP as the listeners.

Which path hook-cmd takes. hook-cmd.cjs first calls tryDaemon(); with no daemon at the pipe that call SPAWNS a detached daemon and
waits for it (up to 3 x 1.5 s), and the only env switch that skips it (TOKEN_GUARD=off) also turns the guard off, so neither is the
cold in-process decision. The measured command is therefore
  node -e "require(daemon-client).tryDaemon = async () => ({ok:false}); require(hook-cmd)"
which loads the same modules and runs the same code as hook-cmd's fallback (`decide()`, event log write, envelope) and only makes
the daemon call fail at once, exactly what an ECONNREFUSED followed by a disarmed client does. No pipe is touched (the SID is unique
and unused) and the job must have run no more processes than `node -e 0` (node plus the hidden conhost.exe of CREATE_NO_WINDOW):
`processes_started` proves nothing was spawned.
"""
import argparse
import json
import os
import statistics
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import iso  # noqa: E402
import jobrun  # noqa: E402
import load  # noqa: E402

HOOK = os.path.join(iso.ROOT, "adapters", "hook-cmd.cjs")
CLIENT = os.path.join(iso.ROOT, "lib", "daemon-client.cjs")
STUB = "require(process.argv[1]).tryDaemon=async()=>({ok:false});require(process.argv[2]);"
CASE_IDS = {"hook_cmd_deny": "base-1", "hook_cmd_allow": "base-80"}
TARGETS = ["node_floor", "hook_cmd_deny", "hook_cmd_allow"]
PATH_NOTE = "cold in-process (tryDaemon stubbed to fail at once; no daemon, no pipe, no spawn)"


def _payloads():
    """The stdin payload of each hook target, taken from the cases file by id."""
    wanted = set(CASE_IDS.values())
    found = {}
    for line in open(iso.CASES, encoding="utf8"):
        row = json.loads(line)
        if row["id"] in wanted:
            found[row["id"]] = row
    missing = wanted - set(found)
    if missing:
        raise RuntimeError(f"cases missing for the hook targets: {sorted(missing)}")
    return {t: found[i] for t, i in CASE_IDS.items()}


def once(profile, target, rep, payloads, floor_processes=None):
    """One short-lived process. Returns its record. `floor_processes` = processes_started of node_floor (node + the hidden
    conhost.exe); a hook run with more than that reached or spawned a daemon."""
    home = tempfile.mkdtemp(prefix="tgnl-home-")
    out_dir = tempfile.mkdtemp(prefix="tgnl-out-")
    res = {"target": target, "profile": profile, "rep": rep, "machine_load_start": jobrun.machine_load(0.3)}
    stdin = job = None
    try:
        env = iso.iso_env(home, iso.unique_sid("hook"))
        cmd = [iso.NODE, "-e", "0"] if target == "node_floor" else [iso.NODE, "-e", STUB, CLIENT, HOOK]
        if target != "node_floor":
            path = os.path.join(out_dir, "stdin.json")
            with open(path, "w", encoding="utf8") as f:
                json.dump(payloads[target]["payload"], f)
            stdin = open(path, "rb")
            res["case"] = payloads[target]["id"]
        job = jobrun.Job(profile)
        out = open(os.path.join(out_dir, "out.log"), "wb")
        job.start_sampler(0.005)
        proc = job.launch(cmd, env=env, cwd=out_dir, stdin=stdin, stdout=out)
        t0 = job.started
        try:
            proc.wait(60)
        except Exception:  # noqa: BLE001
            res["error"] = "timeout after 60 s"
        res.update({"wall_ms": round((time.perf_counter() - t0) * 1000, 1), "cpu_ms": round(job.cpu_seconds() * 1000, 1),
                    "exit": proc.returncode, "processes_started": job.process_count()})
        res.update(job.stop_sampler())
        out.close()
        stdout = open(os.path.join(out_dir, "out.log"), errors="replace").read()
        res["verdict"] = load.classify(200, stdout) if stdout.strip() else "empty-stdout"
        res["stdout_head"] = stdout[:60]
        if target != "node_floor":
            expect = "deny" if "deny" in target else "empty-stdout"
            if res["verdict"] != expect:
                res["error"] = f"verdict {res['verdict']!r}, expected {expect!r}"
            if floor_processes and res["processes_started"] > floor_processes:
                res["error"] = f"{res['processes_started']} processes ran in the job (floor {floor_processes}): a daemon was spawned"
    except Exception as e:  # noqa: BLE001
        res["error"] = repr(e)
    finally:
        if job is not None:
            job.close()
        if stdin:
            stdin.close()
        res["home_files_after"] = iso.home_files(home)
        iso.rmtree_retry(home)
        iso.rmtree_retry(out_dir)
        res["machine_load_end"] = jobrun.machine_load(0.3)
    return res


def save(profile, runs, out):
    """Writes raw/hook-<profile>.json: {profile, path, runs: {target: [records]}}."""
    iso.dump_json(out, {"profile": profile, "path": PATH_NOTE, "runs": runs})


def main():
    """CLI: runs N repetitions of the short-lived targets in one profile and writes raw/hook-<profile>.json."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("profile", choices=list(jobrun.PROFILES))
    ap.add_argument("--reps", type=int, default=7)
    ap.add_argument("--out", default=None, help="default: raw/hook-<profile>.json")
    a = ap.parse_args()
    iso.check_environment()
    out = a.out or os.path.join(iso.RAW, f"hook-{a.profile}.json")
    payloads = _payloads()
    runs = {t: [] for t in TARGETS}
    for r in range(1, a.reps + 1):
        floor = None
        for t in TARGETS:
            runs[t].append(once(a.profile, t, r, payloads, floor))
            floor = runs["node_floor"][-1].get("processes_started")
        save(a.profile, runs, out)
    for t, v in runs.items():
        ok = [x for x in v if not x.get("error")]
        if ok:
            print(t, {k: round(statistics.median(x[k] for x in ok), 1) for k in ("wall_ms", "cpu_ms", "sampled_peak_ws_mb")})
        for x in v:
            if x.get("error"):
                print(t, "rep", x["rep"], "ERROR", x["error"])
    print(f"wrote {iso.rel(out)}")


if __name__ == "__main__":
    main()
