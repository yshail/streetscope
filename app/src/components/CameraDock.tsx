import type { Preset } from '../scene/CityScene'

/* Camera presets, a compass that follows the heading, and a scale bar from metres per pixel at the screen centre */
export function CameraDock({ onPreset, heading, mpp, onNorth }: { onPreset: (p: Preset) => void; heading: number; mpp: number; onNorth: () => void }) {
  const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]
  const target = mpp * 90, m = nice.find(n => n >= target * .6) ?? 5000, px = Math.max(20, Math.min(140, m / Math.max(mpp, 1e-6)))
  return (
    <div className="pointer-events-auto absolute bottom-7 right-4 z-10 flex items-end gap-2">
      <div className="glass flex h-9 items-center gap-2 rounded-xl px-3">
        <div className="relative h-[3px] border-x border-b border-ink/70" style={{ width: px }} />
        <span className="num font-mono text-[10.5px] text-dim">{m >= 1000 ? m / 1000 + ' km' : m + ' m'}</span>
      </div>
      <div className="glass seg !rounded-xl !p-1">
        {(['aerial', 'isometric', 'street'] as Preset[]).map(p => <button key={p} onClick={() => onPreset(p)} className="capitalize">{p === 'street' ? 'Street' : p === 'aerial' ? 'Aerial' : 'Isometric'}</button>)}
      </div>
      <button onClick={onNorth} aria-label="Point north" className="glass grid h-9 w-9 place-items-center rounded-xl">
        <svg width="22" height="22" viewBox="0 0 24 24" style={{ transform: `rotate(${-heading}rad)`, transition: 'transform .2s linear' }}>
          <path d="M12 3 15 12 12 10.5 9 12z" fill="#fb7185" /><path d="M12 21 9 12 12 13.5 15 12z" fill="#64748b" />
        </svg>
      </button>
    </div>
  )
}
