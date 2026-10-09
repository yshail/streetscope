"""The doctor. Claude Sonnet 5.5 by default (claude_agent.py); a Strands + Bedrock path is kept as LLM_BACKEND=strands.
Either way it can call the tools in tools.py and nothing else, and an offline template answers when no model is reachable."""

from __future__ import annotations

import os
import re
from typing import Any

from . import claude_agent as CA
from . import tools as T
from .verify import unverified_numbers

SYSTEM_PROMPT = """You are the Streetscope doctor. You help a city engineer understand one street junction.
Rules you must follow:
1. You can only learn facts by calling tools. Never use outside knowledge about the place.
2. Every number you write must be copied from a tool result. If a tool did not give a number, say you do not know it.
3. If a tool says a value is a default, assumed, estimated or under-counted, say so in plain words.
4. Keep answers under 120 words. Plain language. No jargon without a short explanation.
5. When you suggest a change, call list_scenarios or what_if_trees first so the numbers come from the shade maths.
6. Never claim a result is a real measurement unless the tool says it is measured."""

DEFAULT_MODEL = os.environ.get("BEDROCK_MODEL_ID", "us.amazon.nova-2-lite-v1:0")  # check the exact id in the Bedrock console


def make_tool_functions(site: T.Site, trace: list[dict]):
    """Plain functions with docstrings, each one recording what it returned so answers can be checked."""

    def record(name: str, args: dict, result: Any) -> Any:
        trace.append({"tool": name, "args": args, "result": result})
        return result

    def site_summary() -> dict:
        """Counts of roads, buildings, trees and bus stops for this site, plus known data gaps."""
        return record("site_summary", {}, T.site_summary(site))

    def measure_road(name: str) -> dict:
        """Width, lanes and length of a named road. Says whether the width is measured or a default.

        Args:
            name: Part of the road name, for example "Aurobindo".
        """
        return record("measure_road", {"name": name}, T.measure_road(site, name))

    def count_trees() -> dict:
        """Number of trees mapped and their canopy area. Warns when the source under-counts."""
        return record("count_trees", {}, T.count_trees(site))

    def shade_at(hour: int) -> dict:
        """Share of the walkway in shade at an hour of the day, with the sun angle.

        Args:
            hour: Local hour from 6 to 18.
        """
        return record("shade_at", {"hour": hour}, T.shade_at(site, hour))

    def shade_profile() -> dict:
        """Walkway shade for every daytime hour, with the best and worst hour."""
        return record("shade_profile", {}, T.shade_profile(site))

    def list_scenarios() -> dict:
        """The precomputed fixes (street trees, wider footpaths, both) with walkway shade before and after and an assumed cost."""
        return record("list_scenarios", {}, T.list_scenarios(site))

    def sun_hotspots(top: int = 3) -> dict:
        """The sunniest stretches of walkway, with coordinates and how many daytime hours they are lit.

        Args:
            top: How many spots to return.
        """
        return record("sun_hotspots", {"top": top}, T.sun_hotspots(site, top))

    def what_if_trees(n: int = 6) -> dict:
        """Plant n trees at the sunniest spots and recompute walkway shade before and after, with an assumed cost.

        Args:
            n: Number of trees, 1 to 40.
        """
        return record("what_if_trees", {"n": n}, T.what_if_trees(site, n))

    def traffic_areas(top: int = 5) -> dict:
        """Junctions with the worst simulated peak-hour traffic, ranked by score. Screening model with assumed demand.

        Args:
            top: How many areas, 1 to 10.
        """
        return record("traffic_areas", {"top": top}, T.traffic_areas(site, top))

    def propose_solutions(area_id: int | None = None) -> dict:
        """Candidate traffic fixes for one area, each re-simulated, with load before and after and an assumed cost.

        Args:
            area_id: Area id from traffic_areas. Leave out for the worst area.
        """
        return record("propose_solutions", {"area_id": area_id}, T.propose_solutions(site, area_id))

    return [site_summary, measure_road, count_trees, shade_at, shade_profile, list_scenarios, sun_hotspots, what_if_trees,
            traffic_areas, propose_solutions]


def build_agent(site: T.Site, trace: list[dict], model_id: str | None = None, region: str | None = None):
    from strands import Agent, tool
    from strands.models import BedrockModel

    model = BedrockModel(model_id=model_id or DEFAULT_MODEL, region_name=region or os.environ.get("AWS_REGION", "us-east-1"),
                         temperature=0.1)
    fns = [tool(f) for f in make_tool_functions(site, trace)]
    return Agent(model=model, system_prompt=SYSTEM_PROMPT, tools=fns)


def map_points(trace: list[dict]) -> list[dict]:
    """Places on the map that the tools mentioned, so a 3D view can fly there."""
    pts: list[dict] = []
    for t in trace:
        res = t["result"]
        if t["tool"] == "sun_hotspots":
            for i, sp in enumerate(res.get("spots", []), 1):
                pts.append({"lat": sp["lat"], "lon": sp["lon"], "label": f"Sunny spot {i}: lit {sp['sun_hours']} of {sp['of_hours']} daytime hours"})
        elif t["tool"] == "traffic_areas" and res.get("available"):
            for a in res["areas"]:
                pts.append({"lat": a["lat"], "lon": a["lon"], "kind": "traffic",
                            "label": f"Traffic area {a['id']}: score {a['score']}, {a['severity']} (simulated)"})
        elif t["tool"] == "what_if_trees" and not pts:
            for i, sp in enumerate(res.get("spots", [])[:6], 1):
                pts.append({"lat": sp["lat"], "lon": sp["lon"], "label": f"Plant here {i}"})
    return pts


def ask(site: T.Site, question: str, model_id: str | None = None, region: str | None = None, brief: bool = False) -> dict:
    """Run the model and check every number in its answer against what the tools returned."""
    trace: list[dict] = []
    if os.environ.get("LLM_BACKEND") == "strands":
        agent = build_agent(site, trace, model_id, region)
        q = CA.BRIEF_PROMPT if brief else question
        answer = str(agent(q))
        bad = unverified_numbers(answer, [t["result"] for t in trace], q)
        out = {"answer": answer, "unverified_numbers": bad, "verified": not bad,
               "llm": {"provider": "Amazon Bedrock (Strands)", "model": model_id or DEFAULT_MODEL}}
    else:
        out = CA.run(site, CA.BRIEF_PROMPT if brief else question, trace)
    out["tools_called"] = [{"tool": t["tool"], "args": t["args"]} for t in trace]
    out["map_points"] = map_points(trace)
    return out


# ---------- offline mode: no language model, same tools, plain templates ----------

def _hour_in(q: str) -> int | None:
    if "noon" in q:
        return 12
    m = re.search(r"(\d{1,2})(?::00)?\s*(am|pm)", q)
    if m:
        h = int(m.group(1)) % 12
        return h + (12 if m.group(2) == "pm" else 0)
    m = re.search(r"(\d{1,2}):00", q)
    return int(m.group(1)) if m else None


def offline_answer(site: T.Site, question: str) -> dict:
    """Used when Bedrock is not available. Deterministic, clearly labelled, never invents numbers."""
    q = question.lower()
    trace: list[dict] = []
    fns = {f.__name__: f for f in make_tool_functions(site, trace)}
    parts = []
    hour = _hour_in(q)
    if re.search(r"traffic|congest|jam|queue|junction|signal|bus lane|overbridge|vehicle|\bcars?\b", q):
        parts.append(_traffic_text(fns))
    elif re.search(r"plant|tree|where|first|hotspot", q) and not re.search(r"how many", q):
        h = fns["sun_hotspots"](3)["spots"]
        w = fns["what_if_trees"](12)
        rows = ", ".join(f"{r['hour']}:00 {r['before_pct']}% to {r['after_pct']}%" for r in w["walkway_shade"])
        parts.append(f"Start at the {len(h)} sunniest walkway spots, then add {w['trees_added']} trees in total. Walkway shade would go: {rows}. "
                     f"Assumption: each tree is 8 m tall with a 3 m crown. Cost is an assumed {w['cost']['cost_inr']} rupees.")
    elif hour is not None or re.search(r"shade|shaded|sun|walk", q):
        r = fns["shade_at"](12 if hour is None else hour)
        parts.append(f"At {r['hour']}:00 on {r['date']}, {r['walkway_in_shade_pct']}% of the walkway is in shade. "
                     f"The sun is {r['sun_elevation_deg']} degrees above the horizon.")
    elif re.search(r"how many.*tree|tree.*count|count.*tree", q):
        c = fns["count_trees"]()
        parts.append(f"{c['trees']} trees: {c['from_canopy_map']} from the canopy map and {c['from_openstreetmap']} from OpenStreetMap. {c['note']}")
    elif re.search(r"road|width|lane", q):
        words = [w for w in re.findall(r"[a-z]{4,}", q) if w not in ("road", "width", "lane", "lanes", "wide", "what", "much")]
        r = fns["measure_road"](words[-1] if words else "")
        parts.append(f"I could not find a road matching that name." if not r["found"] else
                     "; ".join(f"{m['name']}: {m['width_m']} m wide ({m['width_source']}), {m['length_m']} m long" for m in r["matches"]))
    else:
        s = fns["site_summary"]()
        parts.append(f"{s['name']}: {s['road_ways']} road ways, {s['buildings']} buildings, {s['trees_mapped']} trees mapped. "
                     + " ".join(s["known_gaps"]))
    return _offline_result(" ".join(parts), trace, question)


def _traffic_text(fns: dict) -> str:
    a = fns["traffic_areas"](3)
    if not a["available"]:
        return a["note"]
    top = a["areas"][0]
    roads = " and ".join(top["roads"][:2]) or "an unnamed junction"
    txt = (f"Simulated screening, assumed demand, no traffic counts. The worst area is near {roads}: score {top['score']}, "
           f"peak load {top['load_ratio']} times the assumed capacity.")
    p = fns["propose_solutions"](top["id"])
    if p["available"] and p["solutions"]:
        s = p["solutions"][0]
        txt += (f" Best tested fix: {s['title'].lower()}. Area load goes from {s['area_load_before']} to {s['area_load_after']} "
                f"({s['area_load_change_pct']}%), network delay changes {s['network_delay_change_pct']}%. "
                f"{s['assumption']}. Cost is an assumed {s['cost_lakh']} lakh rupees.")
    return txt


def offline_brief(site: T.Site) -> dict:
    """The engineer's brief without a language model: same tools, fixed template."""
    trace: list[dict] = []
    fns = {f.__name__: f for f in make_tool_functions(site, trace)}
    s = fns["site_summary"]()
    prof = fns["shade_profile"]()
    sc = {x["id"]: x for x in fns["list_scenarios"]()["scenarios"]}
    lines = ["Where it hurts"]
    if prof.get("least_shaded_hour") is not None:
        lines.append(f"- Walkway shade drops to {prof['least_shaded_pct']}% at {prof['least_shaded_hour']}:00.")
    lines.append("- " + _traffic_text(fns))
    lines.append("What we would try")
    if "trees" in sc:
        t = sc["trees"]
        lines.append(f"- Plant {t['trees_added']} street trees: day-mean walkway shade {t['day_mean_shade_pct_before']}% to "
                     f"{t['day_mean_shade_pct_after']}%, assumed cost {t['cost_inr']} rupees.")
    lines.append("- Study the traffic fix above with real counts before any design.")
    lines.append("How sure we are")
    lines += ["- " + g for g in s["known_gaps"]]
    lines.append("- Traffic numbers are simulated with assumed demand and capacity. Costs are assumed unit rates, not quotes.")
    return _offline_result("\n".join(lines), trace, "")


def _offline_result(text: str, trace: list[dict], question: str) -> dict:
    answer = "[offline mode, no language model] " + text
    bad = unverified_numbers(answer, [t["result"] for t in trace], question)
    return {"answer": answer, "tools_called": [{"tool": t["tool"], "args": t["args"]} for t in trace],
            "unverified_numbers": bad, "verified": not bad, "map_points": map_points(trace)}
