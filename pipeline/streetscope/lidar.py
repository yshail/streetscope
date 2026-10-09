"""Level 1 data: measured building and tree heights from USGS 3DEP airborne LiDAR (AWS Open Data, public domain).

The points live in Entwine Point Tile (EPT) octrees in the public bucket `usgs-lidar-public`. We find the project that
covers the site, download only the octree nodes that touch a small window, and turn the points into three 1 m rasters:
ground height, surface height and vegetation height. Everything else works on those rasters.
"""

from __future__ import annotations

import io
import json
import math
import re
import urllib.request
from pathlib import Path

import numpy as np

from . import canopy
from .geo import Frame
from .shade import Grid, polygon_mask

INDEX_URL = "https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson"
ATTRIBUTION = "LiDAR: USGS 3D Elevation Program, public domain (AWS Open Data usgs-lidar-public)"
GROUND, VEG = (2,), (3, 4, 5)
NOISE = (7, 18)
FEET = 0.3048006096012192


class LidarUnavailable(RuntimeError):
    pass


def _get(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "streetscope-hackathon/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _inside(poly, x: float, y: float) -> bool:
    c = False
    for ring in poly:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
    return c


def find_projects(lat: float, lon: float, index: dict | None = None) -> list[dict]:
    """Projects whose outline contains the point, newest survey first."""
    if index is None:
        index = json.loads(_get(INDEX_URL, 180))
    hits = []
    for f in index["features"]:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        if any(_inside(p, lon, lat) for p in polys):
            hits.append(f["properties"])

    def year(p: dict) -> int:
        ys = [int(y) for y in re.findall(r"(?:19|20)\d\d", p["name"])]
        return max(ys) if ys else 0

    return sorted(hits, key=lambda p: (year(p), p.get("count", 0)), reverse=True)


class Ept:
    """Minimal reader for an Entwine Point Tile dataset."""

    def __init__(self, url: str):
        self.base = url.rsplit("/", 1)[0] + "/"
        self.meta = json.loads(_get(url))
        self.bounds = self.meta["bounds"]
        self.span = self.meta["span"]
        self.hier: dict[str, int] = {}
        self._load_hier("0-0-0-0")

    def _load_hier(self, key: str) -> None:
        self.hier.update(json.loads(_get(f"{self.base}ept-hierarchy/{key}.json")))

    @property
    def epsg(self) -> int:
        return int(self.meta["srs"]["horizontal"])

    def node_box(self, key: str) -> tuple[float, float, float, float]:
        d, x, y, _ = (int(v) for v in key.split("-"))
        size = (self.bounds[3] - self.bounds[0]) / (2 ** d)
        return (self.bounds[0] + x * size, self.bounds[1] + y * size, self.bounds[0] + (x + 1) * size, self.bounds[1] + (y + 1) * size)

    def depth_for(self, spacing_crs: float) -> int:
        size0 = self.bounds[3] - self.bounds[0]
        return max(0, int(math.ceil(math.log2(size0 / (self.span * spacing_crs)))))

    def nodes(self, win: tuple[float, float, float, float], max_depth: int) -> list[str]:
        out, stack = [], ["0-0-0-0"]
        while stack:
            key = stack.pop()
            x0, y0, x1, y1 = self.node_box(key)
            if x1 < win[0] or x0 > win[2] or y1 < win[1] or y0 > win[3]:
                continue
            n = self.hier.get(key)
            if n is None:
                continue
            if n == -1:
                self._load_hier(key)
                n = self.hier.get(key, 0)
            if n > 0:
                out.append(key)
            d, x, y, z = (int(v) for v in key.split("-"))
            if d < max_depth:
                for dx in (0, 1):
                    for dy in (0, 1):
                        for dz in (0, 1):
                            child = f"{d + 1}-{2 * x + dx}-{2 * y + dy}-{2 * z + dz}"
                            if child in self.hier:
                                stack.append(child)
        return out

    def read(self, key: str):
        import laspy

        return laspy.read(io.BytesIO(_get(f"{self.base}ept-data/{key}.laz")))


def crs_scale(epsg: int, lat: float, lon: float) -> tuple[object, float]:
    """Return (transformer, ground metres per CRS unit) so any projected CRS works, including feet."""
    from pyproj import Transformer

    tr = Transformer.from_crs(4326, epsg, always_xy=True)
    frame = Frame(lat, lon)
    x0, y0 = tr.transform(lon, lat)
    la, lo = frame.to_latlon(100.0, 0.0)
    x1, y1 = tr.transform(lo, la)
    return tr, 100.0 / max(1e-9, math.hypot(x1 - x0, y1 - y0))


def read_points(lat: float, lon: float, radius_m: float, project: dict, spacing_m: float = 1.5, max_nodes: int = 80) -> dict:
    """Download the points within the window. Returns x, z (ground metres, our frame), height z, class."""
    try:
        ept = Ept(project["url"])
        tr, k = crs_scale(ept.epsg, lat, lon)
        cx, cy = tr.transform(lon, lat)
        reach = (radius_m + 12) / k
        win = (cx - reach, cy - reach, cx + reach, cy + reach)
        nodes = ept.nodes(win, ept.depth_for(spacing_m / k))
        if not nodes:
            raise LidarUnavailable("the project has no points inside the window")
        if len(nodes) > max_nodes:
            nodes = sorted(nodes, key=lambda s: int(s.split("-")[0]))[:max_nodes]
        xs, zs, hs, cl, nrs = [], [], [], [], []
        for key in nodes:
            las = ept.read(key)
            px, py = np.asarray(las.x), np.asarray(las.y)
            m = (px >= win[0]) & (px <= win[2]) & (py >= win[1]) & (py <= win[3])
            if not m.any():
                continue
            xs.append((px[m] - cx) * k)
            zs.append(-(py[m] - cy) * k)
            hs.append(np.asarray(las.z)[m])
            cl.append(np.asarray(las.classification)[m])
            nrs.append(np.asarray(las.number_of_returns)[m])
    except LidarUnavailable:
        raise
    except Exception as exc:
        raise LidarUnavailable(f"could not read LiDAR ({type(exc).__name__}: {exc})") from exc
    if not xs:
        raise LidarUnavailable("no points inside the window")
    return {"x": np.concatenate(xs), "z": np.concatenate(zs), "h": np.concatenate(hs), "cls": np.concatenate(cl),
            "nr": np.concatenate(nrs), "project": project["name"], "nodes": len(nodes)}


def _fill(a: np.ndarray, valid: np.ndarray, iters: int = 40) -> np.ndarray:
    """Fill empty cells with the mean of filled neighbours, growing outwards."""
    a = a.copy()
    valid = valid.copy()
    for _ in range(iters):
        if valid.all():
            break
        pa, pv = np.pad(np.where(valid, a, 0.0), 1), np.pad(valid.astype(np.float32), 1)
        s = sum(pa[dy:dy + a.shape[0], dx:dx + a.shape[1]] for dy in range(3) for dx in range(3))
        c = sum(pv[dy:dy + a.shape[0], dx:dx + a.shape[1]] for dy in range(3) for dx in range(3))
        new = (~valid) & (c > 0)
        a[new] = s[new] / c[new]
        valid |= new
    return a


def rasterize(pts: dict, radius_m: float, cell: float = 1.0, z_scale: float = 1.0) -> dict:
    """Make ground, surface and vegetation-height rasters (metres) on the shared 1 m grid."""
    grid = Grid(radius_m, cell)
    n = grid.n
    ci = np.floor((pts["x"] - grid.x0) / cell).astype(int)
    cj = np.floor((pts["z"] - grid.z0) / cell).astype(int)
    ok = (ci >= 0) & (ci < n) & (cj >= 0) & (cj < n) & ~np.isin(pts["cls"], NOISE)
    ci, cj, h, cls = ci[ok], cj[ok], pts["h"][ok] * z_scale, pts["cls"][ok]
    flat = cj * n + ci

    gmask = np.isin(cls, GROUND)
    dtm = np.full(n * n, np.inf)
    np.minimum.at(dtm, flat[gmask], h[gmask])
    have = np.isfinite(dtm).reshape(n, n)
    if not have.any():
        raise LidarUnavailable("the LiDAR has no ground-classified points here")
    dtm = _fill(np.where(have, dtm.reshape(n, n), 0.0), have)

    dsm = np.full(n * n, -np.inf)
    np.maximum.at(dsm, flat, h)
    dsm_ok = np.isfinite(dsm).reshape(n, n)
    dsm = np.where(dsm_ok, dsm.reshape(n, n), dtm)

    vmask = np.isin(cls, VEG)
    method = "classes"
    if vmask.any():
        veg = np.full(n * n, -np.inf)
        np.maximum.at(veg, flat[vmask], h[vmask])
        veg = np.where(np.isfinite(veg).reshape(n, n), veg.reshape(n, n) - dtm, 0.0)
    elif "nr" in pts:
        # survey has no vegetation labels: leaves give several returns per pulse, roofs give one
        method = "returns"
        agl_pt = h - dtm[cj, ci]
        multi = pts["nr"][ok] > 1
        tall = agl_pt > 2.5
        n_tall = np.bincount(flat[tall], minlength=n * n)
        n_multi = np.bincount(flat[tall & multi], minlength=n * n)
        vh = np.full(n * n, -np.inf)
        np.maximum.at(vh, flat[tall & multi], agl_pt[tall & multi])
        cell_is_veg = (n_tall >= 2) & (n_multi >= 0.35 * np.maximum(n_tall, 1)) & np.isfinite(vh)
        veg = np.where(cell_is_veg, vh, 0.0).reshape(n, n)
    else:
        method = "none"
        veg = np.zeros((n, n))
    surface = np.clip(dsm - dtm, 0, 400)
    return {"agl": surface.astype(np.float32), "veg": np.clip(veg, 0, 80).astype(np.float32), "dtm": dtm.astype(np.float32),
            "density": float(ok.sum() / max(1, dsm_ok.sum())), "coverage": float(dsm_ok.mean()),
            "classes": sorted(int(c) for c in np.unique(pts["cls"])), "veg_method": method}


def save(path: Path, r: dict) -> None:
    np.savez_compressed(path, agl=(r["agl"] * 10).astype(np.uint16), veg=(r["veg"] * 10).astype(np.uint16),
                        meta=np.array([r["density"], r["coverage"]], dtype=np.float32), classes=np.array(r["classes"], dtype=np.int16),
                        veg_method=np.array(r["veg_method"]))


def load(path: Path) -> dict:
    z = np.load(path)
    return {"agl": z["agl"].astype(np.float32) / 10, "veg": z["veg"].astype(np.float32) / 10,
            "density": float(z["meta"][0]), "coverage": float(z["meta"][1]),
            "classes": [int(c) for c in z["classes"]] if "classes" in z.files else [],
            "veg_method": str(z["veg_method"]) if "veg_method" in z.files else "classes"}


def apply(twin: dict, r: dict, project: str, cell: float = 1.0) -> dict:
    """Replace assumed building heights and canopy-map trees with LiDAR-measured ones."""
    grid = Grid(twin["meta"]["radius_m"], cell)
    agl, veg = r["agl"], r["veg"]
    measured = 0
    for b in twin["buildings"]:
        sl, m = polygon_mask(grid, b["footprint"])
        if sl is None or m.sum() < 6:
            continue
        vals = agl[sl][m]
        vals = vals[vals > 2.5]
        if len(vals) < max(6, 0.35 * m.sum()):
            continue  # most of the footprint is not above ground: not a roof, leave the old height
        b["height_m"] = round(float(np.percentile(vals, 90)), 1)
        b["height_source"] = "lidar"
        measured += 1
    blocked = canopy.building_mask(twin, grid)
    tops = canopy.detect_tops(np.clip(veg, 0, 255).astype(np.uint8), blocked, grid)
    for t in tops:
        t["source"] = "lidar"
    keep = [t for t in twin["trees"] if t.get("source") == "osm"]
    twin["trees"] = canopy.merge_trees(keep, tops)
    cover = ((veg >= canopy.MIN_TREE_M) & ~blocked).sum() / max(1, (~blocked).sum()) * 100
    info = {"project": project, "buildings_measured": measured, "buildings_total": len(twin["buildings"]),
            "tree_tops_found": len(tops), "osm_trees": len(keep), "trees_total": len(twin["trees"]),
            "canopy_cover_pct": round(float(cover), 1), "points_per_cell": round(r["density"], 2),
            "coverage_pct": round(r["coverage"] * 100, 1), "vegetation_method": r.get("veg_method", "classes")}
    twin["meta"]["data_level"] = 1
    twin["meta"]["attribution"] += "; " + ATTRIBUTION
    st = twin["stats"]
    st["lidar"] = info
    st["trees"] = len(twin["trees"])
    st["canopy"] = {**st.get("canopy", {}), "canopy_cover_pct": info["canopy_cover_pct"], "tree_tops_found": len(tops),
                    "osm_trees": len(keep), "trees_total": len(twin["trees"]), "source": "USGS 3DEP LiDAR vegetation points",
                    "licence": "public domain", "map_error_m": 0.3,
                    "note": ("tree tops measured from LiDAR vegetation points; touching crowns still merge"
                             if r.get("veg_method", "classes") == "classes" else
                             "this survey has no vegetation labels, so trees are found from multiple-return pulses; "
                             "touching crowns merge and some shrubs or scaffolding may slip in")}
    hs = {}
    for b in twin["buildings"]:
        hs[b["height_source"]] = hs.get(b["height_source"], 0) + 1
    st["building_height_sources"] = hs
    st["gaps"] = [g for g in st["gaps"] if "tree" not in g and "buildings have a height" not in g] + [
        f"LiDAR measured the height of {measured} of {len(twin['buildings'])} buildings; the rest are assumed.",
        f"LiDAR found {len(tops)} tree tops. Touching crowns merge, so the count is a lower bound."]
    return info
