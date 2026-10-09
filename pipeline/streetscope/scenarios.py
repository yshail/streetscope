"""What-if fixes on the real twin: plant street trees, widen footpaths, or both. All numbers come from the shade engine."""

from __future__ import annotations

import copy
import math
from datetime import date

import numpy as np

from . import shade as shade_mod

TREE_HEIGHT_M = 8.0        # assumed height of a young street tree after a few years
TREE_CROWN_R = 3.0         # assumed crown radius
MIN_SPACING_M = 8.0        # street trees are not planted closer than this
COST_PER_TREE_INR = 6000   # ASSUMED: planting plus three years of care, not a quote
COST_PER_M2_WIDEN_INR = 3500  # ASSUMED: new paving per square metre, not a quote
WIDE_STRIP_M = 3.5         # footpath width beside the road after widening (today: 2.0)


def day_mean(pcts: list, sun: list[dict], min_el: float = 15.0) -> float | None:
    vals = [p for p, s in zip(pcts, sun) if p is not None and s["el"] > min_el]
    return round(float(np.mean(vals)), 1) if vals else None


def plan_trees(twin: dict, stack: np.ndarray, meta: dict, walk2: np.ndarray, n: int) -> list[dict]:
    """Pick up to n spots on the sunniest walkway cells, 8 m apart, clear of buildings and existing trees."""
    cell = meta["cell_m"]
    ox, oz = meta["origin"]
    day = [k for k, s in enumerate(meta["sun"]) if s["el"] > 15]
    if not day:
        return []
    sunny = (stack[day] == shade_mod.SUN).mean(axis=0).astype(np.float32)
    building = (stack == shade_mod.BUILDING).any(axis=0)
    pad = np.pad(building, 2)
    near_building = np.zeros_like(building)
    for dy in range(5):
        for dx in range(5):
            near_building |= pad[dy:dy + building.shape[0], dx:dx + building.shape[1]]
    ok = (walk2 == 1) & ~near_building & (sunny >= 0.5)
    ps = np.pad(sunny, 1)
    benefit = sum(ps[dy:dy + sunny.shape[0], dx:dx + sunny.shape[1]] for dy in range(3) for dx in range(3)) / 9.0
    jj, ii = np.nonzero(ok)
    order = np.argsort(-benefit[jj, ii], kind="stable")
    ex = np.array([[t["x"], t["z"]] for t in twin["trees"]]) if twin["trees"] else np.zeros((0, 2))
    picked: list[dict] = []
    px: list[float] = []
    pz: list[float] = []
    for o in order:
        x, z = ox + (ii[o] + 0.5) * cell, oz + (jj[o] + 0.5) * cell
        if px and float(np.hypot(np.array(px) - x, np.array(pz) - z).min()) < MIN_SPACING_M:
            continue
        if len(ex) and float(np.hypot(ex[:, 0] - x, ex[:, 1] - z).min()) < 3.0:
            continue
        px.append(x)
        pz.append(z)
        picked.append({"x": round(float(x), 1), "z": round(float(z), 1), "height_m": TREE_HEIGHT_M, "crown_r": TREE_CROWN_R,
                       "source": "planned"})
        if len(picked) >= n:
            break
    return picked


def _summary(meta: dict) -> dict:
    return {"walk_cells": meta["walk_cells"], "walk_shade_pct": meta["walk_shade_pct"],
            "day_mean_shade_pct": day_mean(meta["walk_shade_pct"], meta["sun"])}


def build(twin: dict, day: date, tz_hours: float, hours: list[int], base_stack: np.ndarray, base_meta: dict,
          base_walk2: np.ndarray, n_trees: int = 25) -> tuple[list[dict], dict[str, tuple[np.ndarray, np.ndarray]]]:
    """Return (scenario descriptions, {id: (shade stack, walk mask)}) for the three fixes."""
    base = _summary(base_meta)
    out: list[dict] = []
    arrays: dict[str, tuple[np.ndarray, np.ndarray]] = {}

    def run(sid: str, name: str, why: str, trees: list[dict], strip: float, stack0, meta0, walk0) -> None:
        t2 = copy.deepcopy(twin)
        t2["trees"] = t2["trees"] + trees
        stack, meta, walk2 = shade_mod.compute(t2, day, tz_hours, hours, strip_m=strip)
        s = _summary(meta)
        extra_m2 = max(0, s["walk_cells"] - base["walk_cells"])
        cost = len(trees) * COST_PER_TREE_INR + extra_m2 * COST_PER_M2_WIDEN_INR
        shaded = lambda sm: None if sm["day_mean_shade_pct"] is None else round(sm["walk_cells"] * sm["day_mean_shade_pct"] / 100)
        out.append({
            "id": sid, "name": name, "why": why, "trees_added": trees, "footpath_strip_m": strip, **s,
            "shaded_walk_m2_day_mean": shaded(s), "baseline_shaded_walk_m2_day_mean": shaded(base),
            "baseline_day_mean_shade_pct": base["day_mean_shade_pct"], "baseline_walk_shade_pct": base["walk_shade_pct"],
            "baseline_walk_cells": base["walk_cells"], "extra_walk_m2": extra_m2,
            "cost_inr": cost, "cost_basis": (f"ASSUMED: {COST_PER_TREE_INR} rupees per tree with three years of care, "
                                              f"{COST_PER_M2_WIDEN_INR} rupees per square metre of new footpath. Not quotes."),
            "assumptions": f"each new tree is {TREE_HEIGHT_M} m tall with a {TREE_CROWN_R} m crown; trees at least {MIN_SPACING_M} m apart",
            "files": {"shade": f"scenario_{sid}.bin.gz", "walk": f"scenario_{sid}_walk.bin.gz"},
        })
        arrays[sid] = (stack, walk2)

    trees = plan_trees(twin, base_stack, base_meta, base_walk2, n_trees)
    run("trees", f"Plant {len(trees)} street trees", "Trees on the sunniest walkway spots, 8 m apart", trees, 2.0, base_stack, base_meta, base_walk2)
    run("widen", "Widen footpaths by 1.5 m", "Take 1.5 m from the carriageway on each side for walkers", [], WIDE_STRIP_M, base_stack, base_meta, base_walk2)
    w_stack, w_meta, w_walk = shade_mod.compute(twin, day, tz_hours, hours, strip_m=WIDE_STRIP_M)
    trees2 = plan_trees(twin, w_stack, w_meta, w_walk, n_trees)
    run("both", f"Widen footpaths and plant {len(trees2)} trees", "The wider footpath gets its own tree row", trees2, WIDE_STRIP_M, w_stack, w_meta, w_walk)
    return out, arrays
