import { useState } from 'react'
import type { Selection, Site } from '../lib/types'
import { type Junction, facts, recommendations, speedKmh } from '../lib/model'
import { dist, polyLength, polygonArea } from '../lib/geo'
import { BasisChip, Panel, Stat, fmt } from './ui'

export function SelectionPanel({ site, sel, junctions, hourIdx, onClose, onAnalyze, onSimulate }: {
  site: Site; sel: Selection; junctions: Junction[]; hourIdx: number; onClose: () => void; onAnalyze: () => void; onSimulate: () => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  if (!sel) return null
  const tw = site.twin, hour = tw.shade.hours[hourIdx]
  let body: JSX.Element | null = null, title = '', kicker = ''

  if (sel.kind === 'junction') {
    const j = junctions.find(x => x.id === sel.id)
    if (!j) return null
    const f = facts(site, j, hourIdx), recs = recommendations(site, j), top = recs[0]
    const issues: { t: string; b: 'simulated' | 'computed' | 'observed' }[] = []
    if (f.worst >= 1) issues.push({ t: 'Traffic over assumed capacity at peak', b: 'simulated' })
    else if (f.worst >= .85) issues.push({ t: 'Traffic near capacity at peak', b: 'simulated' })
    if ((f.sunPct ?? 0) > 60) issues.push({ t: `Hot walkways: ${f.sunPct}% in sun at ${hour}:00`, b: 'computed' })
    if (f.crossings < 2) issues.push({ t: 'Few marked pedestrian crossings', b: 'observed' })
    if (!f.signals && j.links.length >= 4 && tw.meta.signals_queried) issues.push({ t: 'No traffic signal mapped', b: 'observed' })
    title = j.name; kicker = `Junction · ${j.links.length} approaches${j.area ? ' · hot spot ' + j.area.id : ''}`
    body = <>
      <div className="grid grid-cols-2 gap-x-5 px-5 pt-2">
        <Stat label="Peak speed" value={fmt(f.avgSpeed, 0)} unit="km/h" b="simulated" sub="mean of approaches" />
        <Stat label="Worst load" value={fmt(f.worst, 2)} unit="× cap." b="simulated" sub={f.worst >= 1 ? 'queues likely' : 'below capacity'} />
        <Stat label="Trees ≤ 50 m" value={f.trees} b={tw.stats.lidar ? 'observed' : 'computed'} sub={`${fmt(f.canopyPct)}% crown cover`} />
        <Stat label={`Walkway in sun ${hour}:00`} value={f.sunPct == null ? '–' : fmt(f.sunPct)} unit="%" b="computed" sub="within 60 m" />
      </div>
      <div className="px-5 pb-1 text-[12px] text-dim">{f.crossings} crossings · {f.stops} bus stops · {f.signals} signals mapped nearby <BasisChip b="observed" /></div>
      {f.widths.length > 0 && <div className="px-5 pt-2">
        <div className="label mb-1">Road widths</div>
        {f.widths.slice(0, 3).map(w => <div key={w.name} className="flex justify-between py-0.5 text-[12.5px]"><span className="truncate pr-3 text-ink/90">{w.name}</span><span className="num">{w.width.toFixed(1)} m <span className={'chip ml-1 ' + (w.source === 'default' ? 'b-assumed' : 'b-observed')}>{w.source === 'default' ? 'default' : w.source === 'lanes' ? 'lanes' : 'osm'}</span></span></div>)}
      </div>}
      {issues.length > 0 && <div className="px-5 pt-3">
        <div className="label mb-1.5">Detected issues</div>
        {issues.map(i => <div key={i.t} className="flex items-center justify-between gap-2 py-1 text-[12.5px]"><span className="text-ink/90">{i.t}</span><BasisChip b={i.b} /></div>)}
      </div>}
      {top && <div className="mx-5 mt-3 rounded-xl border border-violet/30 bg-violet/5 p-3">
        <div className="flex items-center justify-between"><span className="label !text-violet">Recommended action</span><BasisChip b={top.basis} /></div>
        <div className="mt-1 text-[13.5px] font-medium text-white">{top.title}</div>
        <div className="mt-0.5 text-[12px] text-dim">{top.effect}</div>
      </div>}
      <div className="flex gap-2 px-5 py-4">
        <button className="btn btn-primary flex-1 justify-center" onClick={onAnalyze}>Analyze area</button>
        <button className="btn btn-violet flex-1 justify-center" onClick={onSimulate}>Simulate</button>
      </div>
      <div className="hair" />
      <div className="px-5 py-3 text-[11px] leading-relaxed text-faint">Roads, crossings, stops: OpenStreetMap. Traffic: screening model with assumed demand, no counts. Shade: real sun position over {tw.stats.lidar ? 'LiDAR' : 'OpenStreetMap'} heights and mapped trees.</div>
    </>
  } else if (sel.kind === 'road') {
    const r = tw.roads.find(x => x.id === sel.id)
    if (!r) return null
    const link = tw.traffic?.links.find(l => l.n && l.n === r.name && l.pts.some(p => r.pts.some(q => dist(p[0], p[1], q[0], q[1]) < 3)))
    title = r.name || r.highway; kicker = `Road segment · ${r.highway}`
    body = <div className="grid grid-cols-2 gap-x-5 px-5 py-2">
      <Stat label="Width" value={r.width_m.toFixed(1)} unit="m" b={r.width_source === 'default' ? 'assumed' : 'observed'} sub={r.width_source === 'osm_width' ? 'OSM width tag' : r.width_source === 'lanes' ? 'from lane count' : 'class default'} />
      <Stat label="Lanes" value={r.lanes ?? '–'} b={r.lanes ? 'observed' : 'assumed'} sub={r.oneway ? 'one-way' : 'two-way'} />
      <Stat label="Length" value={fmt(polyLength(r.pts), 0)} unit="m" b="computed" />
      {link && <Stat label="Peak speed" value={fmt(speedKmh(link.c, link.r), 0)} unit="km/h" b="simulated" sub={`${link.r.toFixed(2)}× assumed capacity`} />}
    </div>
  } else if (sel.kind === 'building') {
    const b = tw.buildings.find(x => x.id === sel.id)
    if (!b) return null
    const a = polygonArea(b.footprint)
    title = b.name || 'Building'; kicker = 'Building' + (b.kind && b.kind !== 'yes' ? ' · ' + b.kind : '')
    body = <div className="grid grid-cols-2 gap-x-5 px-5 py-2">
      <Stat label="Height" value={b.height_m.toFixed(1)} unit="m" b={b.height_source === 'default' ? 'assumed' : 'observed'} sub={b.height_source === 'lidar' ? 'USGS LiDAR' : b.height_source === 'default' ? 'assumed 3 floors' : 'OpenStreetMap'} />
      <Stat label="Footprint" value={fmt(a, 0)} unit="m²" b="computed" />
      <Stat label="Floors (est.)" value={Math.max(1, Math.round(b.height_m / 3.2))} b="computed" sub="height ÷ 3.2 m" />
      <Stat label="Floor area (est.)" value={fmt(a * Math.max(1, Math.round(b.height_m / 3.2)), 0)} unit="m²" b="computed" />
    </div>
  } else if (sel.kind === 'tree') {
    const t = tw.trees[sel.index]
    title = 'Tree'; kicker = t.source === 'osm' ? 'Mapped in OpenStreetMap' : tw.stats.lidar ? 'Found in USGS LiDAR' : 'Found in the canopy height map'
    body = <div className="grid grid-cols-2 gap-x-5 px-5 py-2">
      <Stat label="Height" value={t.height_m.toFixed(1)} unit="m" b={t.source === 'osm' ? 'assumed' : 'observed'} />
      <Stat label="Crown radius" value={t.crown_r.toFixed(1)} unit="m" b={t.source === 'osm' ? 'assumed' : 'computed'} />
    </div>
  } else if (sel.kind === 'stop' || sel.kind === 'ev') {
    const s = sel.kind === 'stop' ? tw.stops[sel.index] : tw.ev[sel.index]
    const nj = [...junctions].sort((a, b) => dist(a.x, a.z, s.x, s.z) - dist(b.x, b.z, s.x, s.z))[0]
    title = s.name || (sel.kind === 'stop' ? 'Bus stop' : 'EV charger'); kicker = sel.kind === 'stop' ? 'Public transport · OpenStreetMap' : 'EV charging · OpenStreetMap'
    body = <div className="px-5 py-3 text-[12.5px] text-dim">{nj ? `Nearest junction: ${nj.name}, ${Math.round(dist(nj.x, nj.z, s.x, s.z))} m away. ` : ''}{sel.kind === 'stop' ? 'The dashed ring is a 400 m (about 5 minute) straight-line walk zone.' : ''}</div>
  }

  return (
    <div className="pointer-events-none absolute right-4 top-[72px] z-10 w-[372px]">
      <Panel title={<button onClick={() => setCollapsed(c => !c)} className="text-left" aria-expanded={!collapsed}>{title}</button>} kicker={kicker} onClose={onClose}>
        {!collapsed && <div className="scroll-thin max-h-[calc(100vh-190px)] overflow-y-auto">{body}</div>}
      </Panel>
    </div>
  )
}
