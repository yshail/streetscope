import { useState } from 'react'
import type { LayerKey } from '../scene/CityScene'
import type { Basis } from '../lib/types'
import { BasisChip } from './ui'

export const LAYERS: { k: LayerKey; label: string; b: Basis; swatch: string }[] = [
  { k: 'traffic', label: 'Traffic flow', b: 'simulated', swatch: 'linear-gradient(90deg,#22d3ee,#fbbf24,#fb7185)' },
  { k: 'congestion', label: 'Congestion', b: 'simulated', swatch: '#fb7185' },
  { k: 'pedestrian', label: 'Pedestrian flow', b: 'simulated', swatch: '#e2e8f0' },
  { k: 'shade', label: 'Sun & shade on walkways', b: 'computed', swatch: 'linear-gradient(90deg,#fbbf24,#34d399,#3878dc)' },
  { k: 'trees', label: 'Trees & canopy', b: 'observed', swatch: '#34d399' },
  { k: 'transit', label: 'Transit & 400 m walk zones', b: 'observed', swatch: '#22d3ee' },
  { k: 'ev', label: 'EV charging', b: 'observed', swatch: '#34d399' },
  { k: 'widths', label: 'Road widths', b: 'observed', swatch: '#e2e8f0' },
  { k: 'buildings', label: 'Buildings', b: 'observed', swatch: '#1e3a4f' },
]

export function LayerControl({ on, toggle }: { on: Record<LayerKey, boolean>; toggle: (k: LayerKey) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="pointer-events-auto absolute bottom-7 left-4 z-10">
      {open && (
        <div className="glass rise-in mb-2 w-[272px] rounded-xl p-2">
          {LAYERS.map(l => (
            <button key={l.k} onClick={() => toggle(l.k)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left text-[12.5px] hover:bg-white/5">
              <span className="h-[3px] w-4 flex-none rounded-full" style={{ background: l.swatch }} />
              <span className="flex-1 text-ink/90">{l.label}</span>
              <BasisChip b={l.b} />
              <span className="switch" role="switch" aria-checked={on[l.k]} aria-label={l.label} />
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={() => setOpen(o => !o)} className="glass flex h-9 items-center gap-2 rounded-xl px-3 text-[12px] text-ink" aria-expanded={open}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></svg>
          Layers
        </button>
        <Legend />
      </div>
    </div>
  )
}

/* The visual language: four kinds of information, always told apart */
function Legend() {
  return (
    <div className="glass flex h-9 items-center gap-3.5 rounded-xl px-3 font-mono text-[9.5px] uppercase tracking-[.12em]">
      <span className="flex items-center gap-1.5 text-slate-200"><i className="h-1.5 w-1.5 rounded-full bg-slate-200" />Observed</span>
      <span className="flex items-center gap-1.5 text-emerald"><i className="h-1.5 w-1.5 rotate-45 bg-emerald" />Computed</span>
      <span className="flex items-center gap-1.5 text-amber"><i className="h-[2px] w-3 bg-amber" />Simulated</span>
      <span className="flex items-center gap-1.5 text-violet"><i className="h-[2px] w-3 border-t border-dashed border-violet" />Proposed</span>
    </div>
  )
}
