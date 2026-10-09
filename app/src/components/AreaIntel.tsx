import { useState } from 'react'
import type { Context, PoiCat } from '../lib/context'
import type { Site } from '../lib/types'
import { POI_COL } from '../scene/CityScene'
import { BasisChip } from './ui'

/* Area intelligence: futuristic, but every mark is a real quantity from OpenStreetMap or the twin */
export function AreaIntel({ ctx, site }: { ctx: Context | null; site: Site | null }) {
  const [open, setOpen] = useState(true)
  if (!ctx) return null
  const s = ctx.stats
  return (
    <div className="pointer-events-auto absolute left-4 z-10 w-[262px]" style={{ top: site ? 336 : 72 }}>
      <section className="glass rise-in rounded-2xl">
        <button onClick={() => setOpen(o => !o)} className="flex w-full items-center justify-between px-4 pt-3 pb-2" aria-expanded={open}>
          <span className="label">Area intelligence · {ctx.radius} m</span><BasisChip b="observed">OSM</BasisChip>
        </button>
        {open && <div className="scroll-thin overflow-y-auto px-4 pb-3" style={{ maxHeight: `calc(100vh - ${site ? 336 : 72}px - 150px)` }}>
          <div className="flex items-center gap-3">
            <Radar poi={s.poi} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Big v={s.buildings.toLocaleString()} l="buildings" />
              <Big v={`${s.mix}/6`} l="daily needs nearby" />
              <Big v={s.intersections.toLocaleString()} l="road junctions" />
            </div>
          </div>
          <div className="hair my-3" />
          <div className="label mb-1.5">Land cover</div>
          <Stack parts={[{ v: s.footprintPct, c: '#7dd3fc', l: 'Built' }, { v: s.greenPct, c: '#34d399', l: 'Green' }, { v: s.waterPct, c: '#3b82f6', l: 'Water' }]} />
          <div className="mt-3 flex items-center gap-3">
            <Gauge v={s.stopCoveragePct} />
            <div className="text-[11.5px] leading-snug text-dim"><b className="text-ink">{s.stopCoveragePct}%</b> of buildings within 400 m of a bus stop ({s.stops} stops)</div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Gauge v={s.taggedHeightPct} col="#e2e8f0" />
            <div className="text-[11.5px] leading-snug text-dim"><b className="text-ink">{s.taggedHeightPct}%</b> of heights are tagged; mean {s.meanHeight} m, tallest {s.tallest} m</div>
          </div>
          <div className="hair my-3" />
          <div className="label mb-1">Road network</div>
          <Bars rows={[['Major', s.roadKm.major], ['Secondary', s.roadKm.mid], ['Local', s.roadKm.minor], ['Footpaths', s.roadKm.path], ['Cycleways', s.roadKm.cycle]]} unit="km" />
          {site?.twin.traffic && <><div className="hair my-3" /><div className="mb-1 flex items-center justify-between"><span className="label">Peak load, all links</span><BasisChip b="simulated" /></div><LoadHist r={site.twin.traffic.links.map(l => l.r)} /></>}
        </div>}
      </section>
    </div>
  )
}

const Big = ({ v, l }: { v: string; l: string }) => <div className="flex items-baseline justify-between gap-2"><span className="num text-[17px] font-semibold leading-none text-white">{v}</span><span className="text-[10.5px] text-dim">{l}</span></div>

/* hexagonal radar of the six daily needs, square-root scaled so one shop does not vanish next to a hundred */
function Radar({ poi }: { poi: Record<PoiCat, number> }) {
  const keys: PoiCat[] = ['food', 'shop', 'health', 'education', 'transit', 'leisure'], S = 96, c = S / 2, R = 38
  const max = Math.max(1, ...keys.map(k => Math.sqrt(poi[k])))
  const pt = (i: number, f: number) => { const a = -Math.PI / 2 + i * Math.PI / 3; return [c + Math.cos(a) * R * f, c + Math.sin(a) * R * f] }
  const poly = keys.map((k, i) => pt(i, Math.max(.06, Math.sqrt(poi[k]) / max)).join(',')).join(' ')
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} role="img" aria-label="Mix of places nearby">
      {[.33, .66, 1].map(f => <polygon key={f} points={keys.map((_, i) => pt(i, f).join(',')).join(' ')} fill="none" stroke="rgba(148,178,210,.18)" />)}
      {keys.map((_, i) => <line key={i} x1={c} y1={c} x2={pt(i, 1)[0]} y2={pt(i, 1)[1]} stroke="rgba(148,178,210,.12)" />)}
      <polygon points={poly} fill="rgba(34,211,238,.2)" stroke="#22d3ee" strokeWidth="1.4" />
      {keys.map((k, i) => { const [x, y] = pt(i, 1.2); return <g key={k}><circle cx={pt(i, Math.max(.06, Math.sqrt(poi[k]) / max))[0]} cy={pt(i, Math.max(.06, Math.sqrt(poi[k]) / max))[1]} r="2.2" fill={POI_COL[k]} /><text x={x} y={y + 3} fontSize="7.5" textAnchor="middle" fill="#8a9bb0">{k.slice(0, 4).toUpperCase()}</text></g> })}
    </svg>
  )
}

function Stack({ parts }: { parts: { v: number; c: string; l: string }[] }) {
  return <>
    <div className="flex h-2 overflow-hidden rounded-full bg-white/[.06]">{parts.map(p => <div key={p.l} style={{ width: Math.min(100, p.v) + '%', background: p.c, boxShadow: `0 0 8px ${p.c}` }} />)}</div>
    <div className="mt-1.5 flex gap-3 text-[10.5px] text-dim">{parts.map(p => <span key={p.l} className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full" style={{ background: p.c }} />{p.l} <b className="num text-ink">{p.v}%</b></span>)}</div>
  </>
}

function Gauge({ v, col = '#22d3ee' }: { v: number; col?: string }) {
  const r = 15, L = 2 * Math.PI * r
  return <svg width="40" height="40" viewBox="0 0 40 40" className="flex-none"><circle cx="20" cy="20" r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="4" />
    <circle cx="20" cy="20" r={r} fill="none" stroke={col} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${L * v / 100} ${L}`} transform="rotate(-90 20 20)" style={{ filter: `drop-shadow(0 0 4px ${col})` }} /></svg>
}

function Bars({ rows, unit }: { rows: [string, number | undefined][]; unit: string }) {
  const max = Math.max(.01, ...rows.map(r => r[1] || 0))
  return <div className="space-y-1">{rows.map(([l, v]) => <div key={l} className="grid grid-cols-[64px_1fr_44px] items-center gap-2 text-[10.5px]">
    <span className="text-dim">{l}</span><div className="h-1 rounded-full bg-white/[.06]"><div className="h-1 rounded-full bg-cyan/70" style={{ width: (100 * (v || 0) / max) + '%' }} /></div><span className="num text-right text-ink">{(v || 0).toFixed(1)} {unit}</span></div>)}</div>
}

function LoadHist({ r }: { r: number[] }) {
  const bins = [0, .2, .4, .6, .8, 1, 1.2, 9], cols = ['#22d3ee', '#22d3ee', '#22d3ee', '#fbbf24', '#fb923c', '#fb7185', '#fb7185']
  const n = bins.slice(0, -1).map((b, i) => r.filter(x => x >= b && x < bins[i + 1]).length), max = Math.max(1, ...n)
  return <div>
    <div className="flex h-12 items-end gap-1">{n.map((v, i) => <div key={i} className="flex-1 rounded-t-sm" style={{ height: Math.max(2, 48 * v / max), background: cols[i], opacity: .85 }} title={`${v} links`} />)}</div>
    <div className="mt-1 flex justify-between font-mono text-[9px] text-faint"><span>0</span><span>0.6</span><span>1.0×</span><span>1.2+</span></div>
  </div>
}
