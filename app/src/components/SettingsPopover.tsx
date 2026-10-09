import { useState } from 'react'

/* Keys stay in this browser (localStorage). Nothing is sent anywhere except to Google or Cesium ion to load the tiles. */
export function SettingsPopover({ hasKey, tilesErr, onKey, reduced, setReduced, quality, setQuality, lowPower, onClose }: {
  hasKey: boolean; tilesErr: string; onKey: (k: string) => void; reduced: boolean; setReduced: (v: boolean) => void
  quality: 'auto' | 'high' | 'low'; setQuality: (q: 'auto' | 'high' | 'low') => void; lowPower: boolean; onClose: () => void
}) {
  const [k, setK] = useState('')
  return (
    <div className="pointer-events-auto absolute right-4 top-[68px] z-30 w-[360px]">
      <div className="glass rise-in rounded-2xl p-4">
        <div className="flex items-center justify-between"><span className="label">Settings</span><button onClick={onClose} className="text-dim hover:text-ink" aria-label="Close settings">×</button></div>
        <div className="mt-3 text-[13px] font-medium text-white">Google Photorealistic 3D Tiles</div>
        <p className="mt-1 text-[12px] leading-relaxed text-dim">Paste a Google Maps key with the Map Tiles API enabled, or a free Cesium ion token (starts with eyJ). Without one, the city is drawn from open data on a dark map.</p>
        <div className="mt-2 flex gap-2">
          <input type="password" value={k} onChange={e => setK(e.target.value)} placeholder={hasKey ? 'A key is saved' : 'Key or token'} autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border border-line bg-black/30 px-3 py-2 text-[12.5px] text-ink focus:border-cyan/50 focus:outline-none" />
          <button className="btn btn-primary" onClick={() => { if (k.trim()) onKey(k.trim()) }}>Load</button>
        </div>
        {hasKey && <button className="mt-2 text-[12px] text-dim underline-offset-2 hover:text-ink hover:underline" onClick={() => onKey('')}>Forget the key and use the dark map</button>}
        {tilesErr && <div className="mt-2 rounded-lg border border-coral/40 bg-coral/10 px-3 py-2 text-[12px] text-coral">Tiles did not load: {tilesErr}</div>}
        <p className="mt-2 text-[11px] leading-relaxed text-faint">The photoreal tiles are only displayed. Every number comes from OpenStreetMap, LiDAR and the twin's own models, never from the tiles.</p>
        <div className="hair my-3" />
        <div className="mb-3 flex items-center justify-between text-[13px]">
          <span>Graphics <span className="text-dim">{lowPower ? '(running light)' : '(full effects)'}</span></span>
          <div className="seg">{(['auto', 'high', 'low'] as const).map(q => <button key={q} aria-pressed={quality === q} onClick={() => setQuality(q)}>{q === 'auto' ? 'Auto' : q === 'high' ? 'High' : 'Fast'}</button>)}</div>
        </div>
        <button onClick={() => setReduced(!reduced)} className="flex w-full items-center justify-between text-[13px]">
          <span>Reduce motion <span className="text-dim">(no orbit, instant flights)</span></span>
          <span className="switch" role="switch" aria-checked={reduced} />
        </button>
      </div>
    </div>
  )
}
