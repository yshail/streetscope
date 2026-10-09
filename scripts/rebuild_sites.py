"""Rebuild every site in web/data/index.json from a fresh OpenStreetMap download (or cached data with --cached).

Run: python scripts/rebuild_sites.py [--cached]
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITES = {
    # id: (lat, lon, radius, UTC offset hours)
    "aiims": (28.5672, 77.2100, 300, 5.5),
    "connaught": (28.6315, 77.2167, 300, 5.5),
    "shibuya": (35.6595, 139.7005, 250, 9),
    "times": (40.7580, -73.9855, 170, -4),
    "dupont": (38.9096, -77.0434, 200, -4),
}


def main() -> None:
    cached = "--cached" in sys.argv
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    for name, (lat, lon, radius, tz) in SITES.items():
        if only and name not in only:
            continue
        cmd = [sys.executable, "-m", "streetscope", "build", "--lat", str(lat), "--lon", str(lon), "--radius", str(radius),
               "--name", name, "--out", str(ROOT / "web" / "data"), "--tz", str(tz)]
        raw = ROOT / "web" / "data" / name / "osm.raw.json"
        if cached and raw.exists():
            cmd += ["--osm", str(raw)]
        print("==", name, flush=True)
        r = subprocess.run(cmd, cwd=ROOT, env={**__import__("os").environ, "PYTHONPATH": str(ROOT / "pipeline")})
        if r.returncode != 0:
            print("FAILED", name, flush=True)


if __name__ == "__main__":
    main()
