import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import builder  # noqa: E402
import context_proxy  # noqa: E402


def test_slugify_is_safe_and_unique(tmp_path, monkeypatch):
    monkeypatch.setattr(builder, "DATA", tmp_path)
    assert builder.slugify("MG Road, Bengaluru!") == "mg_road_bengaluru"
    (tmp_path / "mg_road").mkdir()
    assert builder.slugify("MG Road") == "mg_road_2"
    assert builder.slugify("../../etc") == "etc"


def test_register_adds_the_site_once(tmp_path, monkeypatch):
    monkeypatch.setattr(builder, "DATA", tmp_path)
    (tmp_path / "index.json").write_text(json.dumps({"sites": [{"id": "a", "name": "A", "twin": "a/twin.json"}]}), encoding="utf-8")
    (tmp_path / "b").mkdir()
    (tmp_path / "b" / "twin.json").write_text(json.dumps({"meta": {"data_level": 3}}), encoding="utf-8")
    job = {"site": "b", "name": "Place B"}
    builder._register(job)
    builder._register(job)
    sites = json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))["sites"]
    assert [s["id"] for s in sites] == ["a", "b"] and sites[1]["name"] == "Place B (level 3)"


def test_start_rejects_bad_coordinates():
    try:
        builder.start(120, 0, 300, "x", 0)
    except ValueError:
        return
    raise AssertionError("expected a ValueError")


def test_context_query_matches_the_browser():
    q = context_proxy.query(12.9756, 77.6066, 900)
    ts = (ROOT / "app" / "src" / "lib" / "context.ts").read_text(encoding="utf-8")
    for line in ('way["building"]', 'way["highway"]', 'node["amenity"]', 'node["highway"="bus_stop"]', 'way["railway"~"^(rail|subway|light_rail|tram|monorail)$"]'):
        assert line in q and line in ts
    assert "(around:900,12.9756,77.6066)" in q
