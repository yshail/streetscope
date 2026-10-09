"""Command line: python -m streetscope build --lat 28.5672 --lon 77.2100 --name aiims"""

from __future__ import annotations

import argparse
import gzip
import json
from datetime import date
from pathlib import Path

import numpy as np

from . import canopy, lidar, osm, scenarios, shade, twin


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
    got_lidar = False
    if args.lidar != "off":
        lcache = out / "lidar.npz"
        try:
            if lcache.exists():
                r, name = lidar.load(lcache), json.loads((out / "lidar.json").read_text())["project"]
                print("lidar: using cached", lcache)
            else:
                projects = lidar.find_projects(args.lat, args.lon)
                if not projects:
                    raise lidar.LidarUnavailable("no USGS 3DEP project covers this point")
                print(f"lidar: reading {projects[0]['name']} from AWS Open Data (can take a minute)...")
                pts = lidar.read_points(args.lat, args.lon, args.radius, projects[0])
                r, name = lidar.rasterize(pts, args.radius), projects[0]["name"]
                lidar.save(lcache, r)
                (out / "lidar.json").write_text(json.dumps({"project": name}))
            info = lidar.apply(t, r, name)
            got_lidar = True
            print(f"lidar: measured {info['buildings_measured']} of {info['buildings_total']} building heights, "
                  f"{info['tree_tops_found']} tree tops, {info['canopy_cover_pct']}% cover")
        except lidar.LidarUnavailable as exc:
            print("lidar skipped:", exc)
    if not args.no_canopy and not got_lidar:
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
    hours = list(range(6, 19))
    stack, meta, walk2 = shade.compute(t, day, args.tz, hours)
    t["shade"] = meta
    gz = lambda b: gzip.compress(b, 6)
    (out / meta["file"]).write_bytes(gz(stack.tobytes()))
    (out / meta["walk_file"]).write_bytes(gz(walk2.tobytes()))
    for old in ("shade.bin", "walk.bin"):
        (out / old).unlink(missing_ok=True)
    print("planning what-if fixes...")
    n_trees = args.trees or int(min(200, max(25, meta["walk_cells"] / 80)))   # about one tree per 80 m2 of walkway
    sc, arrays = scenarios.build(t, day, args.tz, hours, stack, meta, walk2, n_trees)
    for item in sc:
        st, wk = arrays[item["id"]]
        (out / item["files"]["shade"]).write_bytes(gz(st.tobytes()))
        (out / item["files"]["walk"]).write_bytes(gz(wk.tobytes()))
    t["scenarios"] = sc
    (out / "twin.json").write_text(json.dumps(t, separators=(",", ":")), encoding="utf-8")
    s = t["stats"]
    print(f"{args.name}: {s['road_ways']} road ways, {s['buildings']} buildings, {s['trees']} trees, {s['bus_stops']} bus stops")
    print("walkway shade % by hour:", dict(zip(meta["hours"], meta["walk_shade_pct"])))
    for g in s["gaps"]:
        print("  gap:", g)
    for item in sc:
        print(f"  fix {item['id']}: day-mean walkway shade {item['baseline_day_mean_shade_pct']}% -> {item['day_mean_shade_pct']}%, "
              f"{item['extra_walk_m2']} m2 more footpath, cost {item['cost_inr']} (assumed)")
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
    b.add_argument("--lidar", choices=["auto", "off"], default="auto", help="use USGS 3DEP LiDAR where it exists (US only)")
    b.add_argument("--date", default=date.today().isoformat())
    b.add_argument("--trees", type=int, default=0, help="street trees in the what-if scenarios (0 = about one per 80 m2 of walkway)")
    b.add_argument("--tz", type=float, default=5.5, help="hours from UTC at the site")
    b.set_defaults(fn=build_site)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
