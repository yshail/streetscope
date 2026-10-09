"""Build the street twin: vector roads, buildings, trees and stops, plus honest data-quality stats."""

from __future__ import annotations

import math
from collections import Counter

from .geo import Frame, polygon_area, polyline_length
from .osm import parse_number

ROAD_CLASSES = {
    "motorway": "main", "trunk": "main", "primary": "main", "motorway_link": "main", "trunk_link": "main", "primary_link": "main",
    "secondary": "mid", "tertiary": "mid", "secondary_link": "mid", "tertiary_link": "mid",
    "residential": "local", "unclassified": "local", "living_street": "local", "service": "local",
    "footway": "walk", "path": "walk", "steps": "walk", "pedestrian": "walk", "cycleway": "walk", "track": "walk",
}
# Fallback carriageway widths in metres when OSM has no width and no lane count. Marked "default".
DEFAULT_WIDTH = {
    "motorway": 14.0, "trunk": 14.0, "primary": 12.0, "secondary": 9.0, "tertiary": 7.0,
    "motorway_link": 7.0, "trunk_link": 7.0, "primary_link": 7.0, "secondary_link": 6.0, "tertiary_link": 6.0,
    "residential": 6.0, "unclassified": 5.5, "living_street": 4.5, "service": 3.5,
    "footway": 2.0, "path": 1.8, "steps": 2.0, "pedestrian": 4.0, "cycleway": 2.0, "track": 3.0,
}
LANE_WIDTH = 3.25
METRES_PER_LEVEL = 3.2
DEFAULT_LEVELS = 3
DEFAULT_TREE_HEIGHT = 7.0
DEFAULT_CROWN_R = 2.6


def road_width(tags: dict) -> tuple[float, str]:
    """Return (width in metres, source). Source is osm_width, lanes or default."""
    w = parse_number(tags.get("width"))
    if w:
        return w, "osm_width"
    lanes = parse_number(tags.get("lanes"))
    if lanes:
        return lanes * LANE_WIDTH, "lanes"
    return DEFAULT_WIDTH.get(tags.get("highway", ""), 5.0), "default"


def building_height(tags: dict) -> tuple[float, str]:
    h = parse_number(tags.get("height"))
    if h:
        return h, "osm_height"
    levels = parse_number(tags.get("building:levels"))
    if levels:
        return levels * METRES_PER_LEVEL + 1.0, "levels"
    return DEFAULT_LEVELS * METRES_PER_LEVEL + 1.0, "default"


def _ring(geometry: list[dict], frame: Frame) -> list[list[float]]:
    pts = [list(map(lambda v: round(v, 2), frame.to_xz(p["lat"], p["lon"]))) for p in geometry]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    return pts


def _inside(x: float, z: float, radius: float) -> bool:
    return abs(x) <= radius and abs(z) <= radius


def build(elements: list[dict], lat: float, lon: float, radius: float, name: str = "site") -> dict:
    frame = Frame(lat, lon)
    roads, buildings, trees, stops, crossings, ev, signals = [], [], [], [], [], [], []

    for e in elements:
        tags = e.get("tags", {})
        if e["type"] == "way" and "geometry" in e:
            if "highway" in tags and tags["highway"] in ROAD_CLASSES:
                pts = [[round(v, 2) for v in frame.to_xz(p["lat"], p["lon"])] for p in e["geometry"]]
                if len(pts) < 2 or not any(_inside(x, z, radius * 1.1) for x, z in pts):
                    continue
                w, src = road_width(tags)
                roads.append({
                    "id": e["id"], "highway": tags["highway"], "cls": ROAD_CLASSES[tags["highway"]],
                    "name": tags.get("name"), "lanes": parse_number(tags.get("lanes")),
                    "width_m": round(w, 1), "width_source": src, "oneway": tags.get("oneway") == "yes",
                    "bridge": tags.get("bridge") in ("yes", "viaduct"), "pts": pts,
                })
            elif "building" in tags:
                ring = _ring(e["geometry"], frame)
                if len(ring) < 3 or not any(_inside(x, z, radius * 1.05) for x, z in ring):
                    continue
                h, src = building_height(tags)
                buildings.append({
                    "id": e["id"], "height_m": round(h, 1), "height_source": src,
                    "kind": tags["building"], "name": tags.get("name"), "footprint": ring,
                })
        elif e["type"] == "node":
            x, z = (round(v, 2) for v in frame.to_xz(e["lat"], e["lon"]))
            if tags.get("natural") == "tree" and _inside(x, z, radius):
                h = parse_number(tags.get("height")) or DEFAULT_TREE_HEIGHT
                trees.append({"x": x, "z": z, "height_m": round(h, 1),
                               "crown_r": round(parse_number(tags.get("diameter_crown")) / 2, 1)
                               if parse_number(tags.get("diameter_crown")) else DEFAULT_CROWN_R, "source": "osm"})
            elif tags.get("highway") == "bus_stop" and _inside(x, z, radius * 1.2):
                stops.append({"x": x, "z": z, "name": tags.get("name")})
            elif tags.get("highway") == "traffic_signals" and _inside(x, z, radius * 1.1):
                signals.append({"x": x, "z": z})
            elif tags.get("highway") == "crossing" and _inside(x, z, radius):
                crossings.append({"x": x, "z": z, "kind": tags.get("crossing")})
            elif tags.get("amenity") == "charging_station":
                ev.append({"x": x, "z": z, "name": tags.get("name") or tags.get("operator")})

    return {
        "meta": {
            "name": name, "center": {"lat": lat, "lon": lon}, "radius_m": radius,
            "frame": "x east, z south, y up, metres from the centre point",
            "attribution": "(c) OpenStreetMap contributors, ODbL",
        },
        "roads": roads, "buildings": buildings, "trees": trees,
        "stops": stops, "crossings": crossings, "ev": ev, "signals": signals,
        "stats": stats(roads, buildings, trees, stops, crossings, ev, len(signals)),
    }


def stats(roads, buildings, trees, stops, crossings, ev, n_signals: int = 0) -> dict:
    length = Counter()
    for r in roads:
        length[r["cls"]] += polyline_length([tuple(p) for p in r["pts"]])
    drive = [r for r in roads if r["cls"] != "walk"]
    wsrc = Counter(r["width_source"] for r in drive)
    hsrc = Counter(b["height_source"] for b in buildings)
    area = sum(polygon_area([tuple(p) for p in b["footprint"]]) for b in buildings)
    return {
        "road_ways": len(roads),
        "road_km": {k: round(v / 1000, 3) for k, v in sorted(length.items())},
        "road_width_sources": dict(wsrc),
        "buildings": len(buildings),
        "building_height_sources": dict(hsrc),
        "building_footprint_m2": round(area),
        "trees": len(trees), "bus_stops": len(stops), "crossings": len(crossings), "ev_chargers": len(ev),
        "traffic_signals": n_signals,
        "gaps": gaps(len(drive), wsrc, len(buildings), hsrc, len(trees)),
    }


def gaps(n_drive: int, wsrc: Counter, n_b: int, hsrc: Counter, n_trees: int) -> list[str]:
    out = []
    if n_drive:
        measured = wsrc.get("osm_width", 0) + wsrc.get("lanes", 0)
        out.append(f"{measured} of {n_drive} driving roads have a width or lane tag; the rest use class defaults.")
    if n_b:
        real = hsrc.get("osm_height", 0) + hsrc.get("levels", 0)
        out.append(f"{real} of {n_b} buildings have a height or level count; the rest assume 3 floors.")
    if n_trees < 25:
        out.append(f"OpenStreetMap maps only {n_trees} trees here. Use a canopy height map or a point cloud for real tree counts.")
    return out


def tree_height_m(tree: dict) -> float:
    return tree["height_m"]


def crown_area(tree: dict) -> float:
    return math.pi * tree["crown_r"] ** 2
