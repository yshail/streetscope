"""Command line: python -m streetscope build --lat 28.5672 --lon 77.2100 --name aiims"""

from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path

import numpy as np

from . import canopy, osm, shade, twin


def build_site(args: argparse.Namespace) -> Path:
    out = Path(args.out) / args.name
    out.mkdir(parents=True, exist_ok=True)
    if args.osm:
        elements = osm.load(args.osm)
        print(f"read {len(elements)} OpenStreetMap elements from {args.osm}")
    else:
        print("asking Overpass (can take a minute)...")
        elements = osm.fetch(args.lat, args.lon, int(args.radius + 40))
        (out / "osm.raw.json").write_text(json.dumps({"elements": elements}), encoding="utf-8")
        print(f"downloaded {len(elements)} elements")
    t = twin.build(elements, args.lat, args.lon, args.radius, args.name)
    if not args.no_canopy:
        cache = out / "canopy.bin"
        try:
            n = shade.Grid(args.radius, 1.0).n
            if cache.exists():
                chm = np.frombuffer(cache.read_bytes(), dtype=np.uint8).reshape(n, n)
                print("canopy map: using cached", cache)
            else:
                print("canopy map: reading a window from AWS Open Data...")
                chm = canopy.to_grid(canopy.read_window(args.lat, args.lon, args.radius), args.lat, args.lon, args.radius)
                cache.write_bytes(chm.tobytes())
            info = canopy.apply(t, chm)
            print(f"canopy map: {info['tree_tops_found']} tree tops, {info['canopy_cover_pct']}% cover, "
                  f"{info['osm_trees']} trees from OpenStreetMap, {info['trees_total']} in total")
        except canopy.CanopyUnavailable as exc:
            print("canopy map skipped:", exc)
    day = date.fromisoformat(args.date)
    stack, meta, walk2 = shade.compute(t, day, args.tz, list(range(6, 19)))
    t["shade"] = meta
    (out / "shade.bin").write_bytes(stack.tobytes())
    (out / "walk.bin").write_bytes(walk2.tobytes())
    (out / "twin.json").write_text(json.dumps(t, separators=(",", ":")), encoding="utf-8")
    s = t["stats"]
    print(f"{args.name}: {s['road_ways']} road ways, {s['buildings']} buildings, {s['trees']} trees, {s['bus_stops']} bus stops")
    print("walkway shade % by hour:", dict(zip(meta["hours"], meta["walk_shade_pct"])))
    for g in s["gaps"]:
        print("  gap:", g)
    return out


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="streetscope")
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="build a street twin for a place")
    b.add_argument("--lat", type=float, required=True)
    b.add_argument("--lon", type=float, required=True)
    b.add_argument("--radius", type=float, default=300)
    b.add_argument("--name", required=True)
    b.add_argument("--out", default="web/data")
    b.add_argument("--osm", help="use a saved Overpass JSON instead of downloading")
    b.add_argument("--no-canopy", action="store_true", help="skip the canopy height map")
    b.add_argument("--date", default=date.today().isoformat())
    b.add_argument("--tz", type=float, default=5.5, help="hours from UTC at the site")
    b.set_defaults(fn=build_site)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
