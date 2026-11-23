"""Simulated weak notebook for a measured process tree (Windows Job Object).

Profiles:
  weak  the job is pinned to logical processors 0 and 1 (affinity mask 0b11) AND has a CPU hard cap of 25 %, a job memory limit
        of 384 MB and at most 8 live processes. Started hidden (CREATE_NO_WINDOW), no focus, no audio.
  none  no limit at all (the job only groups the processes, so they can be accounted and killed together).

What the 25 % cap really is: `calibrate()` measures it (busy worker threads, CPU seconds per wall second) and the harness prints
the number next to every result. On the 16-logical-processor machine it was written on, the cap is machine-wide (6.25 % gave 1.0
core-equivalent, 3.125 % gave 0.5) so 25 % = 4 core-equivalents never binds and the 2-core affinity is the ceiling (about 1.9).
NL_WEAK_CAP_PCT (or run_all.py --weak-cap-pct) overrides the cap, e.g. 3.125 for about 0.5 core-equivalent.
What it does not imitate: SSD, cache sizes, memory bandwidth, thermal throttling, antivirus scanning, a lower single-thread clock,
a laptop power plan. The memory limit is JOB_OBJECT_LIMIT_JOB_MEMORY: it caps COMMITTED memory of the job, not the working set.

Also here: `Sampler` (peak summed working set while the run goes on), `machine_load()` (system CPU % and free memory, sampled, never
waited on) and `calibrate()`.
"""
import ctypes
import ctypes.wintypes as wt
import os
import subprocess
import tempfile
import threading
import time

K = ctypes.WinDLL("kernel32", use_last_error=True)
NTDLL = ctypes.WinDLL("ntdll")
PSAPI = ctypes.WinDLL("psapi", use_last_error=True)
K.OpenProcess.restype = wt.HANDLE
K.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
K.CreateJobObjectW.restype = wt.HANDLE
K.CreateJobObjectW.argtypes = [ctypes.c_void_p, wt.LPCWSTR]
K.CloseHandle.argtypes = [wt.HANDLE]
K.TerminateJobObject.argtypes = [wt.HANDLE, wt.UINT]
K.AssignProcessToJobObject.argtypes = [wt.HANDLE, wt.HANDLE]
K.SetInformationJobObject.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD]
K.QueryInformationJobObject.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD, ctypes.c_void_p]
PSAPI.GetProcessMemoryInfo.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD]
K.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
NTDLL.NtResumeProcess.argtypes = [wt.HANDLE]
PROCESS_QUERY = 0x1000 | 0x0400 | 0x0010


class IOC(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in ("r", "w", "o", "rb", "wb", "ob")]


class Basic(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wt.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wt.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wt.DWORD), ("SchedulingClass", wt.DWORD)]


class Ext(ctypes.Structure):
    _fields_ = [("Basic", Basic), ("Io", IOC), ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t)]


class CpuRate(ctypes.Structure):
    _fields_ = [("ControlFlags", wt.DWORD), ("CpuRate", wt.DWORD)]


class Acct(ctypes.Structure):
    _fields_ = [("TotalUserTime", ctypes.c_longlong), ("TotalKernelTime", ctypes.c_longlong),
                ("ThisPeriodTotalUserTime", ctypes.c_longlong), ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
                ("TotalPageFaultCount", wt.DWORD), ("TotalProcesses", wt.DWORD),
                ("ActiveProcesses", wt.DWORD), ("TotalTerminatedProcesses", wt.DWORD)]


class PMC(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t)]


class MemStatus(ctypes.Structure):
    _fields_ = [("dwLength", wt.DWORD), ("dwMemoryLoad", wt.DWORD), ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong), ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong), ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


PROFILES = {
    "weak": {"cores": 2, "cpu_share_pct": 25.0, "memory_mb": 384, "max_processes": 8},
    "none": None,
}


if os.environ.get("NL_WEAK_CAP_PCT"):
    PROFILES["weak"]["cpu_share_pct"] = float(os.environ["NL_WEAK_CAP_PCT"])


def logical_cores():
    """Logical processors of the machine."""
    return os.cpu_count() or 1


def _filetime_ticks(ft):
    return (ft.dwHighDateTime << 32) | ft.dwLowDateTime


def machine_load(window_s=0.5):
    """Samples the whole machine: system CPU busy % over `window_s` and free physical memory. Never waits for a floor."""
    idle0, kern0, user0 = wt.FILETIME(), wt.FILETIME(), wt.FILETIME()
    K.GetSystemTimes(ctypes.byref(idle0), ctypes.byref(kern0), ctypes.byref(user0))
    time.sleep(window_s)
    idle1, kern1, user1 = wt.FILETIME(), wt.FILETIME(), wt.FILETIME()
    K.GetSystemTimes(ctypes.byref(idle1), ctypes.byref(kern1), ctypes.byref(user1))
    d_idle = _filetime_ticks(idle1) - _filetime_ticks(idle0)
    d_total = (_filetime_ticks(kern1) - _filetime_ticks(kern0)) + (_filetime_ticks(user1) - _filetime_ticks(user0))
    mem = MemStatus()
    mem.dwLength = ctypes.sizeof(mem)
    K.GlobalMemoryStatusEx(ctypes.byref(mem))
    return {"cpu_pct": round(100.0 * (1 - d_idle / d_total), 1) if d_total else None,
            "free_mem_mb": round(mem.ullAvailPhys / 1048576), "total_mem_mb": round(mem.ullTotalPhys / 1048576),
            "mem_load_pct": mem.dwMemoryLoad}


class Job:
    """A job with the profile's limits; `launch` starts a command inside it, suspended until assigned."""

    def __init__(self, profile="weak"):
        """Creates the job and applies the limits of `profile` (a key of PROFILES); kills its processes when closed."""
        self.profile = profile
        self.limits = PROFILES[profile]
        self.h = K.CreateJobObjectW(None, None)
        if not self.h:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        info = Ext()
        info.Basic.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
        if self.limits:
            info.Basic.LimitFlags |= 0x10 | 0x8 | 0x200  # AFFINITY | ACTIVE_PROCESS | JOB_MEMORY
            info.Basic.Affinity = (1 << self.limits["cores"]) - 1
            info.Basic.ActiveProcessLimit = self.limits["max_processes"]
            info.JobMemoryLimit = self.limits["memory_mb"] * 1024 * 1024
        if not K.SetInformationJobObject(self.h, 9, ctypes.byref(info), ctypes.sizeof(info)):
            raise OSError(ctypes.get_last_error(), "SetInformationJobObject(limits) failed")
        if self.limits and self.limits["cpu_share_pct"]:
            rate = CpuRate(0x1 | 0x4, int(self.limits["cpu_share_pct"] * 100))  # ENABLE | HARD_CAP
            if not K.SetInformationJobObject(self.h, 15, ctypes.byref(rate), ctypes.sizeof(rate)):
                raise OSError(ctypes.get_last_error(), "SetInformationJobObject(cpu rate) failed")
        self.sampler = None
        self.proc = None
        self.started = None
        self._names = {}

    def launch(self, args, env=None, cwd=None, stdout=None, stdin=None):
        """Starts `args` hidden, assigns it to the job before it runs, then resumes it. Returns the Popen."""
        env = dict(os.environ if env is None else env)
        for name in ("CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES"):
            env[name] = "-1"
        proc = subprocess.Popen(args, env=env, cwd=cwd, stdin=stdin or subprocess.DEVNULL, stdout=stdout or subprocess.DEVNULL,
                                stderr=subprocess.STDOUT, creationflags=0x08000000 | 0x4)  # NO_WINDOW | SUSPENDED
        self.started = time.perf_counter()
        if not K.AssignProcessToJobObject(self.h, int(proc._handle)):
            proc.kill()
            raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")
        NTDLL.NtResumeProcess(int(proc._handle))
        self.proc = proc
        return proc

    def pids(self):
        """PIDs of the processes currently in the job."""
        buf = (ctypes.c_byte * (8 + 8 * 64))()
        if not K.QueryInformationJobObject(self.h, 3, buf, ctypes.sizeof(buf), None):
            return []
        n = ctypes.cast(buf, ctypes.POINTER(wt.DWORD))[1]
        return list(ctypes.cast(ctypes.byref(buf, 8), ctypes.POINTER(ctypes.c_size_t * n)).contents)

    def _pmc(self, pid):
        h = K.OpenProcess(PROCESS_QUERY, False, pid)
        if not h:
            return None
        pmc = PMC()
        pmc.cb = ctypes.sizeof(pmc)
        ok = PSAPI.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb)
        K.CloseHandle(h)
        return pmc if ok else None

    def _is_console_host(self, pid):
        """True for conhost.exe, the hidden console host CREATE_NO_WINDOW adds to the job (name cached per pid)."""
        if pid not in self._names:
            h = K.OpenProcess(PROCESS_QUERY, False, pid)
            name = ""
            if h:
                buf, size = ctypes.create_unicode_buffer(520), wt.DWORD(520)
                if K.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                    name = os.path.basename(buf.value).lower()
                K.CloseHandle(h)
            self._names[pid] = name
        return self._names[pid] == "conhost.exe"

    def working_set_mb(self, exclude_console_host=False):
        """Sum of the working sets of the live processes of the job, in MB."""
        total = 0
        for pid in self.pids():
            pmc = self._pmc(pid)
            if pmc and not (exclude_console_host and self._is_console_host(pid)):
                total += pmc.WorkingSetSize
        return total / 1048576

    def peak_ws_mb(self, exclude_console_host=False):
        """Sum of the PeakWorkingSetSize of the processes still alive, in MB."""
        total = 0
        for pid in self.pids():
            pmc = self._pmc(pid)
            if pmc and not (exclude_console_host and self._is_console_host(pid)):
                total += pmc.PeakWorkingSetSize
        return total / 1048576

    def cpu_seconds(self):
        """User plus kernel CPU seconds the job has used so far (job accounting)."""
        acct = Acct()
        K.QueryInformationJobObject(self.h, 1, ctypes.byref(acct), ctypes.sizeof(acct), None)
        return (acct.TotalUserTime + acct.TotalKernelTime) / 1e7

    def peak_job_mb(self):
        """PeakJobMemoryUsed: the job's peak COMMITTED memory (what JOB_MEMORY limits), not the working set."""
        info = Ext()
        K.QueryInformationJobObject(self.h, 9, ctypes.byref(info), ctypes.sizeof(info), None)
        return info.PeakJobMemoryUsed / 1048576

    def process_count(self):
        """Total processes that ever ran in the job."""
        acct = Acct()
        K.QueryInformationJobObject(self.h, 1, ctypes.byref(acct), ctypes.sizeof(acct), None)
        return acct.TotalProcesses

    def start_sampler(self, every_s=0.05):
        """Starts the thread that records the peak summed working set and the peak process count while the run goes on."""
        self.sampler = Sampler(self, every_s)
        self.sampler.start()

    def stop_sampler(self):
        """Stops the sampler and returns its peaks as a dict (empty when no sampler ran)."""
        if self.sampler:
            self.sampler.stop()
            return {"sampled_peak_ws_mb": round(self.sampler.peak_ws, 1),
                    "sampled_peak_ws_ex_conhost_mb": round(self.sampler.peak_ws_ex, 1), "samples": self.sampler.n,
                    "peak_live_processes": self.sampler.peak_procs}
        return {}

    def close(self):
        """Terminating the job kills every process in it (KILL_ON_JOB_CLOSE); nothing outside the job is touched."""
        if self.sampler:
            self.sampler.stop()
        K.TerminateJobObject(self.h, 1)
        K.CloseHandle(self.h)


class Sampler(threading.Thread):
    """Background thread that tracks the peak summed working set (with and without conhost.exe) and process count of a job."""

    def __init__(self, job, every_s):
        super().__init__(daemon=True)
        self.job, self.every_s = job, every_s
        self.peak_ws, self.peak_ws_ex, self.peak_procs, self.n = 0.0, 0.0, 0, 0
        self._halt = threading.Event()

    def run(self):
        while not self._halt.is_set():
            pids = self.job.pids()
            total = total_ex = 0
            for pid in pids:
                pmc = self.job._pmc(pid)
                if pmc:
                    total += pmc.WorkingSetSize
                    if not self.job._is_console_host(pid):
                        total_ex += pmc.WorkingSetSize
            self.peak_ws = max(self.peak_ws, total / 1048576)
            self.peak_ws_ex = max(self.peak_ws_ex, total_ex / 1048576)
            self.peak_procs = max(self.peak_procs, len(pids))
            self.n += 1
            self._halt.wait(self.every_s)

    def stop(self):
        self._halt.set()
        if self.is_alive():
            self.join(1)


def calibrate(profile, node, threads=4, seconds=3.0):
    """CPU seconds the job gets per wall second while `threads` busy node worker threads run in it (core-equivalents)."""
    job = Job(profile)
    js = ("const {Worker,isMainThread}=require('worker_threads');\n"
          f"if(isMainThread){{for(let i=0;i<{threads};i++)new Worker(__filename);}}"
          f"else{{const e=Date.now()+{int(seconds * 1000)};while(Date.now()<e){{}}}}\n")
    f = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False)
    f.write(js)
    f.close()
    try:
        t0 = time.perf_counter()
        proc = job.launch([node, f.name])
        proc.wait(60)
        wall = time.perf_counter() - t0
        cpu = job.cpu_seconds()
    finally:
        job.close()
        os.unlink(f.name)
    return {"profile": profile, "busy_threads": threads, "wall_s": round(wall, 2), "cpu_s": round(cpu, 2),
            "effective_core_equivalents": round(cpu / wall, 2)}
