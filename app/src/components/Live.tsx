import { useEffect, useRef, useState } from 'react'
import type { CityScene, Preset } from '../scene/CityScene'
import type { Context } from '../lib/context'
import type { Site } from '../lib/types'

/* Small widgets that listen to the scene directly, so camera moves and hovering never re-render the whole app */

export function HoverTip({ scene }: { scene: CityScene | null }) {
  const [h, setH] = useState<{ label: string; x: number; y: number } | null>(null)
  useEffect(() => scene ? scene.on('hover', setH) : undefined, [scene])
  if (!h) return null
  return <div className="pointer-events-none absolute z-20 rounded-md border border-cyan/30 bg-black/80 px-2 py-1 font-mono text-[11px] text-ink" style={{ left: h.x + 14, top: h.y + 14 }}>{h.label}</div>
}

export function CameraDock({ scene, onPreset }: { scene: CityScene | null; onPreset: (p: Preset) => void }) {
  const [cam, setCam] = useState({ heading: 0, mpp: 1 })
  useEffect(() => scene ? scene.on('camera', c => setCam(c)) : undefined, [scene])
  const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000], mpp = cam.mpp
  const m = nice.find(n => n >= mpp * 90 * .6) ?? 5000, px = Math.max(20, Math.min(140, m / Math.max(mpp, 1e-6)))
  return (
    <div className="pointer-events-auto absolute bottom-7 right-4 z-10 flex items-end gap-2">
      <div className="glass flex h-9 items-center gap-2 rounded-xl px-3">
        <div className="h-[3px] border-x border-b border-ink/70" style={{ width: px }} />
        <span className="num font-mono text-[10.5px] text-dim">{m >= 1000 ? m / 1000 + ' km' : m + ' m'}</span>
      </div>
      <div className="glass seg !rounded-xl !p-1">
        {(['aerial', 'isometric', 'street'] as Preset[]).map(p => <button key={p} onClick={() => onPreset(p)}>{p === 'street' ? 'Street' : p === 'aerial' ? 'Aerial' : 'Isometric'}</button>)}
      </div>
      <button onClick={() => scene?.resetNorth()} aria-label="Point north" className="glass grid h-9 w-9 place-items-center rounded-xl">
        <svg width="22" height="22" viewBox="0 0 24 24" style={{ transform: `rotate(${-cam.heading}rad)`, transition: 'transform .2s linear' }}><path d="M12 3 15 12 12 10.5 9 12z" fill="#fb7185" /><path d="M12 21 9 12 12 13.5 15 12z" fill="#64748b" /></svg>
      </button>
    </div>
  )
}

/* Mini-map: the road network and analysis area from above, with the camera position and heading. Click to fly. */
export function MiniMap({ scene, site, ctx }: { scene: CityScene | null; site: Site | null; ctx: Context | null }) {
  const base = useRef<HTMLCanvasElement>(null), top = useRef<HTMLCanvasElement>(null)
  const S = 168, R = ctx?.radius ?? site?.twin.meta.radius_m ?? 600
  const k = (S / 2 - 6) / R, px = (x: number) => S / 2 + x * k
  useEffect(() => {
    const cv = base.current
    if (!cv) return
    const g = cv.getContext('2d')!
    g.clearRect(0, 0, S, S)
    g.save(); g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, 7); g.clip()
    g.fillStyle = 'rgba(3,8,14,.9)'; g.fillRect(0, 0, S, S)
    ctx?.areas.forEach(a => { g.fillStyle = a.kind === 'water' ? 'rgba(37,99,235,.45)' : 'rgba(52,211,153,.22)'; g.beginPath(); a.pts.forEach((p, i) => i ? g.lineTo(px(p[0]), px(p[1])) : g.moveTo(px(p[0]), px(p[1]))); g.fill() })
    ctx?.buildings.forEach(b => { g.fillStyle = 'rgba(148,163,184,.22)'; g.fillRect(px(b.c[0]) - .7, px(b.c[1]) - .7, 1.4, 1.4) })
    const roads: { pts: [number, number][]; w: number; c: string }[] = ctx ? ctx.roads.filter(r => r.cls !== 'path').map(r => ({ pts: r.pts, w: r.cls === 'major' ? 1.6 : r.cls === 'mid' ? 1.1 : .6, c: r.cls === 'major' ? 'rgba(34,211,238,.8)' : 'rgba(125,211,252,.4)' })) : []
    site?.twin.traffic?.links.forEach(l => roads.push({ pts: l.pts, w: 1.6, c: l.r >= 1 ? '#fb7185' : l.r >= .85 ? '#fb923c' : l.r >= .6 ? '#fbbf24' : 'rgba(34,211,238,.7)' }))
    roads.forEach(r => { g.strokeStyle = r.c; g.lineWidth = r.w; g.beginPath(); r.pts.forEach((p, i) => i ? g.lineTo(px(p[0]), px(p[1])) : g.moveTo(px(p[0]), px(p[1]))); g.stroke() })
    if (site) { g.strokeStyle = 'rgba(34,211,238,.6)'; g.setLineDash([3, 3]); g.beginPath(); g.arc(S / 2, S / 2, site.twin.meta.radius_m * k, 0, 7); g.stroke(); g.setLineDash([]) }
    g.restore()
    g.strokeStyle = 'rgba(148,178,210,.3)'; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, 7); g.stroke()
    g.fillStyle = '#fb7185'; g.font = '600 9px Inter'; g.textAlign = 'center'; g.fillText('N', S / 2, 10)
  }, [ctx, site, k, S])
  useEffect(() => {
    if (!scene) return
    return scene.on('camera', c => {
      const cv = top.current
      if (!cv) return
      const g = cv.getContext('2d')!, x = Math.max(6, Math.min(S - 6, px(c.x))), y = Math.max(6, Math.min(S - 6, px(c.z)))
      g.clearRect(0, 0, S, S)
      const a = c.heading - Math.PI / 2, spread = .5
      const grd = g.createRadialGradient(x, y, 0, x, y, 34); grd.addColorStop(0, 'rgba(34,211,238,.45)'); grd.addColorStop(1, 'rgba(34,211,238,0)')
      g.fillStyle = grd; g.beginPath(); g.moveTo(x, y); g.arc(x, y, 34, a - spread, a + spread); g.closePath(); g.fill()
      g.fillStyle = '#ecfeff'; g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill()
    })
  }, [scene, k])   // eslint-disable-line react-hooks/exhaustive-deps
  const click = (e: React.MouseEvent) => { const r = (e.target as HTMLCanvasElement).getBoundingClientRect(); scene?.flyToXZ((e.clientX - r.left - S / 2) / k, (e.clientY - r.top - S / 2) / k) }
  if (!site && !ctx) return null
  return (
    <div className="glass pointer-events-auto absolute bottom-[76px] right-4 z-10 rounded-full p-1" title="Click to fly there">
      <div className="relative" style={{ width: S, height: S }}>
        <canvas ref={base} width={S} height={S} className="absolute inset-0" />
        <canvas ref={top} width={S} height={S} className="absolute inset-0 cursor-crosshair" onClick={click} />
      </div>
    </div>
  )
}
