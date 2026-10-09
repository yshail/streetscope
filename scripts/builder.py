"""Build a Streetscope twin for any place on Earth, as a background job the web app can follow.

The job runs `python -m streetscope build` in a child process, turns its log lines into progress steps, and when it
finishes adds the new site to web/data/index.json so GreenCityAI can open it.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "web" / "data"
STEPS = [  # (log text that starts the step, progress %, what the user sees)
    ("asking Overpass", 6, "Downloading OpenStreetMap"),
    ("downloaded", 18, "Map downloaded"),
    ("lidar: reading", 22, "Reading USGS LiDAR from AWS Open Data"),
    ("canopy map: reading", 26, "Reading the satellite canopy height map"),
    ("canopy map:", 34, "Trees found in the canopy map"),
    ("lidar: measured", 34, "Building heights measured by LiDAR"),
    ("computing hourly shade", 40, "Computing hourly shade from the real sun"),
    ("planning what-if fixes", 62, "Testing street trees and wider footpaths"),
    ("screening traffic", 84, "Simulating peak-hour traffic"),
    ("walkway shade % by hour", 97, "Writing the twin"),
]
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:28] or "site"
    base, k = s, 2
    while (DATA / s).exists():
        s, k = f"{base}_{k}", k + 1
    return s


def start(lat: float, lon: float, radius: float, name: str, tz: float, lidar: bool = True) -> dict:
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("latitude or longitude out of range")
    radius = max(150.0, min(800.0, float(radius)))
    sid = slugify(name)
    job = {"id": uuid.uuid4().hex[:10], "site": sid, "name": name, "lat": lat, "lon": lon, "radius": radius,
           "state": "running", "pct": 2, "step": "Starting", "log": [], "started": time.time(), "error": None}
    with _lock:
        _jobs[job["id"]] = job
    cmd = [sys.executable, "-u", "-m", "streetscope", "build", "--lat", str(lat), "--lon", str(lon), "--radius", str(int(radius)),
           "--name", sid, "--out", str(DATA), "--tz", str(tz)] + ([] if lidar else ["--lidar", "off"])
    threading.Thread(target=_run, args=(job, cmd), daemon=True).start()
    return public(job)


def _run(job: dict, cmd: list[str]) -> None:
    env = {**__import__("os").environ, "PYTHONPATH": str(ROOT / "pipeline"), "PYTHONIOENCODING": "utf-8"}
    try:
        p = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        for line in p.stdout:
            line = line.rstrip()
            if not line:
                continue
            job["log"] = (job["log"] + [line])[-40:]
            for key, pct, label in STEPS:
                if line.startswith(key) and pct >= job["pct"]:
                    job["pct"], job["step"] = pct, label
        code = p.wait()
        if code != 0 or not (DATA / job["site"] / "twin.json").exists():
            raise RuntimeError(next((l for l in reversed(job["log"]) if "Error" in l or "error" in l), "the build failed") [:240])
        _register(job)
        job["state"], job["pct"], job["step"] = "done", 100, "Ready"
    except Exception as exc:
        job["state"], job["error"] = "error", str(exc)


def _register(job: dict) -> None:
    idx_path = DATA / "index.json"
    with _lock:
        idx = json.loads(idx_path.read_text(encoding="utf-8"))
        twin = json.loads((DATA / job["site"] / "twin.json").read_text(encoding="utf-8"))
        level = "level 1, LiDAR" if twin["meta"].get("data_level") == 1 else "level 3"
        idx["sites"] = [s for s in idx["sites"] if s["id"] != job["site"]] + [
            {"id": job["site"], "name": f"{job['name']} ({level})", "twin": f"{job['site']}/twin.json", "built": True}]
        idx_path.write_text("{\"sites\":[\n" + ",\n".join(" " + json.dumps(s, ensure_ascii=False) for s in idx["sites"]) + "\n]}\n", encoding="utf-8")


def public(job: dict) -> dict:
    keep = ("id", "site", "name", "state", "pct", "step", "error", "radius")
    out = {k: job[k] for k in keep}
    out["elapsed_s"] = round(time.time() - job["started"])
    out["last"] = job["log"][-1] if job["log"] else ""
    return out


def get(job_id: str) -> dict | None:
    j = _jobs.get(job_id)
    return public(j) if j else None
