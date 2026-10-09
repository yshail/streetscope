import type { Weather } from '../lib/services'
import type { Site } from '../lib/types'

/* Live conditions at the site (Open-Meteo) next to the twin's own computed numbers */
export function EnvStrip({ site, w, hourIdx, setHourIdx }: { site: Site; w: Weather | null; hourIdx: number; setHourIdx: (k: number) => void }) {
  const sh = site.twin.shade, hour = sh.hours[hourIdx], sun = sh.sun[hourIdx], pct = sh.walk_shade_pct[hourIdx]
  const uvCol = w?.uv == null ? '' : w.uv >= 8 ? 'text-coral' : w.uv >= 6 ? 'text-amber' : 'text-ink'
  return (
    <div className="pointer-events-auto absolute left-4 top-[72px] z-10 w-[262px]">
      <div className="glass rise-in rounded-2xl px-4 py-3">
        <div className="flex items-center justify-between"><span className="label">Live at the site</span><span className="chip b-live">{w ? 'Live' : 'Offline'}</span></div>
        {w ? (
          <div className="mt-2 grid grid-cols-3 gap-2">
            <div><div className="num text-[22px] font-semibold leading-none text-white">{Math.round(w.temp)}°</div><div className="mt-1 text-[10.5px] text-dim">feels {Math.round(w.feels)}°</div></div>
            <div><div className={'num text-[22px] font-semibold leading-none ' + uvCol}>{w.uv == null ? '–' : w.uv.toFixed(0)}</div><div className="mt-1 text-[10.5px] text-dim">UV index</div></div>
            <div><div className="num text-[22px] font-semibold leading-none text-white">{w.pm25 == null ? '–' : Math.round(w.pm25)}</div><div className="mt-1 text-[10.5px] text-dim">PM2.5 µg/m³</div></div>
          </div>
        ) : <div className="mt-2 text-[12px] text-dim">Weather service not reachable.</div>}
        <div className="hair my-3" />
        <div className="flex items-center justify-between"><span className="label">Shade model</span><span className="chip b-computed">Computed</span></div>
        <div className="mt-2 flex items-end justify-between">
          <div><div className="num text-[22px] font-semibold leading-none text-white">{String(hour).padStart(2, '0')}:00</div><div className="mt-1 text-[10.5px] text-dim">{sh.date} · sun {Math.round(sun.el)}°</div></div>
          <div className="text-right"><div className="num text-[22px] font-semibold leading-none text-white">{pct == null ? '–' : Math.round(pct)}<span className="text-[12px] text-dim">%</span></div><div className="mt-1 text-[10.5px] text-dim">walkway shaded</div></div>
        </div>
        <input type="range" className="hour mt-1 w-full" min={0} max={sh.hours.length - 1} value={hourIdx} onChange={e => setHourIdx(+e.target.value)} aria-label="Hour of day" />
      </div>
    </div>
  )
}
