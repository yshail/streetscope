"""Sun and shade on a 1 m height grid. Pure numpy.

Values written to the shade grid:
    255 sun, 90 shaded by a tree crown, 0 shaded by a building, 1 inside a building footprint.
"""

from __future__ import annotations

import math
from datetime import date, datetime, time, timedelta, timezone

import numpy as np

from .geo import solar_position, sun_dir_xz

SUN, TREE, SHADOW, BUILDING = 255, 90, 0, 1


class Grid:
    def __init__(self, radius: float, cell: float = 1.0):
        n = int(math.ceil(2 * radius / cell))
        n += n % 2  # keep it even so 2 m output blocks fit
        self.cell, self.n, self.x0, self.z0 = cell, n, -radius, -radius

    def idx(self, v: float, axis_min: float) -> int:
        return int(math.floor((v - axis_min) / self.cell))


def polygon_mask(grid: Grid, ring: list[list[float]]):
    """Return ((row_slice, col_slice), boolean mask) for the cells whose centres fall inside ring."""
    xs = [p[0] for p in ring]
    zs = [p[1] for p in ring]
    i0, i1 = max(0, grid.idx(min(xs), grid.x0)), min(grid.n, grid.idx(max(xs), grid.x0) + 1)
    j0, j1 = max(0, grid.idx(min(zs), grid.z0)), min(grid.n, grid.idx(max(zs), grid.z0) + 1)
    if i1 <= i0 or j1 <= j0:
        return None, None
    cx = grid.x0 + (np.arange(i0, i1) + 0.5) * grid.cell
    cz = grid.z0 + (np.arange(j0, j1) + 0.5) * grid.cell
    px, pz = np.meshgrid(cx, cz)
    inside = np.zeros(px.shape, dtype=bool)
    for (x1, z1), (x2, z2) in zip(ring, ring[1:] + ring[:1]):
        if z1 == z2:
            continue
        cond = ((z1 > pz) != (z2 > pz)) & (px < (x2 - x1) * (pz - z1) / (z2 - z1) + x1)
        inside ^= cond
    return (slice(j0, j1), slice(i0, i1)), inside


def disc_offsets(radius_cells: float) -> np.ndarray:
    r = int(math.ceil(radius_cells))
    jj, ii = np.mgrid[-r:r + 1, -r:r + 1]
    keep = (ii * ii + jj * jj) <= radius_cells * radius_cells
    return np.stack([jj[keep], ii[keep]], axis=1)


def stamp_polyline(grid: Grid, pts: list[list[float]], radius_m: float, out: np.ndarray) -> None:
    """Mark every cell within radius_m of the polyline."""
    samples = []
    for (x1, z1), (x2, z2) in zip(pts, pts[1:]):
        seg = math.hypot(x2 - x1, z2 - z1)
        k = max(1, int(seg / (grid.cell * 0.5)))
        for s in range(k + 1):
            t = s / k
            samples.append((x1 + (x2 - x1) * t, z1 + (z2 - z1) * t))
    if not samples:
        return
    arr = np.array(samples)
    ci = np.floor((arr[:, 0] - grid.x0) / grid.cell).astype(int)
    cj = np.floor((arr[:, 1] - grid.z0) / grid.cell).astype(int)
    off = disc_offsets(radius_m / grid.cell)
    jj = (cj[:, None] + off[None, :, 0]).ravel()
    ii = (ci[:, None] + off[None, :, 1]).ravel()
    ok = (jj >= 0) & (jj < grid.n) & (ii >= 0) & (ii < grid.n)
    out[jj[ok], ii[ok]] = True


def build_surfaces(twin: dict, grid: Grid, strip_m: float = 2.0):
    """Rasterise buildings, tree crowns and the walkable surface. strip_m is the footpath width beside each road."""
    n = grid.n
    bld = np.zeros((n, n), dtype=np.float32)
    for b in twin["buildings"]:
        sl, m = polygon_mask(grid, b["footprint"])
        if sl is None:
            continue
        region = bld[sl]
        region[m] = np.maximum(region[m], b["height_m"])
    top = np.zeros((n, n), dtype=np.float32)
    bot = np.zeros((n, n), dtype=np.float32)
    for t in twin["trees"]:
        sl, m = polygon_mask(grid, [[t["x"] - t["crown_r"], t["z"] - t["crown_r"]], [t["x"] + t["crown_r"], t["z"] - t["crown_r"]],
                                    [t["x"] + t["crown_r"], t["z"] + t["crown_r"]], [t["x"] - t["crown_r"], t["z"] + t["crown_r"]]])
        if sl is None:
            continue
        cx = grid.x0 + (np.arange(sl[1].start, sl[1].stop) + 0.5) * grid.cell
        cz = grid.z0 + (np.arange(sl[0].start, sl[0].stop) + 0.5) * grid.cell
        px, pz = np.meshgrid(cx, cz)
        disc = (px - t["x"]) ** 2 + (pz - t["z"]) ** 2 <= t["crown_r"] ** 2
        rt, rb = top[sl], bot[sl]
        rt[disc] = np.maximum(rt[disc], t["height_m"])
        rb[disc] = np.where(rb[disc] == 0, t["height_m"] * 0.45, np.minimum(rb[disc], t["height_m"] * 0.45))

    carriage = np.zeros((n, n), dtype=bool)
    outer = np.zeros((n, n), dtype=bool)
    walk = np.zeros((n, n), dtype=bool)
    for r in twin["roads"]:
        if r["cls"] == "walk":
            stamp_polyline(grid, r["pts"], max(r["width_m"], 2.0) / 2, walk)
        elif r["highway"] != "service" and not r["highway"].endswith("_link") and not r["bridge"]:
            stamp_polyline(grid, r["pts"], r["width_m"] / 2, carriage)
            stamp_polyline(grid, r["pts"], r["width_m"] / 2 + strip_m, outer)
        else:
            stamp_polyline(grid, r["pts"], r["width_m"] / 2, carriage)
    walk |= outer & ~carriage
    walk &= bld == 0
    return bld, top, bot, walk


def _shift(a: np.ndarray, sz: int, sx: int) -> np.ndarray:
    """out[j, i] = a[j + sz, i + sx], zero outside."""
    out = np.zeros_like(a)
    n0, n1 = a.shape
    js, je = max(0, -sz), min(n0, n0 - sz)
    is_, ie = max(0, -sx), min(n1, n1 - sx)
    if je > js and ie > is_:
        out[js:je, is_:ie] = a[js + sz:je + sz, is_ + sx:ie + sx]
    return out


def shade_hour(grid: Grid, bld: np.ndarray, top: np.ndarray, bot: np.ndarray, az: float, el: float) -> np.ndarray:
    out = np.full(bld.shape, SUN, dtype=np.uint8)
    if el <= 2.0:
        out[:] = SHADOW
        return out
    tan = math.tan(math.radians(el))
    dx, dz = sun_dir_xz(az)
    hmax = float(max(bld.max(), top.max(), 1.0))
    reach = min(160.0, hmax / tan)
    b_shade = np.zeros(bld.shape, dtype=bool)
    t_shade = np.zeros(bld.shape, dtype=bool)
    d = grid.cell
    while d <= reach:
        sx, sz = int(round(dx * d / grid.cell)), int(round(dz * d / grid.cell))
        ray = d * tan
        b_shade |= _shift(bld, sz, sx) > ray
        tt, tb = _shift(top, sz, sx), _shift(bot, sz, sx)
        t_shade |= (tt >= ray) & (tb <= ray) & (tt > 0)
        d += grid.cell
    out[t_shade] = TREE
    out[b_shade] = SHADOW
    out[bld > 0] = BUILDING
    return out


def local_sun(lat: float, lon: float, day: date, hour: float, tz_hours: float) -> tuple[float, float]:
    local = datetime.combine(day, time(0, 0)) + timedelta(hours=hour)
    utc = (local - timedelta(hours=tz_hours)).replace(tzinfo=timezone.utc)
    return solar_position(lat, lon, utc)


def compute(twin: dict, day: date, tz_hours: float, hours: list[int], cell: float = 1.0, strip_m: float = 2.0):
    """Return (stack of uint8 grids at 2 m, metadata dict, walkable mask at 2 m)."""
    lat, lon, radius = twin["meta"]["center"]["lat"], twin["meta"]["center"]["lon"], twin["meta"]["radius_m"]
    grid = Grid(radius, cell)
    bld, top, bot, walk = build_surfaces(twin, grid, strip_m)
    layers, sun, pct = [], [], []
    block = max(1, int(round(2.0 / cell)))
    for h in hours:
        az, el = local_sun(lat, lon, day, h, tz_hours)
        vals = shade_hour(grid, bld, top, bot, az, el)
        shaded = (vals[walk] < 200)
        pct.append(round(float(shaded.mean() * 100), 1) if walk.any() and el > 2 else None)
        n2 = grid.n // block
        v = vals[: n2 * block, : n2 * block].reshape(n2, block, n2, block)
        layers.append(v.min(axis=(1, 3)))  # darkest value in each 2 m block
        sun.append({"hour": h, "az": round(az, 1), "el": round(el, 1)})
    stack = np.stack(layers).astype(np.uint8)
    n2 = grid.n // block
    walk2 = walk[: n2 * block, : n2 * block].reshape(n2, block, n2, block).any(axis=(1, 3)).astype(np.uint8)
    meta = {
        "file": "shade.bin.gz", "walk_file": "walk.bin.gz", "dtype": "uint8", "strip_m": strip_m, "shape": list(stack.shape), "cell_m": cell * block,
        "origin": [grid.x0, grid.z0], "date": day.isoformat(), "tz_hours": tz_hours, "hours": hours,
        "legend": {"255": "sun", "90": "tree shade", "0": "building shade", "1": "inside building"},
        "sun": sun, "walk_shade_pct": pct, "walk_cells": int(walk.sum()),
    }
    return stack, meta, walk2
