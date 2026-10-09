"""Map context for GreenCityAI: about a kilometre of OpenStreetMap around a point, fetched once and cached on disk.

The browser asks the local server (GET /context?lat=..&lon=..&r=..) instead of hitting the public Overpass servers on
every visit. Demo sites keep their own copy in web/data/<site>/context.json.gz, so they never depend on Overpass.
Run `python scripts/context_proxy.py` to refresh those copies.
"""
from __future__ import annotations

import gzip
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "web" / "data"
CACHE = DATA / "_context"
MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"]


def query(lat: float, lon: float, r: int) -> str:
    """Kept identical to app/src/lib/context.ts."""
    a = f"(around:{r},{lat},{lon})"
    return f"""[out:json][timeout:60];(
way["building"]{a};
way["highway"]{a};
way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green|cemetery|allotments)$"]{a};
way["leisure"~"^(park|garden|pitch|playground|nature_reserve|golf_course)$"]{a};
way["natural"~"^(water|wood|scrub|grassland|wetland)$"]{a};
relation["natural"="water"]{a};relation["leisure"="park"]{a};relation["landuse"="forest"]{a};
way["waterway"~"^(river|canal|stream)$"]{a};
way["railway"~"^(rail|subway|light_rail|tram|monorail)$"]{a};
node["amenity"]{a};node["shop"]{a};node["tourism"]{a};node["leisure"]{a};
node["highway"="bus_stop"]{a};node["public_transport"="station"]{a};node["railway"="station"]{a};
);out geom qt;"""


def fetch(lat: float, lon: float, r: int = 900) -> bytes:
    """Raw Overpass JSON (bytes), from the disk cache when present."""
    CACHE.mkdir(parents=True, exist_ok=True)
    key = CACHE / f"{lat:.4f}_{lon:.4f}_{int(r)}.json.gz"
    if key.exists():
        return gzip.decompress(key.read_bytes())
    body = urllib.parse.urlencode({"data": query(round(lat, 4), round(lon, 4), int(r))}).encode()
    last = ""
    for attempt in range(2):
        for url in MIRRORS:
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": "Streetscope-GreenCityAI/1.0 (study project)"})
                with urllib.request.urlopen(req, timeout=120) as resp:
                    data = resp.read()
                json.loads(data)   # must be valid JSON before it is cached
                key.write_bytes(gzip.compress(data, 6))
                return data
            except Exception as exc:   # try the next mirror
                last = f"{url}: {exc}"
        time.sleep(4)
    raise RuntimeError(f"Overpass is busy ({last[:160]})")


def save_for_sites(radius: int = 900) -> None:
    idx = json.loads((DATA / "index.json").read_text(encoding="utf-8"))
    for s in idx["sites"]:
        out = DATA / s["id"] / "context.json.gz"
        if out.exists():
            continue
        twin = json.loads((DATA / s["twin"]).read_text(encoding="utf-8"))
        c = twin["meta"]["center"]
        data = fetch(c["lat"], c["lon"], radius)
        out.write_bytes(gzip.compress(data, 9))
        print(s["id"], f"{len(data) / 1e6:.1f} MB raw, {out.stat().st_size / 1e6:.1f} MB saved", flush=True)


if __name__ == "__main__":
    save_for_sites()
