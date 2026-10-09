"""Deterministic tools over a built street twin. The language model never sees raw data, only these answers."""

from __future__ import annotations

import copy
import json
import math
from datetime import date
from pathlib import Path

import numpy as np

from streetscope import shade as shade_mod
from streetscope.geo import Frame

TREE_HEIGHT_M = 8.0       # assumed height of a newly planted tree after a few years
TREE_CROWN_R = 3.0        # assumed crown radius
COST_PER_TREE_INR = 6000  # assumed planting plus three years of care, not a quote


class Site:
    """A twin folder written by `python -m streetscope build`."""

    def __init__(self, folder: str | Path):
        folder = Path(folder)
        self.folder = folder
        self.twin = json.loads((folder / "twin.json").read_text(encoding="utf-8"))
        self.meta = self.twin["shade"]
        shape = self.meta["shape"]
        self.stack = np.frombuffer((folder / self.meta["file"]).read_bytes(), dtype=np.uint8).reshape(shape)
        n = shape[1]
        self.walk = np.frombuffer((folder / self.meta["walk_file"]).read_bytes(), dtype=np.uint8).reshape(n, n)
        c = self.twin["meta"]["center"]
        self.frame = Frame(c["lat"], c["lon"])

    @property
    def name(self) -> str:
        return self.twin["meta"]["name"]


def site_summary(site: Site) -> dict:
    s = site.twin["stats"]
    return {
        "name": site.name, "centre": site.twin["meta"]["center"], "radius_m": site.twin["meta"]["radius_m"],
        "road_ways": s["road_ways"], "buildings": s["buildings"], "trees_mapped": s["trees"],
        "bus_stops": s["bus_stops"], "crossings": s["crossings"],
        "data_level": site.twin["meta"].get("data_level", 3), "shade_date": site.meta["date"], "known_gaps": s["gaps"],
    }


def measure_road(site: Site, name: str) -> dict:
    needle = name.strip().lower()
    hits = []
    for r in site.twin["roads"]:
        if r["cls"] == "walk" or not r.get("name"):
            continue
        if needle in r["name"].lower():
            length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(r["pts"], r["pts"][1:]))
            hits.append({"name": r["name"], "type": r["highway"], "width_m": r["width_m"],
                         "width_source": r["width_source"], "lanes": r["lanes"], "length_m": round(length)})
    hits.sort(key=lambda h: -h["length_m"])
    if not hits:
        return {"found": False, "query": name}
    return {"found": True, "matches": hits[:3],
            "note": "width_source 'default' means OpenStreetMap had no width or lanes, so this is a class default, not a measurement."}


def count_trees(site: Site) -> dict:
    trees = site.twin["trees"]
    canopy = sum(math.pi * t["crown_r"] ** 2 for t in trees)
    area = (2 * site.twin["meta"]["radius_m"]) ** 2
    info = site.twin["stats"].get("canopy")
    out = {"trees": len(trees), "from_openstreetmap": sum(1 for t in trees if t.get("source") == "osm"),
           "from_canopy_map": sum(1 for t in trees if t.get("source") == "canopy_map"),
           "crown_area_m2": round(canopy), "crown_area_pct_of_site": round(100 * canopy / area, 2)}
    if info:
        out["canopy_cover_pct"] = info["canopy_cover_pct"]
        out["note"] = ("Trees from the satellite canopy map are estimates (average height error 2.8 m). "
                       "Touching crowns merge, so the count is a lower bound.")
    else:
        out["note"] = "Only OpenStreetMap trees are counted, and it under-counts. A canopy map or point cloud would give the real number."
    return out


def _hour_index(site: Site, hour: int) -> int:
    hours = site.meta["hours"]
    return min(range(len(hours)), key=lambda k: abs(hours[k] - hour))


def shade_at(site: Site, hour: int) -> dict:
    k = _hour_index(site, int(hour))
    sun = site.meta["sun"][k]
    return {"hour": site.meta["hours"][k], "walkway_in_shade_pct": site.meta["walk_shade_pct"][k],
            "sun_elevation_deg": sun["el"], "sun_azimuth_deg": sun["az"], "date": site.meta["date"]}


def shade_profile(site: Site) -> dict:
    rows = [(h, p) for h, p, s in zip(site.meta["hours"], site.meta["walk_shade_pct"], site.meta["sun"])
            if p is not None and s["el"] > 15]
    if not rows:
        return {"date": site.meta["date"], "by_hour": {}}
    best, worst = max(rows, key=lambda r: r[1]), min(rows, key=lambda r: r[1])
    return {"date": site.meta["date"], "by_hour": {str(h): p for h, p in rows},
            "most_shaded_hour": best[0], "most_shaded_pct": best[1],
            "least_shaded_hour": worst[0], "least_shaded_pct": worst[1]}


def sun_hotspots(site: Site, top: int = 3, block_m: float = 16.0) -> dict:
    """Stretches of walkway that are in the sun for most of the day."""
    cell = site.meta["cell_m"]
    ox, oz = site.meta["origin"]
    idx = [k for k, s in enumerate(site.meta["sun"]) if s["el"] > 15]
    if not idx:
        return {"spots": []}
    sunny = (site.stack[idx] == shade_mod.SUN).sum(axis=0).astype(np.float32)
    ok = site.walk == 1
    bs = max(1, int(round(block_m / cell)))
    n = sunny.shape[0] // bs * bs
    trees = site.twin["trees"]
    cand = []
    for bj in range(0, n, bs):
        for bi in range(0, n, bs):
            m = ok[bj:bj + bs, bi:bi + bs]
            if m.sum() < 6:
                continue
            jj, ii = np.nonzero(m)
            mean_sun = float(sunny[bj:bj + bs, bi:bi + bs][m].mean())
            cand.append((mean_sun * math.sqrt(m.sum()), mean_sun, float(ox + (bi + ii.mean() + 0.5) * cell),
                         float(oz + (bj + jj.mean() + 0.5) * cell), int(m.sum())))
    cand.sort(reverse=True)
    spots = []
    for _, mean_sun, cx, cz, cells in cand:
        if any(math.hypot(cx - s["x"], cz - s["z"]) < 24 for s in spots):
            continue
        lat, lon = site.frame.to_latlon(cx, cz)
        near = min((math.hypot(t["x"] - cx, t["z"] - cz) for t in trees), default=None)
        spots.append({"x": round(cx, 1), "z": round(cz, 1), "lat": round(lat, 6), "lon": round(lon, 6),
                      "sun_hours": round(mean_sun, 1), "of_hours": len(idx), "walkway_m2": int(cells * cell * cell),
                      "nearest_mapped_tree_m": None if near is None else round(near)})
        if len(spots) >= top:
            break
    return {"spots": spots, "meaning": "sun_hours is how many daytime hours (sun above 15 degrees) this stretch of walkway is lit."}


def what_if_trees(site: Site, n: int = 6) -> dict:
    """Add n trees at the sunniest walkway spots and recompute the shade."""
    n = max(1, min(int(n), 40))
    spots = sun_hotspots(site, top=n)["spots"]
    twin2 = copy.deepcopy(site.twin)
    for s in spots:
        twin2["trees"].append({"x": s["x"], "z": s["z"], "height_m": TREE_HEIGHT_M, "crown_r": TREE_CROWN_R, "source": "planned"})
    day = date.fromisoformat(site.meta["date"])
    _, meta2, _ = shade_mod.compute(twin2, day, site.meta["tz_hours"], site.meta["hours"])
    rows = []
    for h in (9, 12, 15):
        k = _hour_index(site, h)
        rows.append({"hour": site.meta["hours"][k], "before_pct": site.meta["walk_shade_pct"][k],
                     "after_pct": meta2["walk_shade_pct"][k]})
    return {"trees_added": len(spots), "spots": [{"lat": s["lat"], "lon": s["lon"]} for s in spots],
            "walkway_shade": rows,
            "assumptions": f"each new tree is {TREE_HEIGHT_M} m tall with a {TREE_CROWN_R} m crown radius",
            "cost": cost_estimate(len(spots))}


def cost_estimate(n_trees: int) -> dict:
    return {"trees": n_trees, "cost_inr": n_trees * COST_PER_TREE_INR,
            "basis": "ASSUMED unit rate of 6,000 rupees per tree including three years of care. Not a quote."}


TOOLS = {
    "site_summary": site_summary, "measure_road": measure_road, "count_trees": count_trees, "shade_at": shade_at,
    "shade_profile": shade_profile, "sun_hotspots": sun_hotspots, "what_if_trees": what_if_trees, "cost_estimate": cost_estimate,
}
