"""Download and read OpenStreetMap data (ODbL, (c) OpenStreetMap contributors)."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
USER_AGENT = "streetscope-hackathon/0.1 (student project; github.com/streetscope)"


def build_query(lat: float, lon: float, radius: int, with_buildings: bool = True) -> str:
    around = f"(around:{radius},{lat},{lon})"
    parts = [
        f'way["highway"]{around};',
        f'node["natural"="tree"]{around};',
        f'node["highway"="bus_stop"]{around};',
        f'node["highway"="crossing"]{around};',
        f'node["amenity"="charging_station"](around:{radius * 2},{lat},{lon});',
    ]
    if with_buildings:
        parts.insert(1, f'way["building"]{around};')
    return "[out:json][timeout:90];(" + "".join(parts) + ");out geom;"


def fetch(lat: float, lon: float, radius: int = 300, with_buildings: bool = True,
          tries: int = 3, pause: float = 6.0) -> list[dict]:
    """Ask Overpass for everything near a point. Tries several mirrors and backs off."""
    query = build_query(lat, lon, radius, with_buildings)
    body = urllib.parse.urlencode({"data": query}).encode()
    last: Exception | None = None
    for attempt in range(tries):
        for url in MIRRORS:
            req = urllib.request.Request(
                url, data=body, method="POST",
                headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
            )
            try:
                with urllib.request.urlopen(req, timeout=150) as resp:
                    return json.loads(resp.read().decode("utf-8")).get("elements", [])
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last = exc
        time.sleep(pause * (attempt + 1))
    raise RuntimeError(f"Overpass did not answer after {tries} rounds: {last}")


def load(path: str | Path) -> list[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return data["elements"] if isinstance(data, dict) else data


def parse_number(text: str | None) -> float | None:
    """Read OSM numbers like '12', '12.5 m', '12,5'. Returns None if it is not a plain length."""
    if not text:
        return None
    t = text.strip().lower().replace(",", ".")
    for unit in ("metres", "meters", "metre", "meter", "m"):
        if t.endswith(unit):
            t = t[: -len(unit)].strip()
            break
    try:
        v = float(t)
    except ValueError:
        return None
    return v if v > 0 else None
