import type { Weather } from '../lib/services'
import type { Site } from '../lib/types'

/* Live conditions at the site (Open-Meteo) next to the twin's computed shade, with a sun dial:
   one radial bar per hour (length = walkway shaded), the sun marker at the chosen hour */
export function EnvStrip({ site, w, hourIdx, setHourIdx }: { site: Site; w: Weather | null; hourIdx: number; setHourIdx: (k: number) => void }) {
  const sh = site.twin.shade, hour = sh.hours[hourIdx], sun = sh.sun[hourIdx], pct = sh.walk_shade_pct[hourIdx]
  const uvCol = w?.uv == null ? 'text-white' : w.uv >= 8 ? 'text-coral' : w.uv >= 6 ? 'text-amber' : 'text-white'
  const S = 104, c = S / 2, n = sh.hours.length, ang = (k: number) => Math.PI + (k / (n - 1)) * Math.PI
  return (
    <div className="pointer-events-auto absolute left-4 top-[72px] z-10 w-[262px]">
      <div className="glass rise-in rounded-2xl px-4 py-3">
        <div className="flex items-center justify-between"><span className="label">Live at the site</span><span className="chip b-live">{w ? 'Live' : 'Offline'}</span></div>
        {w ? (
          <div className="mt-2 grid grid-cols-3 gap-2">
            <div><div className="num text-[21px] font-semibold leading-none text-white">{Math.round(w.temp)}°</div><div className="mt-1 text-[10px] text-dim">feels {Math.round(w.feels)}°</div></div>
            <div><div className={'num text-[21px] font-semibold leading-none ' + uvCol}>{w.uv == null ? '–' : w.uv.toFixed(0)}</div><div className="mt-1 text-[10px] text-dim">UV index</div></div>
            <div><div className={'num text-[21px] font-semibold leading-none ' + ((w.pm25 ?? 0) > 60 ? 'text-coral' : (w.pm25 ?? 0) > 35 ? 'text-amber' : 'text-white')}>{w.pm25 == null ? '–' : Math.round(w.pm25)}</div><div className="mt-1 text-[10px] text-dim">PM2.5 µg/m³</div></div>
          </div>
        ) : <div className="mt-2 text-[12px] text-dim">Weather service not reachable.</div>}
        <div className="hair my-2.5" />
        <div className="flex items-center justify-between"><span className="label">Sun &amp; shade model</span><span className="chip b-computed">Computed</span></div>
        <div className="mt-1 flex items-center gap-2">
          <svg width={S} height={S / 2 + 14} viewBox={`0 0 ${S} ${S / 2 + 14}`} className="flex-none" role="img" aria-label="Walkway shade by hour">
            {sh.hours.map((h, k) => {
              const a = ang(k), v = sh.walk_shade_pct[k], L = v == null ? 0 : 6 + 34 * v / 100, r0 = 10
              return <g key={h} onClick={() => setHourIdx(k)} className="cursor-pointer">
                <line x1={c + Math.cos(a) * r0} y1={c + Math.sin(a) * r0} x2={c + Math.cos(a) * (r0 + Math.max(2, L))} y2={c + Math.sin(a) * (r0 + Math.max(2, L))} stroke={k === hourIdx ? '#fde68a' : v == null ? '#334155' : '#34d399'} strokeOpacity={k === hourIdx ? 1 : .65} strokeWidth="4.5" strokeLinecap="round" />
              </g>
            })}
            {sun.el > 0 && <circle cx={c + Math.cos(ang(hourIdx)) * 48} cy={c + Math.sin(ang(hourIdx)) * 48} r="4" fill="#fde68a" style={{ filter: 'drop-shadow(0 0 5px #fbbf24)' }} />}
            <text x={6} y={S / 2 + 12} fontSize="8" fill="#8a9bb0">06</text><text x={S - 6} y={S / 2 + 12} fontSize="8" fill="#8a9bb0" textAnchor="end">18</text>
          </svg>
          <div className="min-w-0">
            <div className="num text-[22px] font-semibold leading-none text-white">{String(hour).padStart(2, '0')}:00</div>
            <div className="mt-1 text-[10.5px] text-dim">sun {Math.round(sun.el)}° · az {Math.round(sun.az)}°</div>
            <div className="num mt-2 text-[17px] font-semibold leading-none text-emerald">{pct == null ? '–' : Math.round(pct) + '%'}</div>
            <div className="mt-0.5 text-[10.5px] text-dim">walkway shaded</div>
          </div>
        </div>
        <input type="range" className="hour mt-1 w-full" min={0} max={n - 1} value={hourIdx} onChange={e => setHourIdx(+e.target.value)} aria-label="Hour of day" />
      </div>
    </div>
  )
}
