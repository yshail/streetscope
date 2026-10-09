import math
from datetime import date, datetime, timezone

import numpy as np

from streetscope import shade, twin
from streetscope.geo import Frame, polygon_area, solar_position
from streetscope.osm import build_query, parse_number


def test_frame_round_trip():
    f = Frame(28.5672, 77.2100)
    x, z = f.to_xz(28.5682, 77.2110)
    assert 100 < z * -1 < 120          # 0.001 deg north is about 111 m
    lat, lon = f.to_latlon(x, z)
    assert abs(lat - 28.5682) < 1e-9 and abs(lon - 77.2110) < 1e-9


def test_parse_number():
    assert parse_number("12") == 12
    assert parse_number("12,5 m") == 12.5
    assert parse_number("tall") is None
    assert parse_number(None) is None


def test_road_width_sources():
    assert twin.road_width({"highway": "primary", "width": "14 m"}) == (14.0, "osm_width")
    assert twin.road_width({"highway": "primary", "lanes": "4"}) == (13.0, "lanes")
    w, src = twin.road_width({"highway": "residential"})
    assert src == "default" and w == 6.0


def test_building_height_sources():
    assert twin.building_height({"height": "30"}) == (30.0, "osm_height")
    h, src = twin.building_height({"building:levels": "5"})
    assert src == "levels" and abs(h - 17.0) < 1e-9
    assert twin.building_height({})[1] == "default"


def test_solar_noon_delhi_october():
    # solar noon at 77.21 E is about 06:30 UTC (equation of time moves it a few minutes)
    best = max(
        (solar_position(28.5672, 77.21, datetime(2026, 10, 9, 6, m, tzinfo=timezone.utc)) for m in range(0, 60, 5)),
        key=lambda t: t[1],
    )
    az, el = best
    assert 53 < el < 57               # 90 - 28.6 - 6.6 declination
    assert 170 < az < 190             # due south


def test_polygon_mask_area():
    g = shade.Grid(50, 1.0)
    ring = [[-10, -10], [10, -10], [10, 10], [-10, 10]]
    sl, m = shade.polygon_mask(g, ring)
    assert abs(m.sum() - polygon_area([tuple(p) for p in ring])) < 40


def _box_twin(h=20):
    ring = [[-10, -10], [10, -10], [10, 10], [-10, 10]]
    return {
        "meta": {"center": {"lat": 28.5672, "lon": 77.21}, "radius_m": 80},
        "buildings": [{"footprint": ring, "height_m": h}], "trees": [], "roads": [],
    }


def test_building_shadow_falls_away_from_sun():
    t = _box_twin(20)
    g = shade.Grid(80, 1.0)
    bld, top, bot, _ = shade.build_surfaces(t, g)
    # sun due south at 45 degrees: shadow of a 20 m wall reaches 20 m to the north (negative z)
    vals = shade.shade_hour(g, bld, top, bot, az=180.0, el=45.0)
    def at(x, z):
        return vals[g.idx(z, g.z0), g.idx(x, g.x0)]
    assert at(0, -20) == shade.SHADOW      # 10 m behind the wall
    assert at(0, -35) == shade.SUN         # beyond the 20 m shadow
    assert at(0, 25) == shade.SUN          # sun side is lit
    assert at(0, 0) == shade.BUILDING


def test_tree_gives_partial_shade():
    t = {"meta": {"center": {"lat": 28.5672, "lon": 77.21}, "radius_m": 60}, "buildings": [], "roads": [],
         "trees": [{"x": 0, "z": 0, "height_m": 10, "crown_r": 3, "source": "osm"}]}
    g = shade.Grid(60, 1.0)
    bld, top, bot, _ = shade.build_surfaces(t, g)
    vals = shade.shade_hour(g, bld, top, bot, az=180.0, el=60.0)
    # at 60 degrees a 10 m tree casts a ~6 m shadow to the north
    assert vals[g.idx(-5, g.z0), g.idx(0, g.x0)] == shade.TREE
    assert vals[g.idx(-20, g.z0), g.idx(0, g.x0)] == shade.SUN


def test_night_is_dark():
    t = _box_twin()
    g = shade.Grid(80, 1.0)
    bld, top, bot, _ = shade.build_surfaces(t, g)
    assert (shade.shade_hour(g, bld, top, bot, az=0, el=-10) == shade.SHADOW).all()


def test_walkable_surface_and_metric():
    t = _box_twin(25)
    t["roads"] = [{"cls": "mid", "highway": "secondary", "width_m": 8.0, "bridge": False,
                   "pts": [[-60, 30], [60, 30]]}]
    stack, meta, walk2 = shade.compute(t, date(2026, 10, 9), 5.5, [9, 12, 15])
    assert stack.shape == (3, 80, 80)
    assert meta["walk_cells"] > 100
    assert walk2.shape == (80, 80) and walk2.sum() > 20
    assert all(p is not None for p in meta["walk_shade_pct"])


def test_build_query_mentions_buildings():
    assert 'way["building"]' in build_query(1, 2, 300)
    assert 'way["building"]' not in build_query(1, 2, 300, with_buildings=False)


# ---------- canopy map ----------
from streetscope import canopy


def test_quadkey_for_aiims_matches_the_real_tile():
    assert canopy.quadkey(28.5672, 77.2100) == "123121303"


def _blob(n, cx, cz, h, r):
    a = np.zeros((n, n), dtype=np.uint8)
    jj, ii = np.mgrid[0:n, 0:n]
    a[(ii - cx) ** 2 + (jj - cz) ** 2 <= r * r] = h
    return a


def test_detects_two_separate_trees_and_ignores_shrubs():
    g = shade.Grid(40, 1.0)                      # 80 x 80
    a = _blob(g.n, 20, 20, 12, 4) + _blob(g.n, 60, 55, 9, 3) + _blob(g.n, 40, 10, 2, 3)  # 2 m shrub is ignored
    tops = canopy.detect_tops(a, np.zeros_like(a, dtype=bool), g)
    assert len(tops) == 2
    assert {round(t["height_m"]) for t in tops} == {12, 9}
    assert all(t["source"] == "canopy_map" for t in tops)


def test_canopy_over_buildings_is_ignored():
    g = shade.Grid(40, 1.0)
    a = _blob(g.n, 20, 20, 12, 4)
    blocked = np.zeros(a.shape, dtype=bool)
    blocked[10:30, 10:30] = True
    assert canopy.detect_tops(a, blocked, g) == []


def test_merge_keeps_osm_trees_and_skips_duplicates():
    osm_t = [{"x": 0.0, "z": 0.0, "height_m": 7, "crown_r": 2.6, "source": "osm"}]
    tops = [{"x": 1.0, "z": 0.5, "height_m": 8, "crown_r": 2.4, "source": "canopy_map"},
            {"x": 20.0, "z": 0.0, "height_m": 9, "crown_r": 2.7, "source": "canopy_map"}]
    out = canopy.merge_trees(osm_t, tops)
    assert len(out) == 2 and out[0]["source"] == "osm" and out[1]["x"] == 20.0


def test_to_grid_puts_a_mercator_pixel_at_the_right_place():
    lat, lon = 28.5672, 77.21
    cx, cy = canopy.lonlat_to_mercator(lat, lon)
    res = 1.2
    data = np.zeros((200, 200), dtype=np.uint8)
    # a 15 m canopy pixel exactly 30 ground metres east of the centre
    k = 1 / math.cos(math.radians(lat))
    x0, y0 = cx - 100 * res, cy + 100 * res
    col = int((cx + 30 * k - x0) / res)
    data[100, col] = 15
    grid = canopy.to_grid({"data": data, "x0": x0, "y0": y0, "res": res}, lat, lon, 50, 1.0)
    jj, ii = np.nonzero(grid == 15)
    assert len(ii) >= 1
    xs = -50 + (ii + 0.5)
    assert abs(float(xs.mean()) - 30) < 2.0 and abs(float((-50 + (jj + 0.5)).mean())) < 2.0


def test_apply_updates_stats_and_gaps():
    ring = [[-30, -30], [-20, -30], [-20, -20], [-30, -20]]
    t = {"meta": {"center": {"lat": 28.5672, "lon": 77.21}, "radius_m": 40, "attribution": "OSM"},
         "buildings": [{"footprint": ring, "height_m": 10}], "trees": [], "roads": [],
         "stats": {"trees": 0, "gaps": ["OpenStreetMap maps only 0 trees here."]}}
    g = shade.Grid(40, 1.0)
    info = canopy.apply(t, _blob(g.n, 55, 55, 10, 4))
    assert info["tree_tops_found"] == 1 and t["stats"]["trees"] == 1
    assert not any("OpenStreetMap maps only" in x for x in t["stats"]["gaps"])
    assert "Meta" in t["meta"]["attribution"]
