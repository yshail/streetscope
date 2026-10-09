import math

import numpy as np

from streetscope import traffic


def _grid_twin():
    """A 4x4 street grid with a four-lane spine across the middle, so load concentrates on it."""
    roads = []
    for i in range(-90, 91, 60):
        roads.append({"cls": "local", "highway": "residential", "name": f"S{i}", "lanes": None, "width_m": 6.0, "width_source": "default",
                      "oneway": False, "bridge": False, "pts": [[-90, i], [-30, i], [30, i], [90, i]]})
        roads.append({"cls": "local", "highway": "residential", "name": f"A{i}", "lanes": None, "width_m": 6.0, "width_source": "default",
                      "oneway": False, "bridge": False, "pts": [[i, -90], [i, -30], [i, 30], [i, 90]]})
    roads.append({"cls": "main", "highway": "primary", "name": "Spine", "lanes": 4, "width_m": 14.0, "width_source": "lanes",
                  "oneway": False, "bridge": False, "pts": [[-90, 0], [-30, 0], [30, 0], [90, 0]]})
    blds = [{"footprint": [[x - 8, z - 8], [x + 8, z - 8], [x + 8, z + 8], [x - 8, z + 8]], "height_m": 20, "height_source": "default"}
            for x in (-60, 0, 60) for z in (-60, 0, 60) if (x, z) != (0, 0)]
    return {"meta": {"center": {"lat": 28.5672, "lon": 77.21}, "radius_m": 100, "signals_queried": True}, "roads": roads,
            "buildings": blds, "crossings": [{"x": 31, "z": 1}, {"x": 29, "z": -1}], "stops": [{"x": 0, "z": 4}], "signals": [], "trees": []}


def test_graph_splits_roads_at_junctions():
    nodes, links, arcs, adj = traffic.build_graph(_grid_twin())
    assert len(links) > 20 and len(nodes) >= 16
    assert all(l.length > 0.5 for l in links)
    assert len(arcs) == 2 * len(links)             # every road here is two-way


def test_lane_defaults():
    r = {"cls": "main", "lanes": 4, "oneway": False, "width_source": "lanes", "width_m": 13}
    assert traffic._lanes_dir(r) == 2
    r = {"cls": "main", "lanes": None, "oneway": False, "width_source": "default", "width_m": 12}
    assert traffic._lanes_dir(r) == traffic.DEFAULT_LANES_DIR["main"]


def test_demand_is_scaled_so_busy_links_sit_near_capacity():
    M = traffic.make_model(_grid_twin())
    live = M.base["link_ratio"][M.base["link_ratio"] > 0]
    assert 0.5 < float(np.percentile(live, 95)) < 1.6
    assert len(M.ods) > 1000


def test_traffic_is_deterministic():
    a = traffic.analyse(_grid_twin())
    b = traffic.analyse(_grid_twin())
    assert a["areas"] == b["areas"] and a["summary"] == b["summary"]


def test_areas_are_ranked_and_spread_out():
    areas = traffic.analyse(_grid_twin())["areas"]
    assert areas and all(areas[i]["score"] >= areas[i + 1]["score"] for i in range(len(areas) - 1))
    for i, a in enumerate(areas):
        assert a["severity"] in ("low", "medium", "high")
        for b in areas[i + 1:]:
            assert math.hypot(a["x"] - b["x"], a["z"] - b["z"]) > 30


def test_signal_retiming_never_raises_area_load_and_assumptions_are_labelled():
    r = traffic.analyse(_grid_twin())
    for s in r["solutions"]:
        if s["kind"] == "signal_retiming":
            assert s["area_load_after"] <= s["area_load_before"] + 1e-6
        assert "ASSUMED" in s["assumption"] and "ASSUMED" in s["cost_basis"]


def test_block_labels_itself_a_screening_model():
    r = traffic.analyse(_grid_twin())
    assert "simulated" in r["method"]["kind"] and "No traffic counts" in r["method"]["limits"]
    assert all(k["pts"] for k in r["links"])


def test_a_too_thin_network_gives_none():
    t = _grid_twin()
    t["roads"] = t["roads"][:1]
    assert traffic.analyse(t) is None


def test_signal_wording_only_when_signals_were_queried():
    t = _grid_twin()
    t["meta"]["signals_queried"] = False
    r = traffic.analyse(t)
    assert not any("signal" in x for a in r["areas"] for x in a["reasons"])
