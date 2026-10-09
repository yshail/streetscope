/* Analysis derived in the browser from the Streetscope twin. Every result carries its basis:
   observed (OpenStreetMap, LiDAR), computed (our geometry and shade maths), simulated (the traffic screening model),
   proposed (a hypothetical intervention with no model behind its effect) or assumed (unit rates). */
import type { Basis, Site, TrafficArea, TrafficLink, TrafficSolution, Tree, XZ } from './types'
import { centroid, dist, polyLength, polygonArea } from './geo'

export const FREE_KMH: Record<string, number> = { main: 50, mid: 40, local: 28 }
/* BPR curve, the same one the traffic model routes with */
export const speedKmh = (cls: string, r: number) => (FREE_KMH[cls] ?? 30) / (1 + 0.15 * Math.pow(Math.max(0, r), 4))

export interface Junction {
  id: number; x: number; z: number; links: number[]; roads: string[]; name: string; area: TrafficArea | null; worst: number
}

/* Junctions = nodes where three or more road links of the traffic network meet */
export function buildJunctions(site: Site): Junction[] {
  const tr = site.twin.traffic
  if (!tr) return []
  const nodes: { x: number; z: number; links: Set<number> }[] = []
  const find = (x: number, z: number) => {
    for (const n of nodes) if (Math.abs(n.x - x) < 3 && Math.abs(n.z - z) < 3) return n
    const n = { x, z, links: new Set<number>() }; nodes.push(n); return n
  }
  tr.links.forEach(l => {
    if (l.pts.length < 2) return
    find(l.pts[0][0], l.pts[0][1]).links.add(l.id)
    find(l.pts[l.pts.length - 1][0], l.pts[l.pts.length - 1][1]).links.add(l.id)
  })
  const byId = new Map(tr.links.map(l => [l.id, l]))
  const out: Junction[] = []
  nodes.filter(n => n.links.size >= 3).forEach((n, i) => {
    const links = [...n.links], ls = links.map(id => byId.get(id)!).filter(Boolean)
    const roads = [...new Set(ls.map(l => l.n).filter((s): s is string => !!s))]
    const area = tr.areas.reduce<TrafficArea | null>((best, a) => dist(a.x, a.z, n.x, n.z) < 30 && (!best || dist(a.x, a.z, n.x, n.z) < dist(best.x, best.z, n.x, n.z)) ? a : best, null)
    out.push({ id: i + 1, x: n.x, z: n.z, links, roads, area, worst: Math.max(...ls.map(l => l.r)),
      name: roads.length ? roads.slice(0, 2).join(' × ') : 'Junction ' + (i + 1) })
  })
  // hot spots first, then by load
  out.sort((a, b) => (b.area ? 1000 + b.area.score : b.worst) - (a.area ? 1000 + a.area.score : a.worst))
  out.forEach((j, i) => { j.id = i + 1 })
  return out
}

export interface Facts {
  approaches: { link: TrafficLink; speed: number }[]; avgSpeed: number; worst: number
  crossings: number; stops: number; signals: number; trees: number; canopyPct: number; nearestTree: number | null
  sunPct: number | null; walkCells: number; widths: { name: string; width: number; source: string }[]
}

export function walkSunAt(site: Site, x: number, z: number, radius: number, hourIdx: number, stack = site.stack, walk = site.walk) {
  const sh = site.twin.shade, n = sh.shape[1], per = n * n, c = sh.cell_m, off = hourIdx * per
  const i0 = Math.max(0, Math.floor((x - radius - sh.origin[0]) / c)), i1 = Math.min(n - 1, Math.floor((x + radius - sh.origin[0]) / c))
  const j0 = Math.max(0, Math.floor((z - radius - sh.origin[1]) / c)), j1 = Math.min(n - 1, Math.floor((z + radius - sh.origin[1]) / c))
  let tot = 0, sun = 0, sx = 0, sz = 0
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const cx = sh.origin[0] + (i + .5) * c, cz = sh.origin[1] + (j + .5) * c
    if (walk[j * n + i] !== 1 || dist(cx, cz, x, z) > radius) continue
    tot++
    if (stack[off + j * n + i] === 255) { sun++; sx += cx; sz += cz }
  }
  return { pct: tot ? Math.round(1000 * sun / tot) / 10 : null, cells: tot, sunX: sun ? sx / sun : x, sunZ: sun ? sz / sun : z }
}

export function facts(site: Site, j: Junction, hourIdx: number): Facts {
  const tw = site.twin, tr = tw.traffic!, byId = new Map(tr.links.map(l => [l.id, l]))
  const approaches = j.links.map(id => byId.get(id)!).filter(Boolean).map(link => ({ link, speed: speedKmh(link.c, link.r) }))
  const near = (arr: { x: number; z: number }[], r: number) => arr.filter(p => dist(p.x, p.z, j.x, j.z) <= r).length
  const trees50 = tw.trees.filter(t => dist(t.x, t.z, j.x, j.z) <= 50)
  const crown = trees50.reduce((s, t) => s + Math.PI * t.crown_r * t.crown_r, 0)
  const nearestTree = tw.trees.length ? Math.min(...tw.trees.map(t => dist(t.x, t.z, j.x, j.z))) : null
  const ws = walkSunAt(site, j.x, j.z, 60, hourIdx)
  const widths: Facts['widths'] = []
  const seen = new Set<string>()
  tw.roads.forEach(r => {
    if (r.cls === 'walk' || !r.name || seen.has(r.name)) return
    if (r.pts.some(p => dist(p[0], p[1], j.x, j.z) < 30)) { seen.add(r.name); widths.push({ name: r.name, width: r.width_m, source: r.width_source }) }
  })
  return {
    approaches, avgSpeed: approaches.reduce((s, a) => s + a.speed, 0) / Math.max(1, approaches.length), worst: j.worst,
    crossings: near(tw.crossings, 25), stops: near(tw.stops, 60), signals: near(tw.signals, 30), trees: trees50.length,
    canopyPct: Math.min(100, Math.round(1000 * crown / (Math.PI * 50 * 50)) / 10), nearestTree: nearestTree == null ? null : Math.round(nearestTree),
    sunPct: ws.pct, walkCells: ws.cells, widths,
  }
}

export interface Finding { id: string; basis: Basis; title: string; detail: string; at: XZ }

export function findings(site: Site, j: Junction, hourIdx: number): Finding[] {
  const f = facts(site, j, hourIdx), hour = site.twin.shade.hours[hourIdx], out: Finding[] = []
  const worst = [...f.approaches].sort((a, b) => b.link.r - a.link.r)[0]
  if (worst) {
    const m = worst.link.pts[Math.floor(worst.link.pts.length / 2)]
    out.push({ id: 'traffic', basis: 'simulated', at: [m[0], m[1]],
      title: worst.link.r >= 1 ? 'Approach over capacity at peak' : worst.link.r >= .85 ? 'Approach near capacity at peak' : 'Traffic flows below capacity',
      detail: `${worst.link.n || 'Unnamed approach'} carries ${worst.link.r.toFixed(2)}× its assumed capacity in the simulated peak hour; average speed about ${Math.round(worst.speed)} km/h.` })
  }
  const ws = walkSunAt(site, j.x, j.z, 60, hourIdx)
  if (ws.pct != null) out.push({ id: 'heat', basis: 'computed', at: [ws.sunX, ws.sunZ],
    title: ws.pct > 60 ? 'Walkways exposed to the sun' : 'Walkways partly shaded',
    detail: `${ws.pct}% of the walkway within 60 m is in direct sun at ${String(hour).padStart(2, '0')}:00, from the real sun position and building and tree heights.` })
  const anchor = site.twin.stops.find(s => dist(s.x, s.z, j.x, j.z) < 60) || site.twin.crossings.find(s => dist(s.x, s.z, j.x, j.z) < 25) || { x: j.x, z: j.z }
  out.push({ id: 'people', basis: 'observed', at: [anchor.x, anchor.z],
    title: f.crossings < 2 ? 'Few marked crossings' : 'Busy pedestrian junction',
    detail: `${f.crossings} marked crossing${f.crossings === 1 ? '' : 's'} within 25 m, ${f.stops} bus stop${f.stops === 1 ? '' : 's'} within 60 m, ${f.signals ? f.signals + ' traffic signal' + (f.signals > 1 ? 's' : '') : 'no traffic signal'} mapped, nearest street tree ${f.nearestTree ?? '-'} m away.` })
  return out
}

export type RecKind = TrafficSolution['kind'] | 'trees' | 'crossing' | 'ev'
export interface Rec {
  id: string; kind: RecKind; title: string; what: string; basis: Basis; effect: string; assumption: string
  costLakh: number; sol?: TrafficSolution; trees?: Tree[]; at: XZ; ev?: XZ[]; crossing?: { x: number; z: number; dx: number; dz: number; w: number }
}

export function recommendations(site: Site, j: Junction): Rec[] {
  const tw = site.twin, tr = tw.traffic, out: Rec[] = []
  if (tr && j.area) {
    tr.solutions.filter(s => s.area_id === j.area!.id)
      .sort((a, b) => (+b.recommended - +a.recommended) || (a.area_load_change_pct - b.area_load_change_pct))
      .forEach(s => out.push({ id: 'sol-' + s.kind, kind: s.kind, title: s.title, what: s.what, basis: 'simulated', sol: s, costLakh: s.cost_lakh,
        assumption: s.assumption, at: [j.x, j.z],
        effect: `Peak load ${s.area_load_before}× → ${s.area_load_after}× (${s.area_load_change_pct > 0 ? '+' : ''}${s.area_load_change_pct}%), network delay ${s.network_delay_change_pct > 0 ? '+' : ''}${s.network_delay_change_pct}%` }))
  }
  const sc = tw.scenarios.find(s => s.id === 'trees')
  if (sc) {
    const near = sc.trees_added.filter(t => dist(t.x, t.z, j.x, j.z) < 160)
    out.push({ id: 'trees', kind: 'trees', title: `Plant ${sc.trees_added.length} street trees`, basis: 'computed', trees: sc.trees_added, costLakh: sc.cost_inr / 1e5,
      what: `On the sunniest walkway spots, 8 m apart (${near.length} within 160 m of this junction).`, at: near.length ? [near[0].x, near[0].z] : [j.x, j.z],
      assumption: sc.assumptions, effect: `Day-mean walkway shade ${sc.baseline_day_mean_shade_pct}% → ${sc.day_mean_shade_pct}% across the site` })
  }
  const busiest = [...j.links].map(id => tr?.links.find(l => l.id === id)).filter((l): l is TrafficLink => !!l).sort((a, b) => b.r - a.r)[0]
  if (busiest) {
    const end = dist(busiest.pts[0][0], busiest.pts[0][1], j.x, j.z) < dist(busiest.pts[busiest.pts.length - 1][0], busiest.pts[busiest.pts.length - 1][1], j.x, j.z) ? 0 : busiest.pts.length - 1
    const p = busiest.pts[end], q = busiest.pts[end === 0 ? 1 : end - 1], L = dist(p[0], p[1], q[0], q[1]) || 1
    const dx = (q[0] - p[0]) / L, dz = (q[1] - p[1]) / L, off = Math.min(14, L * .5)
    out.push({ id: 'crossing', kind: 'crossing', title: 'Protected pedestrian crossing', basis: 'proposed', costLakh: 12,
      what: `Raised zebra crossing with a refuge island on ${busiest.n || 'the busiest approach'}, ${Math.round(off)} m from the junction.`,
      assumption: 'Hypothetical: not modelled. The effect on delay and safety needs pedestrian counts and a design study. Cost is an ASSUMED unit rate.',
      effect: 'Adds one protected crossing within 50 m', at: [p[0] + dx * off, p[1] + dz * off],
      crossing: { x: p[0] + dx * off, z: p[1] + dz * off, dx, dz, w: 2 + 3.2 * busiest.lanes * 2 } })
  }
  const ev = evCandidates(site)
  if (ev.length) out.push({ id: 'ev', kind: 'ev', title: ev.length === 1 ? 'EV charging candidate site' : `${ev.length} EV charging candidate sites`, basis: 'proposed', costLakh: ev.length * 9, ev,
    what: 'Kerbside spots on main roads beside the largest buildings, at least 300 m from any mapped charger.',
    assumption: 'Heuristic screening of map data: building floor area as a proxy for demand. Cost is an ASSUMED 9 lakh per site.',
    effect: `${ev.length} new site${ev.length === 1 ? '' : 's'}, none within 300 m of an existing charger`, at: ev[0] })
  return out
}

/* EV candidates: points along main and secondary roads, scored by nearby building volume, away from existing chargers */
export function evCandidates(site: Site, n = 3): XZ[] {
  const tw = site.twin, R = tw.meta.radius_m, cand: { x: number; z: number; s: number }[] = []
  const blds = tw.buildings.map(b => { const c = centroid(b.footprint); return { x: c[0], z: c[1], v: polygonArea(b.footprint) * b.height_m } })
  tw.roads.forEach(r => {
    if (r.cls !== 'main' && r.cls !== 'mid') return
    const L = polyLength(r.pts)
    for (let d = 20; d < L; d += 40) {
      let acc = 0, k = 0
      for (let i = 1; i < r.pts.length; i++) { const a = r.pts[i - 1], b = r.pts[i], l = dist(a[0], a[1], b[0], b[1]); if (acc + l >= d) { k = i; break } acc += l }
      if (!k) continue
      const a = r.pts[k - 1], b = r.pts[k], t = (d - acc) / (dist(a[0], a[1], b[0], b[1]) || 1), x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t
      if (Math.hypot(x, z) > R * .9 || tw.ev.some(e => dist(e.x, e.z, x, z) < 300)) continue
      cand.push({ x, z, s: blds.reduce((s, q) => s + (dist(q.x, q.z, x, z) < 80 ? q.v : 0), 0) })
    }
  })
  cand.sort((a, b) => b.s - a.s)
  const pick: XZ[] = []
  for (const c of cand) { if (pick.every(p => dist(p[0], p[1], c.x, c.z) > 250)) pick.push([c.x, c.z]); if (pick.length >= n) break }
  return pick
}

/* Routing on the traffic links with simulated BPR speeds: the main path through a link and the best detour around it */
export function routeAround(site: Site, linkId: number, mul = 1) {
  const tr = site.twin.traffic
  if (!tr) return null
  const key = (p: XZ) => Math.round(p[0] / 3) + ',' + Math.round(p[1] / 3)
  const adj = new Map<string, { to: string; link: TrafficLink; t: number }[]>()
  const add = (a: string, b: string, l: TrafficLink, t: number) => { if (!adj.has(a)) adj.set(a, []); adj.get(a)!.push({ to: b, link: l, t }) }
  tr.links.forEach(l => {
    if (l.pts.length < 2) return
    const t = polyLength(l.pts) / (speedKmh(l.c, l.r * (l.id === linkId ? mul : 1)) / 3.6)
    const a = key(l.pts[0]), b = key(l.pts[l.pts.length - 1]); add(a, b, l, t); add(b, a, l, t)
  })
  const link = tr.links.find(l => l.id === linkId)
  if (!link) return null
  const s = key(link.pts[0]), g = key(link.pts[link.pts.length - 1])
  const direct = polyLength(link.pts) / (speedKmh(link.c, link.r) / 3.6)
  const best = new Map<string, number>([[s, 0]]), prev = new Map<string, { from: string; link: TrafficLink }>(), done = new Set<string>()
  while (true) {
    let u: string | null = null, ub = Infinity
    best.forEach((v, k) => { if (!done.has(k) && v < ub) { ub = v; u = k } })
    if (u == null || u === g || ub > direct * 8) break
    done.add(u)
    for (const e of adj.get(u) || []) {
      if (e.link.id === linkId) continue
      const v = ub + e.t
      if (v < (best.get(e.to) ?? Infinity)) { best.set(e.to, v); prev.set(e.to, { from: u, link: e.link }) }
    }
  }
  if (!best.has(g)) return { direct, link, detour: null as null | { t: number; links: TrafficLink[] } }
  const links: TrafficLink[] = []
  for (let k = g; k !== s;) { const p = prev.get(k)!; links.push(p.link); k = p.from }
  return { direct, link, detour: { t: best.get(g)!, links: links.reverse() } }
}

export interface Metric { key: string; label: string; basis: Basis; before: number | null; after: number | null; unit: string; better: 'lower' | 'higher'; digits?: number }

export function compareMetrics(site: Site, j: Junction, recs: Rec[]): Metric[] {
  const tw = site.twin, siteArea = Math.PI * tw.meta.radius_m ** 2
  const sol = recs.find(r => r.sol)?.sol
  const trees = recs.find(r => r.kind === 'trees')
  const crossing = recs.find(r => r.kind === 'crossing')
  const sc = tw.scenarios.find(s => s.id === 'trees')
  const crown = (ts: Tree[]) => ts.reduce((s, t) => s + Math.PI * t.crown_r * t.crown_r, 0)
  const cover0 = Math.round(1000 * crown(tw.trees) / siteArea) / 10
  const crossings0 = tw.crossings.filter(c => dist(c.x, c.z, j.x, j.z) <= 50).length
  const worstLink = tw.traffic?.links.filter(l => j.links.includes(l.id)).sort((a, b) => b.r - a.r)[0]
  const speedBefore = worstLink ? speedKmh(worstLink.c, worstLink.r) : null
  const ratio = sol ? sol.area_load_after / Math.max(.01, sol.area_load_before) : 1
  const speedAfter = worstLink ? speedKmh(worstLink.c, worstLink.r * ratio) : null
  return [
    { key: 'load', label: 'Peak load', basis: 'simulated', before: sol ? sol.area_load_before : j.worst, after: sol ? sol.area_load_after : j.worst, unit: '×', better: 'lower', digits: 2 },
    { key: 'speed', label: 'Peak speed', basis: 'simulated', before: speedBefore, after: speedAfter, unit: 'km/h', better: 'higher', digits: 0 },
    { key: 'delay', label: 'Network delay', basis: 'simulated', before: 0, after: sol ? sol.network_delay_change_pct : 0, unit: '%', better: 'lower', digits: 1 },
    { key: 'shade', label: 'Walkway shade', basis: 'computed', before: sc ? sc.baseline_day_mean_shade_pct : null, after: sc ? (trees ? sc.day_mean_shade_pct : sc.baseline_day_mean_shade_pct) : null, unit: '%', better: 'higher', digits: 1 },
    { key: 'canopy', label: 'Crown cover', basis: 'computed', before: cover0, after: trees && sc ? Math.round(1000 * (crown(tw.trees) + crown(sc.trees_added)) / siteArea) / 10 : cover0, unit: '%', better: 'higher', digits: 1 },
    { key: 'cross', label: 'Crossings ≤ 50 m', basis: crossing ? 'proposed' : 'observed', before: crossings0, after: crossings0 + (crossing ? 1 : 0), unit: '', better: 'higher', digits: 0 },
    { key: 'cost', label: 'Cost', basis: 'assumed', before: 0, after: Math.round(recs.reduce((s, r) => s + r.costLakh, 0) * 10) / 10, unit: 'lakh ₹', better: 'lower', digits: 1 },
  ]
}

export const BASIS_LABEL: Record<Basis, string> = {
  observed: 'Observed', computed: 'Computed', simulated: 'Simulated', proposed: 'Proposed', assumed: 'Assumed', live: 'Live',
}
