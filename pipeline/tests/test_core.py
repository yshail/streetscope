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
