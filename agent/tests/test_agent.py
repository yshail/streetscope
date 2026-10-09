from pathlib import Path

import pytest

from streetscope_agent import agent as A
from streetscope_agent import tools as T
from streetscope_agent.verify import numbers_in, unverified_numbers

SITE_DIR = Path(__file__).resolve().parents[2] / "web" / "data" / "aiims"


@pytest.fixture(scope="module")
def site():
    return T.Site(SITE_DIR)


def test_numbers_in():
    assert numbers_in("about 12.5 m and 1,200 rupees") == [12.5, 1200.0]


def test_verifier_catches_invented_number():
    out = {"walkway_in_shade_pct": 0.3}
    assert unverified_numbers("Shade is 0.3 percent", [out]) == []
    assert unverified_numbers("Shade is 45 percent", [out]) == [45.0]


def test_verifier_allows_numbers_from_question_and_counting_words():
    assert unverified_numbers("At 15 the shade is low, across 2 spots", [{}], "what about 15:00") == []


def test_site_summary_is_honest_about_gaps(site):
    s = T.site_summary(site)
    assert s["road_ways"] > 50 and s["buildings"] > 20
    assert any("height" in g for g in s["known_gaps"])


def test_measure_road_reports_width_source(site):
    r = T.measure_road(site, "marg")
    assert r["found"] and r["matches"][0]["width_source"] in ("osm_width", "lanes", "default")
    assert T.measure_road(site, "zzzz-not-a-road")["found"] is False


def test_shade_tools_agree(site):
    p = T.shade_profile(site)
    mid = T.shade_at(site, 12)
    assert str(12) in p["by_hour"] and p["by_hour"]["12"] == mid["walkway_in_shade_pct"]


def test_hotspots_are_on_the_walkway_and_far_apart(site):
    spots = T.sun_hotspots(site, top=3)["spots"]
    assert 1 <= len(spots) <= 3
    for a in spots:
        assert a["sun_hours"] > 0
    for i, a in enumerate(spots):
        for b in spots[i + 1:]:
            assert ((a["x"] - b["x"]) ** 2 + (a["z"] - b["z"]) ** 2) ** 0.5 >= 24


def test_planting_trees_never_reduces_shade(site):
    w = T.what_if_trees(site, 5)
    assert w["trees_added"] >= 1
    for row in w["walkway_shade"]:
        if row["before_pct"] is not None:
            assert row["after_pct"] >= row["before_pct"]
    assert "ASSUMED" in w["cost"]["basis"]


def test_offline_answer_is_verified_and_labelled(site):
    out = A.offline_answer(site, "Where should we plant first?")
    assert out["answer"].startswith("[offline mode")
    assert out["verified"], out["unverified_numbers"]
    assert {t["tool"] for t in out["tools_called"]} >= {"sun_hotspots", "what_if_trees"}


def test_tool_results_are_json_safe(site):
    import json

    json.dumps(T.sun_hotspots(site, 3))
    json.dumps(T.what_if_trees(site, 4))


def test_handler_rejects_bad_site_names():
    from streetscope_agent.handler import lambda_handler

    r = lambda_handler({"body": '{"site":"../etc","question":"hi"}'})
    assert r["statusCode"] == 400


def test_handler_offline_roundtrip(monkeypatch):
    from streetscope_agent import handler

    monkeypatch.setenv("TWIN_DIR", str(SITE_DIR.parent))
    monkeypatch.setenv("USE_LLM", "0")
    r = handler.lambda_handler({"body": '{"site":"aiims","question":"how many trees?"}'})
    assert r["statusCode"] == 200 and '"answer"' in r["body"]


def test_offline_routes_shade_and_tree_count(site):
    a = A.offline_answer(site, "how shaded is the walkway at noon?")
    assert {t["tool"] for t in a["tools_called"]} == {"shade_at"} and a["verified"]
    b = A.offline_answer(site, "what about 3 pm?")
    assert "15:00" in b["answer"] and b["verified"]
    c = A.offline_answer(site, "how many trees are there?")
    assert {t["tool"] for t in c["tools_called"]} == {"count_trees"} and c["verified"]
