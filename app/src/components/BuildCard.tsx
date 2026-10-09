import { useEffect, useState } from 'react'
import { type BuildJob, type Place, buildStatus, startBuild, utcOffsetHours } from '../lib/services'

/* A searched place with no twin yet: build one on the spot (OpenStreetMap, canopy map or USGS LiDAR, shade, fixes,
   traffic), following the real progress of the build job. */
export function BuildCard({ place, onClose, onDone }: { place: Place; onClose: () => void; onDone: (siteId: string) => void }) {
  const [name, setName] = useState(place.name.split(',')[0].trim().slice(0, 40))
  const [radius, setRadius] = useState(500)
  const [job, setJob] = useState<BuildJob | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!job || job.state !== 'running') return
    const t = setInterval(() => buildStatus(job.id).then(setJob).catch(e => setErr(e.message)), 1500)
    return () => clearInterval(t)
  }, [job?.id, job?.state])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (job?.state === 'done') { const t = setTimeout(() => onDone(job.site), 900); return () => clearTimeout(t) } }, [job?.state])   // eslint-disable-line react-hooks/exhaustive-deps

  const go = async () => {
    setErr('')
    try { setJob(await startBuild({ lat: place.lat, lon: place.lon, name, radius, tz: await utcOffsetHours(place.lat, place.lon) })) }
    catch (e) { setErr((e as Error).message.includes('fetch') ? 'The builder is not running. Start it with: python scripts/dev_api.py' : (e as Error).message) }
  }

  return (
    <section className="glass panel-in pointer-events-auto absolute bottom-[78px] left-1/2 z-30 w-[min(520px,calc(100%-32px))] -translate-x-1/2 rounded-2xl px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="label mb-1">No twin here yet</div>
          <div className="truncate text-[14px] text-ink" title={place.name}>{place.name}</div>
          <div className="num mt-0.5 font-mono text-[11px] text-dim">{place.lat.toFixed(5)}, {place.lon.toFixed(5)}</div>
        </div>
        <button onClick={onClose} aria-label="Close" className="-mr-1 grid h-7 w-7 place-items-center rounded-lg text-dim hover:bg-white/5 hover:text-ink">×</button>
      </div>
      {!job && <>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input value={name} onChange={e => setName(e.target.value)} aria-label="Site name" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-ink outline-none focus:border-cyan/60" />
          {[300, 500, 800].map(r => <button key={r} onClick={() => setRadius(r)} className={'rounded-lg border px-2.5 py-2 font-mono text-[11.5px] ' + (radius === r ? 'border-cyan/70 text-cyan' : 'border-white/10 text-dim hover:text-ink')}>{r} m</button>)}
        </div>
        <button className="btn btn-primary mt-3 w-full justify-center !py-2.5" onClick={go}>Build a twin here</button>
        <p className="mt-2 text-[11.5px] leading-snug text-dim">Downloads OpenStreetMap, reads USGS LiDAR in the US or the satellite canopy map elsewhere, then computes hourly shade, tree and footpath fixes and the simulated traffic screen. About 45 seconds for 500 m; 800 m takes a few minutes.</p>
      </>}
      {job && <div className="mt-3">
        <div className="flex items-baseline justify-between text-[12.5px]"><span className="text-ink">{job.state === 'error' ? 'Build failed' : job.step}</span><span className="num font-mono text-dim">{job.pct}% · {job.elapsed_s}s</span></div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10"><div className={'h-full rounded-full transition-all duration-700 ' + (job.state === 'error' ? 'bg-coral' : 'bg-cyan')} style={{ width: job.pct + '%' }} /></div>
        <div className="mt-2 truncate font-mono text-[10.5px] text-faint" title={job.last}>{job.error || job.last}</div>
        {job.state === 'done' && <div className="mt-2 text-[12.5px] text-emerald">Ready. Opening {job.name}…</div>}
        {job.state === 'error' && <button className="btn mt-3" onClick={() => setJob(null)}>Try again</button>}
      </div>}
      {err && <div className="mt-2 text-[12px] text-coral">{err}</div>}
    </section>
  )
}
