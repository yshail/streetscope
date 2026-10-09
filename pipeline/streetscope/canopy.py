"""Real tree counts from the Meta and WRI 1 m canopy height map (CC BY 4.0, AWS Open Data).

The map is one cloud-optimised GeoTIFF per web-mercator tile at zoom 9. We read only a small window around the
site, resample it to our 1 m metre grid, then find tree tops. The map's average error is about 2.8 m and touching
crowns merge into one, so the tree count is a lower bound, never a measurement.
"""

from __future__ import annotations

import math

import numpy as np

from .shade import Grid, polygon_mask

BASE_URL = "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/"
ATTRIBUTION = "Canopy height: Meta and World Resources Institute, CC BY 4.0 (AWS Open Data)"
MERC_R = 6378137.0
MIN_TREE_M = 3.0      # canopy below this is shrub or noise
MAP_ERROR_M = 2.8     # published mean absolute error


class CanopyUnavailable(RuntimeError):
    pass


def quadkey(lat: float, lon: float, zoom: int = 9) -> str:
    n = 2 ** zoom
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    key = ""
    for i in range(zoom, 0, -1):
        mask = 1 << (i - 1)
        key += str((1 if x & mask else 0) + (2 if y & mask else 0))
    return key


def lonlat_to_mercator(lat: float, lon: float) -> tuple[float, float]:
    return (MERC_R * math.radians(lon), MERC_R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def read_window(lat: float, lon: float, radius_m: float, base_url: str = BASE_URL) -> dict:
    """Read a square window of the canopy map. Needs internet and rasterio."""
    try:
        import rasterio
        from rasterio.windows import from_bounds
    except ImportError as exc:  # pragma: no cover
        raise CanopyUnavailable("install rasterio to read the canopy map") from exc
    url = f"/vsicurl/{base_url}{quadkey(lat, lon)}.tif"
    x, y = lonlat_to_mercator(lat, lon)
    reach = (radius_m + 10) / math.cos(math.radians(lat))  # mercator metres
    try:
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
                          GDAL_HTTP_TIMEOUT="60"):
            with rasterio.open(url) as ds:
                win = from_bounds(x - reach, y - reach, x + reach, y + reach, ds.transform)
                arr = ds.read(1, window=win, boundless=True, fill_value=0)
                tr = ds.window_transform(win)
    except Exception as exc:
        raise CanopyUnavailable(f"could not read the canopy tile ({type(exc).__name__}: {exc})") from exc
    return {"data": arr, "x0": tr.c, "y0": tr.f, "res": tr.a}


def to_grid(win: dict, lat: float, lon: float, radius_m: float, cell: float = 1.0) -> np.ndarray:
    """Resample a mercator window to the local metre grid used by shade.py (rows run south, columns east)."""
    grid = Grid(radius_m, cell)
    k = 1.0 / math.cos(math.radians(lat))  # mercator metres per ground metre
    cx, cy = lonlat_to_mercator(lat, lon)
    xs = grid.x0 + (np.arange(grid.n) + 0.5) * cell
    zs = grid.z0 + (np.arange(grid.n) + 0.5) * cell
    cols = np.floor((cx + xs * k - win["x0"]) / win["res"]).astype(int)
    rows = np.floor((win["y0"] - (cy - zs * k)) / win["res"]).astype(int)
    h, w = win["data"].shape
    ok_r = (rows >= 0) & (rows < h)
    ok_c = (cols >= 0) & (cols < w)
    out = np.zeros((grid.n, grid.n), dtype=np.uint8)
    rr, cc = np.meshgrid(np.clip(rows, 0, h - 1), np.clip(cols, 0, w - 1), indexing="ij")
    out[:] = win["data"][rr, cc]
    out[~ok_r, :] = 0
    out[:, ~ok_c] = 0
    return out


def building_mask(twin: dict, grid: Grid) -> np.ndarray:
    mask = np.zeros((grid.n, grid.n), dtype=bool)
    for b in twin["buildings"]:
        sl, m = polygon_mask(grid, b["footprint"])
        if sl is not None:
            mask[sl] |= m
    return mask


def _shifted_max(a: np.ndarray, r: int) -> np.ndarray:
    pad = np.pad(a, r, mode="constant", constant_values=-1.0)
    n0, n1 = a.shape
    out = np.full(a.shape, -1.0, dtype=a.dtype)
    for dy in range(2 * r + 1):
        for dx in range(2 * r + 1):
            np.maximum(out, pad[dy:dy + n0, dx:dx + n1], out=out)
    return out


def detect_tops(canopy: np.ndarray, blocked: np.ndarray, grid: Grid, min_height: float = MIN_TREE_M, radius: int = 3) -> list[dict]:
    """Local maxima of the smoothed canopy are tree tops. Cells inside buildings are ignored."""
    h = canopy.astype(np.float32)
    h[blocked] = 0.0
    pad = np.pad(h, 1, mode="edge")
    smooth = sum(pad[dy:dy + h.shape[0], dx:dx + h.shape[1]] for dy in range(3) for dx in range(3)) / 9.0
    # break ties on flat tops so each plateau yields exactly one peak
    smooth = smooth + (np.arange(smooth.size, dtype=np.float32).reshape(smooth.shape) * 1e-7)
    peaks = (smooth >= _shifted_max(smooth, radius)) & (smooth >= min_height) & ~blocked
    jj, ii = np.nonzero(peaks)
    cand = []
    for j, i in zip(jj, ii):
        top = float(h[max(0, j - 1):j + 2, max(0, i - 1):i + 2].max())
        cand.append((top, float(grid.x0 + (i + 0.5) * grid.cell), float(grid.z0 + (j + 0.5) * grid.cell)))
    cand.sort(key=lambda c: -c[0])
    tops: list[dict] = []
    kx: list[float] = []
    kz: list[float] = []
    for top, x, z in cand:
        # a taller neighbour within 40% of this tree's height is the same crown
        if kx and float(np.hypot(np.array(kx) - x, np.array(kz) - z).min()) < max(3.0, 0.4 * top):
            continue
        kx.append(x)
        kz.append(z)
        tops.append({"x": round(x, 2), "z": round(z, 2), "height_m": round(top, 1),
                     "crown_r": round(min(5.0, max(1.5, 0.3 * top)), 1), "source": "canopy_map"})
    return tops


def merge_trees(osm_trees: list[dict], tops: list[dict], min_sep: float = 3.0) -> list[dict]:
    """Keep every tree OpenStreetMap mapped, and add canopy tops that are not within min_sep metres of one."""
    if not osm_trees:
        return list(tops)
    ox = np.array([t["x"] for t in osm_trees])
    oz = np.array([t["z"] for t in osm_trees])
    added = [t for t in tops if float(np.hypot(ox - t["x"], oz - t["z"]).min()) >= min_sep]
    return list(osm_trees) + added


def apply(twin: dict, canopy: np.ndarray, cell: float = 1.0) -> dict:
    """Add canopy-derived trees to the twin and record what was found."""
    grid = Grid(twin["meta"]["radius_m"], cell)
    blocked = building_mask(twin, grid)
    osm_trees = [t for t in twin["trees"] if t.get("source", "osm") == "osm"]
    tops = detect_tops(canopy, blocked, grid)
    twin["trees"] = merge_trees(osm_trees, tops)
    covered = (canopy >= MIN_TREE_M) & ~blocked
    open_cells = (~blocked).sum()
    info = {
        "source": "Meta and WRI 1 m canopy height map", "licence": "CC BY 4.0", "map_error_m": MAP_ERROR_M,
        "tree_tops_found": len(tops), "osm_trees": len(osm_trees), "trees_total": len(twin["trees"]),
        "canopy_cover_pct": round(float(covered.sum() / max(1, open_cells) * 100), 1),
        "max_height_m": float(canopy[~blocked].max()) if open_cells else 0.0,
        "note": "tree count is a lower bound: touching crowns merge and the map's average error is 2.8 m",
    }
    twin["stats"]["canopy"] = info
    twin["stats"]["trees"] = len(twin["trees"])
    twin["stats"]["gaps"] = [g for g in twin["stats"]["gaps"] if "OpenStreetMap maps only" not in g] + [
        f"The canopy map found {len(tops)} tree tops and OpenStreetMap mapped {len(osm_trees)}. Treat the total as a lower "
        f"bound: the map's average error is {MAP_ERROR_M} m and touching crowns merge."]
    twin["meta"]["attribution"] += "; " + ATTRIBUTION
    return info
