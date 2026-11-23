"""One measurement of one contender in one Job Object profile: the real daemon or any slice (node, csharp, rust, go).

usage: python harness\\measure_slice.py <contender> <weak|none> [--reps N] [--out file.json]

Per run: machine load sampled at the start and at the end; fresh empty HOME and unique SID/port/token (see iso.py); start to
listening (first accepted TCP connection) and to a good authenticated health answer whose pid belongs to the job; startup CPU; idle
working set after a 20 s settle; idle CPU over the next 10 s; then 300 sequential calls on one connection, 300 with a new
connection per call, 4 connections x 75 concurrent, over the fixed 20-payload mix; p50/p95/max, CPU per call from the job's
accounting, the verdicts that came back, the peak working set (50 ms sampler + the processes' own peaks + peak job commit).
Memory is reported twice: the sum over every process of the job (the original method) and without conhost.exe, the hidden console
host that CREATE_NO_WINDOW adds to the job (about 8 MB and one extra process, for every contender alike).
The process is started hidden inside the job and stopped by closing the job (its own PIDs only).
"""
import argparse
import json
import os
import secrets
import shutil
import socket
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import iso  # noqa: E402
import jobrun  # noqa: E402
import load  # noqa: E402

LISTEN_DEADLINE_S = 90
IDLE_SETTLE_S = 20
IDLE_CPU_WINDOW_S = 10


def _wait_listening(proc, port, t0):
    """Polls a TCP connect until the port accepts (ms since launch) or the process exits / the deadline passes."""
    deadline = time.time() + LISTEN_DEADLINE_S
    while time.time() < deadline and proc.poll() is None:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.02).close()
            return (time.perf_counter() - t0) * 1000
        except OSError:
            time.sleep(0.002)
    return None


def _tail(path, n=600):
    try:
        return open(path, errors="replace").read()[-n:]
    except OSError:
        return ""


def one_run(name, profile, rep, mix):
    """Runs one measurement and returns its record. Never raises: failures land in `error`."""
    spec = iso.CONTENDERS[name]
    res = {"contender": name, "profile": profile, "rep": rep, "started": False, "kind": spec["kind"]}
    res["machine_load_start"] = jobrun.machine_load()
    home = tempfile.mkdtemp(prefix="tgnl-home-")
    out_dir = tempfile.mkdtemp(prefix="tgnl-out-")
    sid, port, token = iso.unique_sid(name), iso.free_port(), secrets.token_hex(24)
    job = None
    fixtures_before = iso.fixtures_listing()
    try:
        entries = os.listdir(home)
        res["isolation"] = {"home_entries_at_creation": entries, "sid": sid, "port": port,
                            "port_outside_47321_47323": port not in iso.AVOID_PORTS}
        if entries:
            raise RuntimeError(f"HOME was not empty at start: {entries}")
        extra = None
        if spec["kind"] == "daemon":
            iso.write_http_token(home, token)
            extra = iso.daemon_env(port)
        env = iso.iso_env(home, sid, extra)
        res["isolation"]["home_entries_before_launch"] = sorted(os.listdir(home))
        res["isolation"]["child_guard_vars"] = sorted(k for k in env if k.upper().startswith(("TOKEN_GUARD", "CLAUDE", "CODEX", "CURSOR")))
        res["isolation"]["probe"] = iso.visibility_probe(env, out_dir)
        probe = res["isolation"]["probe"]
        if probe["dot_claude"] or probe["dot_codex"] or probe["user_config"] or os.path.normcase(probe["homedir"]) != os.path.normcase(home):
            raise RuntimeError(f"isolation probe saw a real profile: {probe}")

        cmd = spec["cmd"]() + ([] if spec["kind"] == "daemon" else ["--port", str(port), "--token", token])
        res["cmd"] = ["node" if os.path.basename(cmd[0]).lower().startswith("node") else iso.rel(cmd[0])] + [
            "<token>" if cmd[i - 1] == "--token" else iso.rel(a) for i, a in enumerate(cmd) if i > 0]
        res["artifact_bytes"] = os.path.getsize(spec["artifact"])
        log_path = os.path.join(out_dir, "stdout.log")
        log = open(log_path, "wb")
        job = jobrun.Job(profile)
        job.start_sampler(0.05)
        proc = job.launch(cmd, env=env, cwd=out_dir, stdout=log)
        t0 = job.started
        listening = _wait_listening(proc, port, t0)
        if listening is None:
            raise RuntimeError(f"did not listen (exit {proc.poll()}): {_tail(log_path)[-200:]}")
        t_listen = time.perf_counter()
        res["start_to_listening_ms"] = round(listening, 1)
        res["startup_cpu_s"] = round(job.cpu_seconds(), 3)

        client = load.Client(port, token)
        status, body = client.health()
        res["start_to_health_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        client.close()
        if status != 200:
            raise RuntimeError(f"health answered {status}: {body[:200]!r}")
        hjson = json.loads(body)
        res["health_pid"] = hjson.get("pid")
        in_job = res["health_pid"] in job.pids() if res["health_pid"] is not None else None
        res["health_pid_in_job"] = in_job
        if in_job is False:
            raise RuntimeError(f"health pid {res['health_pid']} is not in the job: the port is answered by a foreign process")
        res["started"] = True

        time.sleep(0.3)
        res["ready_line"] = _tail(log_path, 4000).strip().splitlines()[:3]
        time.sleep(max(0, IDLE_SETTLE_S - (time.perf_counter() - t_listen)))
        res["idle_rss_20s_mb"] = round(job.working_set_mb(), 1)
        res["idle_rss_20s_ex_conhost_mb"] = round(job.working_set_mb(exclude_console_host=True), 1)
        c0 = job.cpu_seconds()
        time.sleep(IDLE_CPU_WINDOW_S)
        res["idle_cpu_10s_s"] = round(job.cpu_seconds() - c0, 3)
        if proc.poll() is not None:
            raise RuntimeError(f"process exited during idle (exit {proc.poll()})")

        res["load"] = load.run_load(job, port, token, mix)
        res["ws_after_load_mb"] = round(job.working_set_mb(), 1)
        res["peak_ws_sum_of_process_peaks_mb"] = round(job.peak_ws_mb(), 1)
        res["peak_ws_sum_of_process_peaks_ex_conhost_mb"] = round(job.peak_ws_mb(exclude_console_host=True), 1)
        res["total_cpu_s"] = round(job.cpu_seconds(), 3)
        res["processes_started"] = job.process_count()
        res["alive_at_end"] = proc.poll() is None
        bad = res["load"]["verdict_mismatch_vs_expected"]
        if bad:
            res["warning"] = f"{bad} verdict(s) differ from the expected ones: {res['load']['verdicts']}"
    except Exception as e:  # noqa: BLE001
        res["error"] = repr(e)
    finally:
        if job is not None:
            res.update(job.stop_sampler())
            res["peak_job_commit_mb"] = round(job.peak_job_mb(), 1)
            job.close()
            log.close()
            res["log_tail"] = _tail(os.path.join(out_dir, "stdout.log"))
        time.sleep(0.3)
        iso_info = res.setdefault("isolation", {})
        iso_info["home_files_after"] = iso.home_files(home)
        iso_info["fixtures_added"] = sorted(set(iso.fixtures_listing()) - set(fixtures_before))
        iso_info["locks_removed"] = iso.remove_own_locks(sid)
        iso_info["fixtures_clean_after"] = iso.fixtures_listing() == fixtures_before
        iso_info["home_deleted"] = iso.rmtree_retry(home)
        iso.rmtree_retry(out_dir)
        res["machine_load_end"] = jobrun.machine_load()
    return res


def main():
    """CLI: runs N repetitions of one contender in one profile and writes raw/<contender>-<profile>.json."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("contender", choices=list(iso.CONTENDERS))
    ap.add_argument("profile", choices=list(jobrun.PROFILES))
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--out", default=None, help="default: raw/<contender>-<profile>.json")
    a = ap.parse_args()
    iso.check_environment()
    if not os.path.exists(iso.CONTENDERS[a.contender]["artifact"]):
        raise SystemExit(f"SKIP {a.contender}: artifact missing ({iso.rel(iso.CONTENDERS[a.contender]['artifact'])})")
    out = a.out or os.path.join(iso.RAW, f"{a.contender}-{a.profile}.json")
    mix = load.build_mix(iso.CASES)
    before = iso.real_endpoint_stat()
    runs = []
    for r in range(1, a.reps + 1):
        res = one_run(a.contender, a.profile, r, mix)
        runs.append(res)
        iso.dump_json(out, {"contender": a.contender, "profile": a.profile, "real_endpoint_stat_before": before,
                            "real_endpoint_stat_after": None, "runs": runs})
        print({k: v for k, v in iso.redact(res).items() if k not in ("load", "isolation", "log_tail")}, flush=True)
    after = iso.real_endpoint_stat()
    iso.dump_json(out, {"contender": a.contender, "profile": a.profile, "real_endpoint_stat_before": before,
                        "real_endpoint_stat_after": after, "real_endpoint_unchanged": before == after, "runs": runs})
    print(f"wrote {iso.rel(out)}; real daemon endpoint file unchanged: {before == after}")


if __name__ == "__main__":
    main()
