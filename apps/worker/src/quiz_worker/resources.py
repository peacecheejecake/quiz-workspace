"""CPU thread sizing for the worker's models (M7.4c).

torch (Qwen3), Docling and the BLAS/OpenMP runtimes under them size their thread pools from the
host's CPU count, not from the container's CPU quota: on a 2-vCPU container on an 8-core host they
start 8 threads and run about 2x slower than with 2. `configure_threads` runs in the worker's main
process before any pool process starts (and before torch is imported), and sets the usual thread
variables, which the pool processes inherit:

- `WORKER_NUM_THREADS` set: that value, overriding any thread variable already set;
- unset: the container's CPU limit (cgroup quota, CPU affinity, CPU count, the smallest of them),
  keeping thread variables an operator already set.

Docling also reads `DOCLING_NUM_THREADS` before `OMP_NUM_THREADS`; torch reads `OMP_NUM_THREADS`.
"""

from __future__ import annotations

import math
import os
from collections.abc import MutableMapping
from pathlib import Path

THREAD_VARIABLES = (
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "DOCLING_NUM_THREADS",
)
CGROUP_ROOT = Path("/sys/fs/cgroup")


def cgroup_cpu_quota(root: Path = CGROUP_ROOT) -> float | None:
    """CPUs allowed by the cgroup CPU quota (v2 `cpu.max`, v1 `cpu.cfs_*`); None if unlimited
    or unknown."""
    try:
        quota, period = (root / "cpu.max").read_text(encoding="ascii").split()[:2]
        if quota == "max":
            return None
        return int(quota) / int(period)
    except (OSError, ValueError):
        pass
    try:
        quota_us = int((root / "cpu" / "cpu.cfs_quota_us").read_text(encoding="ascii"))
        period_us = int((root / "cpu" / "cpu.cfs_period_us").read_text(encoding="ascii"))
    except (OSError, ValueError):
        return None
    if quota_us <= 0 or period_us <= 0:
        return None
    return quota_us / period_us


def available_cpus(root: Path = CGROUP_ROOT) -> int:
    """CPUs this process may actually use: the smallest of the CPU count, the affinity mask and
    the cgroup quota (rounded up), at least 1."""
    count = os.cpu_count() or 1
    if hasattr(os, "sched_getaffinity"):
        count = min(count, len(os.sched_getaffinity(0)) or count)
    quota = cgroup_cpu_quota(root)
    if quota is not None:
        count = min(count, math.ceil(quota))
    return max(1, count)


def configure_threads(
    num_threads: int | None,
    environ: MutableMapping[str, str] = os.environ,
    *,
    cgroup_root: Path = CGROUP_ROOT,
) -> int:
    """Set the thread variables (see the module docstring); returns the thread count used."""
    if num_threads is not None:
        for name in THREAD_VARIABLES:
            environ[name] = str(num_threads)
        return num_threads
    threads = available_cpus(cgroup_root)
    for name in THREAD_VARIABLES:
        environ.setdefault(name, str(threads))
    return int(environ["OMP_NUM_THREADS"])
