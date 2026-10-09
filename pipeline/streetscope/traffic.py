"""Traffic screening on the road network: where is load highest, which junctions are under pressure, and which fixes help.

This is a screening model, not a traffic study. There are no traffic counts, so demand is *assumed*: trips are generated
from building floor area plus through traffic at the site edge, routed on the OpenStreetMap network with congestion-aware
(BPR) routing, and scaled so the busiest links sit near capacity in a peak hour. Every figure that comes out is
simulated and relative. The value is in *where* load concentrates and *how much* each fix moves it, not in vehicle counts.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field

import numpy as np

from .geo import Frame
from .twin import METRES_PER_LEVEL

PER_LANE_VEH_H = {"main": 1500.0, "mid": 1250.0, "local": 900.0}   # ASSUMED saturation flow per lane after friction
SPEED_KMH = {"main": 50.0, "mid": 40.0, "local": 28.0}             # ASSUMED free-flow speeds by class
DEFAULT_LANES_DIR = {"main": 2, "mid": 1, "local": 1}
PEAK_RATIO = 0.9              # ASSUMED: demand is scaled so the 95th percentile link sits at 90% of capacity
BPR_A, BPR_B = 0.15, 4.0      # standard BPR delay curve
N_OD = 3200
STAGES = 4
SEED = 42
DRIVE = ("main", "mid", "local")
MIN_JOB_M = 100.0   # per-km items are priced on at least this much road
UNIT_COST_NOTE = ("ASSUMED unit rates in rupees, not quotes: bus lane 8 lakh per km, signal retiming 6 lakh, "
                  "new signal 15 lakh, foot overbridge 3.2 crore, extra lane 1.5 crore per km, route signage 2 lakh; per-km items are priced on at least 100 m")


@dataclass
class Link:
    id: int
    a: int
    b: int
    geom: list
    length: float
    cls: str
    name: str | None
    highway: str
    lanes_dir: int
    cap: float
    t0: float
    oneway: bool
    bridge: bool = False


@dataclass
class Model:
    nodes: list                      # [(x, z)]
    links: list                      # [Link]
    arcs: list                       # [(from, to, link_id, reverse)]
    adj: list                        # per node: [arc ids]
    ods: list                        # [(origin node, dest node)]
    scale: float = 1.0
    base: dict = field(default_factory=dict)


def _lanes_dir(road: dict) -> int:
    lanes = road.get("lanes")
    one = bool(road.get("oneway"))
    if lanes:
        return max(1, int(round(lanes if one else lanes / 2.0)))
    if road["width_source"] != "default":
        return max(1, int(round(road["width_m"] / 3.25 / (1 if one else 2))))
    return DEFAULT_LANES_DIR[road["cls"]]


def build_graph(twin: dict) -> tuple[list, list, list, list]:
    """Split every driving road at junctions (points shared with another road, or road ends) into links."""
    roads = [r for r in twin["roads"] if r["cls"] in DRIVE and len(r["pts"]) > 1]
    key = lambda p: (round(p[0], 1), round(p[1], 1))
    touch: dict = {}
    for ri, r in enumerate(roads):
        for p in r["pts"]:
            touch.setdefault(key(p), set()).add(ri)
    node_idx: dict = {}
    nodes: list = []

    def nid(p) -> int:
        k = key(p)
        if k not in node_idx:
            node_idx[k] = len(nodes)
            nodes.append(k)
        return node_idx[k]

    links: list[Link] = []
    for ri, r in enumerate(roads):
        pts = [tuple(p) for p in r["pts"]]
        start = 0
        for i in range(1, len(pts)):
            end_of_road = i == len(pts) - 1
            junction = len(touch[key(pts[i])]) > 1
            if end_of_road or junction:
                seg = pts[start:i + 1]
                length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(seg, seg[1:]))
                if length > 0.5 and key(seg[0]) != key(seg[-1]):
                    lanes = _lanes_dir(r)
                    cap = lanes * PER_LANE_VEH_H[r["cls"]]
                    speed = SPEED_KMH[r["cls"]] * (1.2 if r.get("bridge") else 1.0)
                    links.append(Link(len(links), nid(seg[0]), nid(seg[-1]), seg, length, r["cls"], r.get("name"), r["highway"],
                                      lanes, cap, length / (speed / 3.6), bool(r.get("oneway")), bool(r.get("bridge"))))
                start = i
    arcs: list = []
    adj: list = [[] for _ in nodes]
    for l in links:
        arcs.append((l.a, l.b, l.id, False))
        adj[l.a].append(len(arcs) - 1)
        if not l.oneway:
            arcs.append((l.b, l.a, l.id, True))
            adj[l.b].append(len(arcs) - 1)
    return nodes, links, arcs, adj


def _centroid(ring) -> tuple[float, float]:
    a = cx = cz = 0.0
    for (x1, z1), (x2, z2) in zip(ring, ring[1:] + ring[:1]):
        c = x1 * z2 - x2 * z1
        a += c
        cx += (x1 + x2) * c
        cz += (z1 + z2) * c
    if abs(a) < 1e-9:
        return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
    return (cx / (3 * a), cz / (3 * a))


def make_model(twin: dict, seed: int = SEED) -> Model:
    nodes, links, arcs, adj = build_graph(twin)
    if len(nodes) < 4 or not links:
        raise ValueError("not enough driving roads for a traffic model")
    xy = np.array(nodes)
    R = twin["meta"]["radius_m"]
    weight = np.zeros(len(nodes))
    for b in twin["buildings"]:
        cx, cz = _centroid(b["footprint"])
        area = abs(sum(x1 * z2 - x2 * z1 for (x1, z1), (x2, z2) in zip(b["footprint"], b["footprint"][1:] + b["footprint"][:1]))) / 2
        floors = max(1.0, b["height_m"] / METRES_PER_LEVEL)
        deg_ok = np.array([len(adj[i]) > 0 for i in range(len(nodes))])
        d = np.hypot(xy[:, 0] - cx, xy[:, 1] - cz)
        d[~deg_ok] = 1e9
        weight[int(d.argmin())] += area * floors
    total_b = max(weight.sum(), 1.0)
    edge_nodes = [i for i in range(len(nodes)) if adj[i] and math.hypot(*nodes[i]) > 0.85 * R]
    if edge_nodes:
        cap_at = np.array([sum(links[arcs[a][2]].cap for a in adj[i]) for i in edge_nodes])
        weight[edge_nodes] += 0.35 * total_b * cap_at / cap_at.sum()   # through traffic: about a third of all trips
    rng = np.random.default_rng(seed)
    p_o = weight / weight.sum()
    origins = rng.choice(len(nodes), size=N_OD, p=p_o)
    ods = []
    for o in origins:
        d = np.hypot(xy[:, 0] - xy[o, 0], xy[:, 1] - xy[o, 1])
        w = weight * np.exp(-d / 600.0)
        w[o] = 0
        if w.sum() <= 0:
            continue
        ods.append((int(o), int(rng.choice(len(nodes), p=w / w.sum()))))
    M = Model(nodes, links, arcs, adj, ods)
    base = assign(M, scale=None)
    M.scale = base["scale"]
    M.base = assign(M)
    return M


def _dijkstra(M: Model, src: int, cost: np.ndarray, banned: set | None = None):
    n = len(M.nodes)
    dist = [math.inf] * n
    prev = [-1] * n
    dist[src] = 0.0
    heap = [(0.0, src)]
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist[u]:
            continue
        for a in M.adj[u]:
            if banned and a in banned:
                continue
            v = M.arcs[a][1]
            nd = d + cost[a]
            if nd < dist[v]:
                dist[v] = nd
                prev[v] = a
                heapq.heappush(heap, (nd, v))
    return dist, prev


def _path(M: Model, prev: list, dst: int) -> list:
    out = []
    v = dst
    while prev[v] >= 0:
        a = prev[v]
        out.append(a)
        v = M.arcs[a][0]
    out.reverse()
    return out


def assign(M: Model, scale="model", cap_factor: dict | None = None, drop: dict | None = None,
           divert: dict | None = None) -> dict:
    """Incremental BPR assignment. scale=None means: route on free-flow times and derive the demand scale."""
    if isinstance(scale, str):
        scale = M.scale
    cap_factor, drop, divert = cap_factor or {}, drop or {}, divert or {}
    n_arc = len(M.arcs)
    cap = np.array([M.links[a[2]].cap * cap_factor.get(a[2], 1.0) for a in M.arcs])
    t0 = np.array([M.links[a[2]].t0 for a in M.arcs])
    active = np.ones(len(M.ods), dtype=bool)
    if drop and M.base:
        for lid, frac in drop.items():
            using = [i for i, p in enumerate(M.base["paths"]) if any(M.arcs[a][2] == lid for a in p) and active[i]]
            for i in using[: int(round(frac * len(using)))]:
                active[i] = False
    banned_for: dict = {}
    if divert and M.base:
        for lid, frac in divert.items():
            using = [i for i, p in enumerate(M.base["paths"]) if any(M.arcs[a][2] == lid for a in p) and active[i]]
            for i in using[: int(round(frac * len(using)))]:
                banned_for[i] = {a for a, arc in enumerate(M.arcs) if arc[2] == lid}
    flow = np.zeros(n_arc)
    paths: list = [[] for _ in M.ods]
    use_scale = 1.0 if scale is None else scale
    for s in range(STAGES):
        cost = t0 * (1 + BPR_A * (np.where(cap > 0, use_scale * flow / np.maximum(cap, 1e-9), 0.0)) ** BPR_B) if scale is not None else t0.copy()
        by_origin: dict = {}
        for i, (o, d) in enumerate(M.ods):
            if i % STAGES == s and active[i]:
                by_origin.setdefault(o, []).append(i)
        for o, idxs in by_origin.items():
            dist, prev = _dijkstra(M, o, cost)
            for i in idxs:
                d = M.ods[i][1]
                if i in banned_for:
                    dist2, prev2 = _dijkstra(M, o, cost, banned_for[i])
                    if math.isfinite(dist2[d]) and dist2[d] <= 1.6 * max(dist[d], 1e-9):
                        p = _path(M, prev2, d)
                    else:
                        p = _path(M, prev, d) if math.isfinite(dist[d]) else []
                else:
                    p = _path(M, prev, d) if math.isfinite(dist[d]) else []
                paths[i] = p
                for a in p:
                    flow[a] += 1.0
    if scale is None:
        ratios = flow / np.maximum(cap, 1e-9)
        live = ratios[flow > 0]
        p95 = float(np.percentile(live, 95)) if len(live) else 1.0
        return {"scale": PEAK_RATIO / max(p95, 1e-9)}
    v = scale * flow
    ratio = np.where(cap > 0, v / np.maximum(cap, 1e-9), 0.0)
    t = t0 * (1 + BPR_A * ratio ** BPR_B)
    link_ratio = np.zeros(len(M.links))
    link_flow = np.zeros(len(M.links))
    for a, arc in enumerate(M.arcs):
        link_ratio[arc[2]] = max(link_ratio[arc[2]], ratio[a])
        link_flow[arc[2]] = max(link_flow[arc[2]], v[a])
    return {"paths": paths, "ratio": ratio, "link_ratio": link_ratio, "link_flow": link_flow, "delay": float(np.sum(v * (t - t0)) / 3600.0),
            "scale": scale, "active": int(active.sum())}


# ------------------------------------------------------------------ junction areas and solutions

def _near(points: list, x: float, z: float, r: float) -> int:
    return sum(1 for p in points if math.hypot(p["x"] - x, p["z"] - z) <= r)


def analyse_areas(M: Model, twin: dict, top: int = 6) -> list[dict]:
    """Rank junctions by load and conflict. Dual carriageways give several close nodes, so keep the strongest per 30 m."""
    frame = Frame(twin["meta"]["center"]["lat"], twin["meta"]["center"]["lon"])
    inc: dict = {}
    for l in M.links:
        inc.setdefault(l.a, []).append(l.id)
        inc.setdefault(l.b, []).append(l.id)
    cand = []
    for n, lids in inc.items():
        if len(set(lids)) < 3:
            continue
        x, z = M.nodes[n]
        lids = sorted(set(lids))
        load = max(float(M.base["link_ratio"][i]) for i in lids)
        cross = _near(twin.get("crossings", []), x, z, 25)
        stops = _near(twin.get("stops", []), x, z, 40)
        sigs = _near(twin.get("signals", []), x, z, 30)
        conflict = len(lids) + cross + 0.5 * stops
        score = 0.6 * min(1.0, load / 1.2) * 100 + 0.4 * min(100.0, conflict * 12)
        cand.append((score, n, x, z, lids, load, cross, stops, sigs))
    cand.sort(reverse=True)
    picked: list = []
    for c in cand:
        if all(math.hypot(c[2] - p[2], c[3] - p[3]) > 30 for p in picked):
            picked.append(c)
        if len(picked) >= top:
            break
    areas = []
    for i, (score, n, x, z, lids, load, cross, stops, sigs) in enumerate(picked, 1):
        lat, lon = frame.to_latlon(x, z)
        names = sorted({M.links[l].name for l in lids if M.links[l].name})
        reasons = []
        if load >= 0.7:
            reasons.append(f"a link into it carries {load:.2f} times its assumed capacity in the peak hour")
        reasons.append(f"{len(lids)} road links meet here")
        if cross:
            reasons.append(f"{cross} pedestrian crossing{'s' if cross > 1 else ''} within 25 m")
        if stops:
            reasons.append(f"{stops} bus stop{'s' if stops > 1 else ''} within 40 m")
        if twin["meta"].get("signals_queried"):
            reasons.append("traffic signals mapped nearby" if sigs else "no traffic signal mapped nearby")
        areas.append({"id": i, "x": round(x, 1), "z": round(z, 1), "lat": round(lat, 6), "lon": round(lon, 6),
                      "score": round(score, 1), "load_ratio": round(load, 2), "links": lids, "roads": names[:4],
                      "crossings": cross, "bus_stops": stops, "signals": sigs, "reasons": reasons,
                      "severity": "high" if score >= 65 else ("medium" if score >= 40 else "low")})
    return areas


def _delay_change(M: Model, res: dict) -> float:
    b = M.base["delay"]
    return round(100.0 * (res["delay"] - b) / b, 1) if b > 1e-9 else 0.0


def propose(M: Model, twin: dict, areas: list[dict]) -> list[dict]:
    """For each area, apply the fixes that fit it, re-run the assignment and report what moved."""
    sols: list = []
    for a in areas:
        lids = a["links"]
        links = [M.links[i] for i in lids]
        heavy = max(links, key=lambda l: M.base["link_ratio"][l.id])
        area_base = max(M.base["link_ratio"][i] for i in lids)
        cands = []
        main_like = [l for l in links if l.cls in ("main", "mid")]
        if a["bus_stops"] and any(l.lanes_dir >= 2 for l in main_like):
            l = max((l for l in main_like if l.lanes_dir >= 2), key=lambda l: M.base["link_ratio"][l.id])
            cands.append(("bus_lane", "Dedicated bus lane", f"Take one of {l.lanes_dir} lanes on {l.name or 'the main road'} for buses",
                          {"cap_factor": {l.id: (l.lanes_dir - 1) / l.lanes_dir}, "drop": {l.id: 0.12}},
                          "ASSUMED: 12% of car trips on this link move to buses", 8.0 * max(l.length, MIN_JOB_M) / 1000, l.id))
        if a["signals"]:
            cands.append(("signal_retiming", "Retime and coordinate the signals", "Signal timing that follows the queues",
                          {"cap_factor": {i: 1.12 for i in lids}},
                          "ASSUMED: +12% effective capacity from better timing", 6.0, heavy.id))
        elif len(lids) >= 4:
            known = twin["meta"].get("signals_queried")
            cands.append(("signal_retiming", "Add signal control" if known else "Add or retime signal control",
                          "No signal is mapped here: a timed signal that follows the queues" if known
                          else "Signal timing that follows the queues (signals were not checked in this download)",
                          {"cap_factor": {i: 1.12 for i in lids}},
                          "ASSUMED: +12% effective capacity from timed control", 15.0 if known else 6.0, heavy.id))
        if a["crossings"] >= 2 and any(l.cls in ("main", "mid") and l.lanes_dir >= 1 for l in links):
            cands.append(("foot_overbridge", "Pedestrian overbridge or underpass", "Walkers leave the carriageway, so turning cars stop less",
                          {"cap_factor": {i: 1.05 for i in lids}},
                          "ASSUMED: +5% capacity once crossing conflicts are removed", 320.0, heavy.id))
        if area_base >= 0.8:
            cands.append(("route_diversion", "Divert some trips to a parallel street", "Signage and turn rules that send 15% of through trips around",
                          {"divert": {heavy.id: 0.15}}, "ASSUMED: 15% of trips using the busiest link follow the signs, if the detour is under 60% longer",
                          2.0, heavy.id))
        if heavy.lanes_dir == 1 and heavy.cls in ("mid", "main") and area_base >= 0.9:
            cands.append(("add_lane", "Add a lane on the busiest approach", f"Second lane on {heavy.name or 'the approach'}",
                          {"cap_factor": {heavy.id: 2.0}}, "ASSUMED: land and right of way exist", 150.0 * max(heavy.length, MIN_JOB_M) / 1000, heavy.id))
        for kind, title, what, mods, assume, cost, lid in cands:
            res = assign(M, **mods)
            after = max(float(res["link_ratio"][i]) for i in lids)
            d_area = round(100 * (after - area_base) / max(area_base, 1e-9), 1)
            d_net = _delay_change(M, res)
            if abs(d_area) < 0.05 and abs(d_net) < 0.05:
                continue   # changes nothing here, so it is not worth showing
            sols.append({
                "area_id": a["id"], "kind": kind, "link_id": lid, "title": title, "what": what, "assumption": assume,
                "area_load_before": round(float(area_base), 2), "area_load_after": round(after, 2), "area_load_change_pct": d_area,
                "network_delay_change_pct": d_net, "cost_lakh": round(cost, 1), "cost_basis": UNIT_COST_NOTE,
                "recommended": bool(d_area <= -3.0 and d_net <= 2.0),
            })
    return sols


def analyse(twin: dict) -> dict | None:
    """Run the whole screening. Returns the block stored in twin.json, or None if the network is too thin."""
    try:
        M = make_model(twin)
    except ValueError:
        return None
    areas = analyse_areas(M, twin)
    sols = propose(M, twin, areas)
    lr = M.base["link_ratio"]
    links = []
    keep = {s["link_id"] for s in sols} | {i for a in areas for i in a["links"]}
    for l in sorted(M.links, key=lambda l: -lr[l.id]):
        if (lr[l.id] < 0.15 or len(links) >= 500) and l.id not in keep:
            continue
        links.append({"id": l.id, "r": round(float(lr[l.id]), 2), "c": l.cls, "n": l.name, "lanes": l.lanes_dir,
                      "pts": [[round(p[0], 1), round(p[1], 1)] for p in l.geom]})
    live = lr[lr > 0]
    return {
        "method": {
            "kind": "screening model, simulated",
            "demand": "trips from building floor area plus through traffic at the site edge (about a third of trips), "
                      f"{N_OD} sampled origin-destination pairs, congestion-aware routing (BPR, {STAGES} stages)",
            "scaling": f"ASSUMED: demand scaled so the 95th percentile link is at {int(PEAK_RATIO * 100)}% of capacity in a peak hour",
            "capacity": f"ASSUMED saturation flow per lane: {PER_LANE_VEH_H}",
            "limits": "No traffic counts were used. Read the ranking and the relative changes, not the vehicle numbers.",
        },
        "summary": {"links": len(M.links), "junction_nodes": len(M.nodes), "ods": len(M.ods),
                    "links_over_capacity": int((lr > 1.0).sum()), "links_over_80pct": int((lr > 0.8).sum()),
                    "p95_ratio": round(float(np.percentile(live, 95)), 2) if len(live) else 0.0,
                    "max_ratio": round(float(lr.max()), 2)},
        "links": links, "areas": areas, "solutions": sols,
    }
