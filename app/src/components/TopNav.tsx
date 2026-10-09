import { useEffect, useRef, useState } from 'react'
import type { SiteRef } from '../lib/types'
import { type Place, searchPlaces } from '../lib/services'

export type Mode = 'explore' | 'analyze' | 'simulate' | 'compare'
const MODES: [Mode, string][] = [['explore', 'Explore'], ['analyze', 'Analyze'], ['simulate', 'Simulate'], ['compare', 'Compare']]

export function TopNav(p: {
  mode: Mode; setMode: (m: Mode) => void; sites: SiteRef[]; siteId: string; onSite: (id: string) => void; onPlace: (pl: Place) => void
  status: { tiles: string; doctor: string; live: boolean }; onSettings: () => void; cloud: boolean; setCloud: (v: boolean) => void
}) {
  return (
    <nav className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-4 px-4 pt-3">
      <div className="glass pointer-events-auto flex h-11 items-center gap-2.5 rounded-xl pl-3 pr-4">
        <Logo />
        <div className="leading-none">
          <div className="text-[14px] font-semibold tracking-tight text-white">GreenCity<span className="text-cyan">AI</span></div>
          <div className="mt-0.5 font-mono text-[8.5px] uppercase tracking-[.18em] text-faint">urban digital twin</div>
        </div>
      </div>
      <LocationSearch sites={p.sites} siteId={p.siteId} onSite={p.onSite} onPlace={p.onPlace} />
      <div className="glass pointer-events-auto mx-auto flex h-11 items-center rounded-xl px-1.5">
        <div className="seg !border-0 !bg-transparent" role="tablist" aria-label="Mode">
          {MODES.map(([m, l]) => <button key={m} role="tab" aria-pressed={p.mode === m} onClick={() => p.setMode(m)}>{l}</button>)}
        </div>
      </div>
      <div className="glass pointer-events-auto flex h-11 items-center gap-3 rounded-xl px-3">
        <div className="seg" aria-label="View">
          <button aria-pressed={!p.cloud} onClick={() => p.setCloud(false)}>City</button>
          <button aria-pressed={p.cloud} onClick={() => p.setCloud(true)}>Point cloud</button>
        </div>
        <Status {...p.status} />
        <button onClick={p.onSettings} aria-label="Settings" className="grid h-8 w-8 place-items-center rounded-lg text-dim hover:bg-white/5 hover:text-ink">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></svg>
        </button>
      </div>
    </nav>
  )
}

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#22d3ee" /><stop offset="1" stopColor="#34d399" /></linearGradient></defs>
      <path d="M16 3 28 10v12L16 29 4 22V10z" fill="none" stroke="url(#lg)" strokeWidth="1.6" />
      <path d="M16 9v14M10 12.5v8M22 12.5v8" stroke="url(#lg)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16" cy="9" r="1.8" fill="#34d399" />
    </svg>
  )
}

function Status({ tiles, doctor, live }: { tiles: string; doctor: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-white/5" aria-expanded={open}>
        <span className="pulse-dot h-2 w-2 rounded-full bg-emerald shadow-[0_0_10px_#34d399]" />
        <span className="font-mono text-[10px] uppercase tracking-[.14em] text-dim">Online</span>
      </button>
      {open && (
        <div className="glass rise-in absolute right-0 top-10 w-72 rounded-xl p-3 text-[12px]">
          <Row k="3D base" v={tiles} />
          <Row k="AI doctor" v={doctor} />
          <Row k="Live weather" v={live ? 'Open-Meteo, connected' : 'not reachable'} />
          <Row k="Analysis" v="Streetscope twin engine (local)" />
        </div>
      )}
    </div>
  )
}
const Row = ({ k, v }: { k: string; v: string }) => <div className="flex justify-between gap-3 py-1.5"><span className="label">{k}</span><span className="text-right text-ink">{v}</span></div>

function LocationSearch({ sites, siteId, onSite, onPlace }: { sites: SiteRef[]; siteId: string; onSite: (id: string) => void; onPlace: (p: Place) => void }) {
  const [q, setQ] = useState(''), [open, setOpen] = useState(false), [places, setPlaces] = useState<Place[]>([]), [busy, setBusy] = useState(false)
  const t = useRef<number>()
  const local = sites.filter(s => !q || s.name.toLowerCase().includes(q.toLowerCase()))
  useEffect(() => {
    clearTimeout(t.current)
    if (q.trim().length < 3) { setPlaces([]); return }
    t.current = window.setTimeout(async () => { setBusy(true); try { setPlaces(await searchPlaces(q)) } catch { setPlaces([]) } setBusy(false) }, 450)
  }, [q])
  const cur = sites.find(s => s.id === siteId)
  return (
    <div className="pointer-events-auto relative">
      <div className="glass flex h-11 w-[330px] items-center gap-2 rounded-xl px-3">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8a9bb0" strokeWidth="1.8"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input value={q} onChange={e => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 180)}
          placeholder={cur ? cur.name.replace(/\s*\(.*\)/, '') : 'Search a place'} aria-label="Search location"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink/80 focus:outline-none" />
        {busy && <span className="h-1.5 w-1.5 animate-ping rounded-full bg-cyan" />}
      </div>
      {open && (
        <div className="glass rise-in absolute left-0 top-12 w-[420px] overflow-hidden rounded-xl py-1.5 text-[13px]">
          <div className="label px-3 pb-1 pt-1.5">Analysed twins</div>
          {local.map(s => (
            <button key={s.id} onMouseDown={() => { onSite(s.id); setQ(''); setOpen(false) }} className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-white/5">
              <span>{s.name.replace(/\s*\(.*\)/, '')}</span><span className="font-mono text-[10px] text-faint">{/level 1/.test(s.name) ? 'LIDAR' : 'OPEN DATA'}</span>
            </button>
          ))}
          {places.length > 0 && <><div className="hair my-1.5" /><div className="label px-3 pb-1">Anywhere · fly there (no twin yet)</div></>}
          {places.map(p => (
            <button key={p.lat + ',' + p.lon} onMouseDown={() => { onPlace(p); setQ(''); setOpen(false) }} className="block w-full truncate px-3 py-2 text-left text-dim hover:bg-white/5 hover:text-ink">{p.name}</button>
          ))}
        </div>
      )}
    </div>
  )
}
