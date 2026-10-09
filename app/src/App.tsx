import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Selection, Site, SiteRef } from './lib/types'
import { loadIndex, loadScenarioGrids, loadSite } from './lib/data'
import { type Finding, type Junction, type Rec, buildJunctions, compareMetrics, findings, recommendations } from './lib/model'
import { type Place, type Weather, doctorStatus, liveWeather, modelName, store } from './lib/services'
import type { CityScene, LayerKey, Preset } from './scene/CityScene'
import { CityViewport } from './components/CityViewport'
import { type Mode, TopNav } from './components/TopNav'
import { LayerControl } from './components/LayerControl'
import { CameraDock } from './components/CameraDock'
import { SelectionPanel } from './components/SelectionPanel'
import { AnalysisPanel } from './components/AnalysisPanel'
import { SimulationController } from './components/SimulationController'
import { CompareView } from './components/CompareView'
import { EnvStrip } from './components/EnvStrip'
import { SettingsPopover } from './components/SettingsPopover'
import { PointCloudViewer } from './components/PointCloudViewer'

const Q = new URLSearchParams(location.search)
const DEFAULT_LAYERS: Record<LayerKey, boolean> = { traffic: true, congestion: true, pedestrian: true, shade: false, trees: true, transit: false, ev: true, widths: true, buildings: true }

export default function App() {
  const sceneRef = useRef<CityScene | null>(null)
  const [ready, setReady] = useState(false)
  const [sites, setSites] = useState<SiteRef[]>([])
  const [siteId, setSiteId] = useState(Q.get('site') || 'aiims')
  const [site, setSite] = useState<Site | null>(null)
  const [junctions, setJunctions] = useState<Junction[]>([])
  const [loading, setLoading] = useState('Loading the city…')
  const [mode, setModeState] = useState<Mode>('explore')
  const [sel, setSel] = useState<Selection>(null)
  const [hourIdx, setHourIdx] = useState(9)
  const [layers, setLayers] = useState(DEFAULT_LAYERS)
  const [analysis, setAnalysis] = useState<{ jid: number; state: 'scanning' | 'done'; found: Finding[] } | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [proposed, setProposed] = useState(true)
  const [cloud, setCloud] = useState(Q.get('cloud') === '1')
  const [settings, setSettings] = useState(false)
  const [tilesErr, setTilesErr] = useState('')
  const [hasKey, setHasKey] = useState(!!store.get('gkey'))
  const [reduced, setReduced] = useState(store.get('reduced') === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [weather, setWeather] = useState<Weather | null>(null)
  const [doctor, setDoctor] = useState('checking…')
  const [toast, setToast] = useState('')
  const [hover, setHover] = useState<{ label: string; x: number; y: number } | null>(null)
  const [cam, setCam] = useState({ h: 0, mpp: 1 })

  /* ---------- scene and data ---------- */
  const onReady = useCallback((s: CityScene) => {
    sceneRef.current = s
    let t = 0
    s.onCamera = (h, mpp) => { const now = performance.now(); if (now - t > 120) { t = now; setCam({ h, mpp }) } }
    setReady(true)
  }, [])
  useEffect(() => { loadIndex().then(setSites).catch(() => setLoading('Could not read the twins. Start scripts/serve.py and open http://localhost:8765/app/')) }, [])
  useEffect(() => { doctorStatus().then(st => setDoctor(st ? (st.mode === 'offline' ? 'Offline templates' : `${modelName(st.model)} · ${st.provider}`) : 'Not running (scripts/dev_api.py)')) }, [])
  useEffect(() => { if (sceneRef.current) sceneRef.current.reduced = reduced; store.set('reduced', reduced ? '1' : '0') }, [reduced, ready])

  useEffect(() => {
    const s = sceneRef.current, ref = sites.find(x => x.id === siteId)
    if (!ready || !s || !ref) return
    let live = true
    setLoading('Building the twin…'); setSel(null); setAnalysis(null); setModeState('explore')
    loadSite(ref).then(async st => {
      if (!live) return
      const js = buildJunctions(st)
      const key = store.get('gkey')
      if (key && !s.tilesOn) { const e = await s.setTiles(key); setTilesErr(e || '') }
      await s.loadSite(st, js)
      Object.entries(layers).forEach(([k, v]) => s.setLayer(k as LayerKey, v))
      setSite(st); setJunctions(js)
      setHourIdx(Math.max(0, st.twin.shade.hours.indexOf(15)))
      setLoading('')
      liveWeather(st.twin.meta.center.lat, st.twin.meta.center.lon).then(w => live && setWeather(w))
    }).catch(e => setLoading('Could not load ' + ref.name + ': ' + e.message))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, sites, ready])

  useEffect(() => { sceneRef.current?.setHourIndex(hourIdx) }, [hourIdx])
  useEffect(() => { const s = sceneRef.current; if (s) Object.entries(layers).forEach(([k, v]) => s.setLayer(k as LayerKey, v)) }, [layers])

  /* ---------- the junction the modes work on ---------- */
  const selJ = sel?.kind === 'junction' ? junctions.find(j => j.id === sel.id) ?? null : null
  const activeJ = selJ ?? (analysis ? junctions.find(j => j.id === analysis.jid) ?? null : null) ?? junctions[0] ?? null
  const recs = useMemo(() => site && activeJ ? recommendations(site, activeJ) : [], [site, activeJ])
  const chosenRecs = recs.filter(r => chosen.has(r.id))
  const metrics = useMemo(() => site && activeJ ? compareMetrics(site, activeJ, chosenRecs) : [], [site, activeJ, chosen, recs])   // eslint-disable-line react-hooks/exhaustive-deps

  const pick = useCallback((s: Selection) => {
    setSel(s)
    sceneRef.current?.select(s)
    if (s?.kind === 'junction') { const j = junctions.find(x => x.id === s.id); if (j) sceneRef.current?.flyToJunction(j) }
  }, [junctions])
  useEffect(() => { const s = sceneRef.current; if (s) { s.onPick = pick; s.onHover = setHover } }, [pick])

  const runAnalysis = useCallback(async (j: Junction) => {
    const s = sceneRef.current
    if (!s || !site) return
    setSel({ kind: 'junction', id: j.id }); s.select({ kind: 'junction', id: j.id }); s.clearProposals()
    s.flyToJunction(j)
    setAnalysis({ jid: j.id, state: 'scanning', found: [] })
    await s.scan(j)
    const found = findings(site, j, hourIdx)
    s.showFindings(found)
    setAnalysis({ jid: j.id, state: 'done', found })
  }, [site, hourIdx])

  const defaultChoice = (rs: Rec[]) => new Set([rs.find(r => r.sol)?.id, rs.find(r => r.kind === 'trees')?.id, rs.find(r => r.kind === 'crossing')?.id].filter((x): x is string => !!x))

  const setMode = (m: Mode) => {
    const s = sceneRef.current
    if (!s || !site) { setModeState(m); return }
    s.clearFx(); s.clearProposals(); setAnalysis(null)
    if (m !== 'explore' && activeJ && !selJ) { setSel({ kind: 'junction', id: activeJ.id }); s.select({ kind: 'junction', id: activeJ.id }); s.flyToJunction(activeJ) }
    if (m === 'simulate') { setChosen(defaultChoice(recs)); setProposed(true) }
    setModeState(m)
  }

  /* Simulate: draw the chosen proposals and switch the shade grid to the planted-trees scenario */
  useEffect(() => {
    const s = sceneRef.current
    if (!s || !site || !activeJ) return
    if (mode !== 'simulate') { s.setStacks(site.stack, site.walk); return }
    s.proposals(activeJ, chosenRecs, proposed)
    const trees = proposed && chosenRecs.some(r => r.kind === 'trees')
    if (trees) loadScenarioGrids(site, 'trees').then(g => g && s.setStacks(g.stack, g.walk))
    else s.setStacks(site.stack, site.walk)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, chosen, proposed, activeJ?.id, site])

  const toggleRec = (id: string) => setChosen(prev => {
    const n = new Set(prev), r = recs.find(x => x.id === id)
    if (n.has(id)) n.delete(id)
    else { if (r?.sol) recs.filter(x => x.sol).forEach(x => n.delete(x.id)); n.add(id) }   // one traffic fix at a time
    return n
  })

  const pickRec = (r: Rec) => {
    const s = sceneRef.current
    setChosen(new Set([r.id])); setProposed(true); setAnalysis(null); s?.clearFx(); setModeState('simulate')
    if (s && r.at) s.focus(r.at[0], r.at[1], r.kind === 'trees' || r.kind === 'ev' ? 420 : 200)
  }

  const previewRec = (r: Rec) => { const s = sceneRef.current; if (!s || !activeJ) return; s.proposals(activeJ, [r], true); s.focus(r.at[0], r.at[1], r.kind === 'trees' || r.kind === 'ev' ? 420 : 220) }

  const onKey = async (k: string) => {
    store.set('gkey', k); setHasKey(!!k)
    const s = sceneRef.current
    if (!s) return
    setLoading(k ? 'Loading Google Photorealistic 3D Tiles…' : 'Switching to the dark open-data city…')
    const e = await s.setTiles(k); setTilesErr(e || ''); setLoading('')
    Object.entries(layers).forEach(([kk, v]) => s.setLayer(kk as LayerKey, v))
  }

  const onPlace = (p: Place) => { sceneRef.current?.flyToLonLat(p.lon, p.lat); setToast(`No twin here yet. Build one with: python -m streetscope build --lat ${p.lat.toFixed(4)} --lon ${p.lon.toFixed(4)} --radius 250 --name newsite --out web/data`) }

  /* deep links for demos and screenshots: ?site=dupont&mode=analyze&cloud=1 */
  const linked = useRef(false)
  useEffect(() => {
    if (linked.current || !site || !junctions.length) return
    linked.current = true
    const m = Q.get('mode') as Mode | null, jid = Q.get('j') ? +Q.get('j')! : null
    const j = jid ? junctions.find(x => x.id === jid) : junctions[0]
    if (m === 'analyze' && j) { setModeState('analyze'); runAnalysis(j) }
    else if (m === 'simulate' || m === 'compare') { if (j) { setSel({ kind: 'junction', id: j.id }); sceneRef.current?.select({ kind: 'junction', id: j.id }); sceneRef.current?.flyToJunction(j) } setChosen(defaultChoice(recommendations(site, j || junctions[0]))); setModeState(m) }
    else if (jid && j) pick({ kind: 'junction', id: j.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site, junctions])

  const tilesState = hasKey ? (sceneRef.current?.tilesOn ? 'Google Photorealistic 3D Tiles' : 'Tiles failed, dark open-data city') : 'Dark open-data city (no tiles key)'

  return (
    <div className="relative h-full w-full overflow-hidden">
      <CityViewport onReady={onReady} />
      {site && !cloud && <>
        {mode !== 'simulate' && <EnvStrip site={site} w={weather} hourIdx={hourIdx} setHourIdx={setHourIdx} />}
        {mode === 'explore' && sel && <SelectionPanel site={site} sel={sel} junctions={junctions} hourIdx={hourIdx} onClose={() => { setSel(null); sceneRef.current?.select(null) }}
          onAnalyze={() => { setModeState('analyze'); if (selJ) runAnalysis(selJ) }} onSimulate={() => { setChosen(defaultChoice(recs)); setProposed(true); setModeState('simulate') }} />}
        {mode === 'explore' && !sel && <Hint />}
        {mode === 'analyze' && activeJ && (analysis
          ? <AnalysisPanel site={site} j={activeJ} state={analysis.state} found={analysis.found} recs={recs} onFocus={(x, z) => sceneRef.current?.focus(x, z)} onPickRec={pickRec} onClose={() => { setAnalysis(null); sceneRef.current?.clearFx() }} />
          : <div className="pointer-events-auto absolute bottom-[78px] left-1/2 z-10 -translate-x-1/2 text-center">
              <div className="label mb-2">Selected · {activeJ.name}</div>
              <button className="btn btn-primary !px-6 !py-3 text-[14px]" onClick={() => runAnalysis(activeJ)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="8" /><path d="M12 4v4M12 16v4M4 12h4M16 12h4" /></svg>Analyze Area</button>
              <div className="mt-2 text-[11.5px] text-dim">or click any junction on the map</div>
            </div>)}
        {mode === 'simulate' && activeJ && <SimulationController recs={recs} chosen={chosen} toggle={toggleRec} proposed={proposed} setProposed={setProposed} metrics={metrics} junctionName={activeJ.name} />}
        {mode === 'compare' && activeJ && <CompareView recs={recs} junctionName={activeJ.name} onPreview={previewRec} onClose={() => setMode('explore')} />}
        <LayerControl on={layers} toggle={k => setLayers(l => ({ ...l, [k]: !l[k] }))} />
        <CameraDock heading={cam.h} mpp={cam.mpp} onPreset={(p: Preset) => sceneRef.current?.preset(p)} onNorth={() => sceneRef.current?.resetNorth()} />
      </>}
      {site && cloud && <PointCloudViewer site={site} hourIdx={hourIdx} onClose={() => setCloud(false)} />}
      <TopNav mode={mode} setMode={m => { if (cloud) setCloud(false); setMode(m) }} sites={sites} siteId={siteId} onSite={id => { setSiteId(id); setCloud(false) }} onPlace={onPlace}
        status={{ tiles: tilesState, doctor, live: !!weather }} onSettings={() => setSettings(v => !v)} cloud={cloud} setCloud={setCloud} />
      {settings && <SettingsPopover hasKey={hasKey} tilesErr={tilesErr} onKey={onKey} reduced={reduced} setReduced={setReduced} onClose={() => setSettings(false)} />}
      {hover && !cloud && <div className="pointer-events-none absolute z-20 rounded-md bg-black/75 px-2 py-1 font-mono text-[11px] text-ink" style={{ left: hover.x + 14, top: hover.y + 14 }}>{hover.label}</div>}
      {toast && <div className="glass rise-in pointer-events-auto absolute bottom-[78px] left-1/2 z-30 max-w-[640px] -translate-x-1/2 rounded-xl px-4 py-3 text-[12.5px]"><span className="text-ink">{toast}</span><button onClick={() => setToast('')} className="ml-3 text-dim hover:text-ink">×</button></div>}
      {loading && <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center"><div className="glass rise-in rounded-xl px-5 py-3 text-[13px] text-ink"><span className="mr-2 inline-block h-1.5 w-1.5 animate-ping rounded-full bg-cyan" />{loading}</div></div>}
    </div>
  )
}

function Hint() {
  return (
    <div className="rise-in pointer-events-none absolute bottom-[78px] left-1/2 z-10 -translate-x-1/2 text-center" style={{ animationDelay: '1.2s' }}>
      <div className="glass inline-flex items-center gap-4 rounded-full px-5 py-2.5 text-[12.5px] text-ink/90">
        <span><b className="text-amber">●</b> Click a glowing junction to inspect it</span><span className="text-faint">·</span>
        <span><b className="text-cyan">Analyze</b> scans an area</span><span className="text-faint">·</span><span><b className="text-violet">Simulate</b> shows proposals</span>
      </div>
    </div>
  )
}
