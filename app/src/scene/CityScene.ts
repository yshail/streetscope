import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { Selection, Site, TrafficLink, XZ } from '../lib/types'
import type { Context, PoiCat } from '../lib/context'
import { Frame, along, centroid, dist, offsetLine, polyLength } from '../lib/geo'
import { type Junction, type Rec, routeAround, speedKmh } from '../lib/model'
import { Annotations } from './annotations'

export type LayerKey = 'traffic' | 'congestion' | 'pedestrian' | 'shade' | 'trees' | 'transit' | 'ev' | 'widths' | 'buildings'
  | 'context' | 'poi' | 'hexmap' | 'sunpath' | 'pillars' | 'compass'
export type Preset = 'aerial' | 'isometric' | 'street'
export type Quality = 'auto' | 'high' | 'low'

/* Palette: cyan = structure and selection, emerald = environment, amber -> coral = congestion, violet = proposals */
const C = (css: string, a = 1) => Cesium.Color.fromCssColorString(css).withAlpha(a)
export const COL = { cyan: '#22d3ee', ice: '#cffafe', emerald: '#34d399', amber: '#fbbf24', coral: '#fb7185', violet: '#a78bfa', slate: '#64748b' }
export const loadColor = (r: number) => r >= 1 ? COL.coral : r >= .85 ? '#fb923c' : r >= .6 ? COL.amber : COL.cyan
export const POI_COL: Record<PoiCat, string> = { health: '#fb7185', education: '#fbbf24', food: '#fb923c', shop: '#c084fc', transit: '#22d3ee', parking: '#94a3b8', civic: '#e2e8f0', leisure: '#34d399' }
const POI_GLYPH: Record<PoiCat, string> = { health: '+', education: 'E', food: 'F', shop: 'S', transit: 'T', parking: 'P', civic: 'C', leisure: 'L' }

/* A particle rides precomputed world positions along a link, so a frame is a lookup and a lerp, not trigonometry */
interface Track { pos: Cesium.Cartesian3[]; len: number; step: number }
interface Particle { tr: Track; d: number; dir: number; v0: number; r: number; linkId: number; p: Cesium.PointPrimitive }
type Evt = 'hover' | 'camera' | 'quality'
type Prim = { show: boolean; isDestroyed?: () => boolean }

export class CityScene {
  viewer: Cesium.Viewer
  ann: Annotations
  site: Site | null = null
  ctx: Context | null = null
  F: Frame = new Frame(0, 0)
  tilesOn = false
  reduced = false
  quality: Quality = 'auto'
  lowPower = false
  junctions: Junction[] = []
  onPick: (s: Selection) => void = () => {}
  private listeners: Record<Evt, ((v: never) => void)[]> = { hover: [], camera: [], quality: [] }
  private tileset: Cesium.Cesium3DTileset | null = null
  private hgrid: Float32Array | null = null
  private hn = 64
  private hspan = 1000
  private prims: Record<string, Prim[]> = {}
  private layerOn: Record<string, boolean> = {}
  private sel: Cesium.Entity[] = []
  private prop: Cesium.Entity[] = []
  private fx: Cesium.Entity[] = []
  private parts: Particle[] = []
  private walkers: Particle[] = []
  private mul = new Map<number, number>()
  private orbit: { c: Cesium.Cartesian3; h: number; p: number; r: number } | null = null
  private last = performance.now()
  private frameT = performance.now()
  private shadeHour = 0
  private shadeEnt: Cesium.Entity | null = null
  private shadeDirty = false
  private stack: Uint8Array | null = null
  private walk: Uint8Array | null = null
  private pulses: { prim: Cesium.Primitive; c: Cesium.Cartesian3; col: Cesium.Color; ph: number; base: number }[] = []
  private sunMark: Cesium.PointPrimitive | null = null
  private sunRay: Cesium.Polyline | null = null
  private sunP: ((az: number, el: number) => Cesium.Cartesian3) | null = null
  private token = 0
  private fps: number[] = []
  private camSig = ''
  private camT = 0
  private scanId = 0
  private scratch = new Cesium.Cartesian3()
  private glowCache = new Map<string, Cesium.Material>()

  constructor(el: HTMLElement, creditEl: HTMLElement, annEl: HTMLElement) {
    this.viewer = new Cesium.Viewer(el, {
      baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
        url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', maximumLevel: 16,
        credit: new Cesium.Credit('Basemap: Esri, HERE, Garmin, © OpenStreetMap contributors'),
      })),
      animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, fullscreenButton: false, infoBox: false, selectionIndicator: false, creditContainer: creditEl,
      msaaSamples: 2, useBrowserRecommendedResolution: true,
    })
    const base = this.viewer.imageryLayers.get(0); base.brightness = .55; base.contrast = 1.25; base.saturation = .6
    const s = this.viewer.scene
    s.globe.baseColor = C('#05080d')
    s.backgroundColor = C('#03060a')
    s.globe.showGroundAtmosphere = false
    s.globe.depthTestAgainstTerrain = false
    s.globe.tileCacheSize = 300
    s.screenSpaceCameraController.maximumZoomDistance = 30000
    s.screenSpaceCameraController.minimumZoomDistance = 2
    this.ann = new Annotations(s, annEl)
    this.darkLook(true)
    s.preRender.addEventListener(() => this.tick())
    s.postRender.addEventListener(() => this.measureFps())
    this.wireInput()
  }

  on(e: 'hover', fn: (v: { label: string; x: number; y: number } | null) => void): () => void
  on(e: 'camera', fn: (v: { heading: number; mpp: number; x: number; z: number }) => void): () => void
  on(e: 'quality', fn: (v: boolean) => void): () => void
  on(e: Evt, fn: (v: never) => void) { this.listeners[e].push(fn); return () => { this.listeners[e] = this.listeners[e].filter(f => f !== fn) } }
  private emit(e: Evt, v: unknown) { this.listeners[e].forEach(f => (f as (x: unknown) => void)(v)) }

  private darkLook(dark: boolean) {
    const s = this.viewer.scene
    s.skyAtmosphere.show = !dark
    if (s.skyBox) s.skyBox.show = !dark
    if (s.sun) s.sun.show = !dark
    if (s.moon) s.moon.show = false
    s.fog.enabled = !dark
    const bloom = s.postProcessStages.bloom
    bloom.enabled = dark && !this.lowPower
    Object.assign(bloom.uniforms, { glowOnly: false, contrast: 128, brightness: -.32, delta: 1, sigma: 2.2, stepSize: 1 })
  }

  /* ---------- quality: a slow GPU drops bloom, MSAA, resolution and part of the particles ---------- */
  setQuality(q: Quality) { this.quality = q; this.applyPower(q === 'low') }
  private applyPower(low: boolean) {
    this.lowPower = low
    const s = this.viewer.scene
    s.msaaSamples = low ? 1 : 2
    this.viewer.resolutionScale = low ? .8 : 1
    s.postProcessStages.bloom.enabled = !low && !this.tilesOn
    this.parts.forEach((p, i) => { p.p.show = !low || i % 2 === 0 })
    this.walkers.forEach((p, i) => { p.p.show = !low || i % 3 === 0 })
    this.emit('quality', low)
  }
  private measureFps() {
    const now = performance.now()
    this.fps.push(now)
    while (this.fps.length && now - this.fps[0] > 2500) this.fps.shift()
    if (this.quality === 'auto' && !this.lowPower && this.fps.length > 10 && now - this.fps[0] > 2000 && this.fps.length / 2.5 < 24) this.applyPower(true)
  }

  /* ---------- Google Photorealistic 3D Tiles (display only) ---------- */
  async setTiles(key: string): Promise<string | null> {
    if (this.tileset) { this.viewer.scene.primitives.remove(this.tileset); this.tileset = null }
    if (!key) { this.tilesOn = false; this.viewer.scene.globe.show = true; this.darkLook(true); await this.groundAndRebuild(); return null }
    try {
      if (key.startsWith('eyJ')) { Cesium.Ion.defaultAccessToken = key; this.tileset = await Cesium.createGooglePhotorealistic3DTileset() }
      else this.tileset = await Cesium.createGooglePhotorealistic3DTileset({ key, onlyUsingWithGoogleGeocoder: true })
      this.tileset.maximumScreenSpaceError = 16
      this.viewer.scene.primitives.add(this.tileset)
      this.viewer.scene.globe.show = false
      this.tilesOn = true
      this.darkLook(false)
      await this.groundAndRebuild()
      return null
    } catch (e) {
      this.tilesOn = false; this.viewer.scene.globe.show = true; this.darkLook(true)
      return String((e as Error).message || e)
    }
  }

  /* ---------- ground heights: the tiles sit at real heights, so overlays sample them once (roads only, roofs rejected) ---------- */
  private async groundAndRebuild() {
    this.hgrid = null
    const R = this.extent()
    this.hspan = R * 2.3
    if (this.tilesOn && (this.site || this.ctx)) {
      const lines: XZ[][] = this.site ? this.site.twin.roads.filter(r => r.cls !== 'walk' && !r.bridge).map(r => r.pts) : []
      if (this.ctx) this.ctx.roads.filter(r => r.cls !== 'path' && r.cls !== 'cycle').forEach(r => lines.push(r.pts))
      const pts: XZ[] = [[0, 0]]
      lines.forEach(l => { const L = polyLength(l); for (let d = 0; d < L; d += 25) { const a = along(l, d); if (Math.hypot(a.x, a.z) < R * 1.1) pts.push([a.x, a.z]) } })
      const sample = pts.filter((_, i) => i % Math.max(1, Math.ceil(pts.length / 900)) === 0)
      try {
        const got = await this.viewer.scene.sampleHeightMostDetailed(sample.map(p => { const g = this.F.lonLat(p[0], p[1]); return Cesium.Cartographic.fromDegrees(g[0], g[1]) }))
        const ok = got.map((c, i) => ({ x: sample[i][0], z: sample[i][1], h: c && Number.isFinite(c.height) ? c.height : NaN })).filter(s => Number.isFinite(s.h))
        const clean = ok.filter(s => { const nb = ok.filter(o => dist(o.x, o.z, s.x, s.z) < 120).map(o => o.h).sort((a, b) => a - b); return s.h <= nb[nb.length >> 1] + 4 })
        if (clean.length > 5) {
          const n = this.hn, g = new Float32Array(n * n), span = this.hspan
          for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const x = -span / 2 + (i + .5) * span / n, z = -span / 2 + (j + .5) * span / n
            const near = clean.map(s => ({ d: dist(s.x, s.z, x, z), h: s.h })).sort((a, b) => a.d - b.d).slice(0, 8)
            let w = 0, a = 0
            near.forEach(s => { const k = 1 / Math.max(1, s.d) ** 2; w += k; a += k * s.h })
            g[j * n + i] = a / w
          }
          this.hgrid = g
        }
      } catch { /* flat if sampling is not available */ }
    }
    this.rebuild()
  }
  private extent() { return Math.max(this.site?.twin.meta.radius_m ?? 0, this.ctx?.radius ?? 0, 300) }

  groundAt(x: number, z: number) {
    if (!this.hgrid) return 0
    const n = this.hn, span = this.hspan
    const fx = Math.min(n - 1.001, Math.max(0, (x + span / 2) / span * n - .5)), fz = Math.min(n - 1.001, Math.max(0, (z + span / 2) / span * n - .5))
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, g = this.hgrid
    return (g[j * n + i] * (1 - tx) + g[j * n + i + 1] * tx) * (1 - tz) + (g[(j + 1) * n + i] * (1 - tx) + g[(j + 1) * n + i + 1] * tx) * tz
  }
  pos(x: number, z: number, up = 0) { const g = this.F.lonLat(x, z); return Cesium.Cartesian3.fromDegrees(g[0], g[1], this.groundAt(x, z) + up) }
  private at(x: number, z: number, h: number) { const g = this.F.lonLat(x, z); return Cesium.Cartesian3.fromDegrees(g[0], g[1], h) }
  private flat(pts: XZ[]) { const out: number[] = []; pts.forEach(p => { const g = this.F.lonLat(p[0], p[1]); out.push(g[0], g[1]) }); return Cesium.Cartesian3.fromDegreesArray(out) }
  private line3(pts: XZ[], up: number) { return pts.map(p => this.pos(p[0], p[1], up)) }
  private ring(x: number, z: number, r: number, up = .4, n = 64) { const out: Cesium.Cartesian3[] = []; for (let i = 0; i <= n; i++) { const a = i / n * Math.PI * 2; out.push(this.pos(x + Math.cos(a) * r, z + Math.sin(a) * r, up)) } return out }

  /* ---------- what is loaded: an analysed twin, map context around it, or map context alone ---------- */
  async loadSite(site: Site, junctions: Junction[]) {
    this.site = site; this.junctions = junctions; this.ctx = null
    this.F = new Frame(site.twin.meta.center.lat, site.twin.meta.center.lon)
    this.stack = null; this.walk = null
    await this.groundAndRebuild()
    this.preset('isometric', true)
  }
  async setContext(ctx: Context | null) {
    this.ctx = ctx
    if (this.tilesOn) await this.groundAndRebuild()
    else { this.buildContext(); this.buildCompass() }
  }
  async showPlace(ctx: Context) {
    this.site = null; this.junctions = []; this.ctx = ctx; this.F = ctx.frame
    await this.groundAndRebuild()
    this.fly(0, 0, ctx.radius * 1.5, Math.PI / 4, -.62, true, 2.8)
  }

  /* ---------- primitives (batched, cheap) ---------- */
  private addPrim<T extends Prim>(group: string, p: T): T {
    this.viewer.scene.primitives.add(p)
    ;(this.prims[group] ||= []).push(p)
    p.show = this.layerOn[group === 'ctx-b' ? 'buildings' : group] !== false
    return p
  }
  private clearGroup(group: string) {
    (this.prims[group] || []).forEach(p => {
      if (p.isDestroyed && p.isDestroyed()) return
      // polylines share cached materials for speed, and Cesium destroys a polyline's material with it: hand each one a
      // throwaway material first so the shared ones stay alive for the next build
      if (p instanceof Cesium.PolylineCollection) for (let i = 0; i < p.length; i++) p.get(i).material = Cesium.Material.fromType('Color')
      this.viewer.scene.primitives.remove(p)
    })
    this.prims[group] = []
  }
  private polyColl(group: string) { return this.addPrim(group, new Cesium.PolylineCollection()) }
  private pointColl(group: string) { return this.addPrim(group, new Cesium.PointPrimitiveCollection()) }
  private labelColl(group: string) { return this.addPrim(group, new Cesium.LabelCollection()) }
  private glow(css: string, a: number, power = .22) {
    const k = css + a + power
    if (!this.glowCache.has(k)) this.glowCache.set(k, Cesium.Material.fromType('PolylineGlow', { color: C(css, a), glowPower: power, taperPower: 1 }))
    return this.glowCache.get(k)!
  }
  private solid(css: string, a: number) { return this.cached('c' + css + a, () => Cesium.Material.fromType('Color', { color: C(css, a) })) }
  private dashMat(css: string, a: number, len = 14) { return this.cached('d' + css + a + len, () => Cesium.Material.fromType('PolylineDash', { color: C(css, a), dashLength: len })) }
  private cached(k: string, f: () => Cesium.Material) { if (!this.glowCache.has(k)) this.glowCache.set(k, f()); return this.glowCache.get(k)! }

  /* Batched polygons, built a few hundred at a time across frames so a big city never freezes the page.
     Each geometry is created up front inside try/catch, so one broken footprint cannot stop rendering. */
  private polygons(group: string, items: { pts: XZ[]; base: number; top?: number; col: Cesium.Color; id?: string }[], ground: boolean, translucent: boolean) {
    const token = this.token, chunk = ground ? 600 : 350
    let i = 0
    const step = () => {
      if (token !== this.token) return
      const insts: Cesium.GeometryInstance[] = []
      for (const end = Math.min(items.length, i + chunk); i < end; i++) {
        const it = items[i]
        try {
          const desc = new Cesium.PolygonGeometry({ polygonHierarchy: new Cesium.PolygonHierarchy(it.pts.map(p => this.at(p[0], p[1], it.base))), height: it.base, extrudedHeight: it.top,
            vertexFormat: it.top != null ? Cesium.PerInstanceColorAppearance.VERTEX_FORMAT : Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT })
          const geom = Cesium.PolygonGeometry.createGeometry(desc)
          if (!geom) continue
          insts.push(new Cesium.GeometryInstance({ geometry: ground ? desc : geom, attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(it.col) }, id: it.id }))
        } catch { /* skip a broken footprint */ }
      }
      if (insts.length) {
        if (ground) this.addPrim(group, new Cesium.GroundPrimitive({ geometryInstances: insts, appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent }), classificationType: Cesium.ClassificationType.BOTH }))
        else this.addPrim(group, new Cesium.Primitive({ geometryInstances: insts, appearance: new Cesium.PerInstanceColorAppearance({ translucent, closed: items[0].top != null, flat: items[0].top == null }), asynchronous: false }))
      }
      if (i < items.length) setTimeout(step, 0)
    }
    step()
  }
  private corridors(group: string, items: { pts: XZ[]; w: number; col: Cesium.Color; h?: number }[], ground: boolean) {
    const insts: Cesium.GeometryInstance[] = []
    for (const it of items) {
      try {
        if (it.pts.length < 2) continue
        const desc = new Cesium.CorridorGeometry({ positions: this.flat(it.pts), width: it.w, height: ground ? undefined : (it.h ?? .05), vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT })
        const geom = Cesium.CorridorGeometry.createGeometry(desc)
        if (!geom) continue
        insts.push(new Cesium.GeometryInstance({ geometry: ground ? desc : geom, attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(it.col) } }))
      } catch { /* skip */ }
    }
    if (!insts.length) return
    if (ground) this.addPrim(group, new Cesium.GroundPrimitive({ geometryInstances: insts, appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }), classificationType: Cesium.ClassificationType.BOTH }))
    else this.addPrim(group, new Cesium.Primitive({ geometryInstances: insts, appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }), asynchronous: false }))
  }

  rebuild() {
    this.token++
    Object.keys(this.prims).forEach(k => this.clearGroup(k))
    if (this.shadeEnt) { this.viewer.entities.remove(this.shadeEnt); this.shadeEnt = null }
    this.ann.clear('')
    this.clearSel(); this.clearProposals(); this.clearFx()
    this.pulses = []; this.parts = []; this.walkers = []; this.sunMark = null; this.sunRay = null; this.sunP = null
    this.buildContext()
    if (this.site) {
      this.buildBase(); this.buildBuildings(); this.buildTraffic(); this.buildPedestrians(); this.buildTrees(); this.buildTransit(); this.buildEv()
      this.buildWidths(); this.buildJunctions(); this.buildShade(); this.buildHexmap(); this.buildPillars(); this.buildSunpath()
    }
    this.buildCompass()
    this.setHourIndex(this.shadeHour)
    if (this.lowPower) this.applyPower(true)
  }

  /* ---------- map context within about a kilometre: buildings, roads, green, water, rail, places ---------- */
  private buildContext() {
    ;['ctx-b', 'context', 'poi', 'ctx-bld'].forEach(g => this.clearGroup(g))
    const ctx = this.ctx
    if (!ctx) return
    const R0 = this.site ? this.site.twin.meta.radius_m : 0
    const inSite = (p: XZ) => Math.hypot(p[0], p[1]) < R0 * .98
    if (!this.tilesOn) {
      const bl = ctx.buildings.map((b, i) => ({ b, i, d: Math.hypot(b.c[0], b.c[1]) })).filter(o => !inSite(o.b.c)).sort((a, b) => a.d - b.d)
      this.polygons('ctx-bld', bl.map(({ b, i }) => ({ pts: b.pts, base: 0, top: b.h, col: C(b.tagged ? '#0e1924' : '#11171e', .9), id: 'cb:' + i })), false, false)
      const rims = this.polyColl('ctx-b')
      bl.forEach(({ b }) => { if (b.h > 14 || b.tagged) rims.add({ positions: b.pts.concat([b.pts[0]]).map(p => this.at(p[0], p[1], b.h + .2)), width: 1, material: this.solid(b.tagged ? COL.cyan : COL.slate, b.tagged ? .22 : .14) }) })
      const lines = this.polyColl('context')
      const W: Record<string, [number, number]> = { major: [2.6, .55], mid: [1.8, .4], minor: [1.1, .22], path: [1, .14], cycle: [1, .2] }
      ctx.roads.forEach(r => { if (r.pts.length < 2 || (inSite(r.pts[0]) && inSite(r.pts[r.pts.length - 1]))) return; const [w, a] = W[r.cls]; lines.add({ positions: this.line3(r.pts, .3), width: w, material: r.cls === 'major' ? this.glow(COL.cyan, a, .12) : this.solid(r.cls === 'cycle' ? COL.emerald : '#7dd3fc', a) }) })
    }
    const ar = ctx.areas.filter(a => a.pts.length >= 3)
    this.polygons('context', ar.map(a => ({ pts: a.pts, base: this.tilesOn ? 0 : .08, col: C(a.kind === 'water' ? '#1d4ed8' : COL.emerald, a.kind === 'water' ? .35 : this.tilesOn ? .16 : .13) })), this.tilesOn, true)
    const rl = this.polyColl('context')
    ctx.lines.forEach(l => rl.add({ positions: this.line3(l.pts, .6), width: l.kind === 'rail' ? 2 : 2.5, material: l.kind === 'rail' ? this.dashMat('#c4b5fd', .7, 10) : this.solid('#3b82f6', .6) }))
    // street names and places drawn on the GPU (no HTML)
    const names = this.labelColl('context'), seen = new Set<string>()
    ctx.roads.filter(r => r.name && (r.cls === 'major' || r.cls === 'mid')).sort((a, b) => polyLength(b.pts) - polyLength(a.pts)).forEach(r => {
      if (seen.has(r.name!) || seen.size > 40) return
      seen.add(r.name!)
      const m = along(r.pts, polyLength(r.pts) / 2)
      names.add({ position: this.pos(m.x, m.z, 3), text: r.name!.toUpperCase(), font: '500 10px "JetBrains Mono", monospace', fillColor: C('#a5f3fc', .85), outlineColor: C('#020617', .9), outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1400), disableDepthTestDistance: 800 })
    })
    const bb = this.addPrim('poi', new Cesium.BillboardCollection({ scene: this.viewer.scene })), pl = this.labelColl('poi')
    ctx.pois.forEach((p, i) => {
      bb.add({ position: this.pos(p.x, p.z, 4), image: poiIcon(p.cat), width: 18, height: 18, id: 'poi:' + i, disableDepthTestDistance: 1500,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, p.cat === 'transit' || p.cat === 'health' || p.cat === 'education' ? 1500 : 650), scaleByDistance: new Cesium.NearFarScalar(150, 1.1, 1500, .6) })
      if (p.name) pl.add({ position: this.pos(p.x, p.z, 4), text: p.name, font: '500 11px Inter, sans-serif', fillColor: C('#e2e8f0', .95), outlineColor: C('#020617', .9), outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(13, -1), horizontalOrigin: Cesium.HorizontalOrigin.LEFT, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 420), disableDepthTestDistance: 1500 })
    })
  }

  /* ---------- the analysed twin ---------- */
  private buildBase() {
    const R = this.site!.twin.meta.radius_m, pc = this.polyColl('base')
    pc.add({ positions: this.ring(0, 0, R, .3, 128), width: 1.2, material: this.dashMat(COL.cyan, .4, 18) })
    this.ann.add('base-r', this.pos(R * .707, -R * .707, 2), `<span class="ann-k">ANALYSIS AREA</span><span class="ann-v">R ${Math.round(R)} m</span>`, { prio: 0, maxDist: 8000, cls: 'ann-quiet' })
    if (!this.tilesOn) {
      for (let v = -Math.floor(R / 100) * 100; v <= R; v += 100) {
        const h = Math.sqrt(Math.max(0, R * R - v * v))
        pc.add({ positions: [this.pos(v, -h, .2), this.pos(v, h, .2)], width: 1, material: this.solid(COL.cyan, .05) })
        pc.add({ positions: [this.pos(-h, v, .2), this.pos(h, v, .2)], width: 1, material: this.solid(COL.cyan, .05) })
      }
      this.corridors('base', this.site!.twin.roads.filter(r => r.pts.length > 1).map(r => ({ pts: r.pts, w: r.cls === 'walk' ? 2.2 : r.width_m, col: C(r.cls === 'walk' ? '#1e2a36' : '#141d27', .95), h: .05 })), false)
    }
  }

  private buildBuildings() {
    if (this.tilesOn) return   // the photoreal tiles show the real buildings; picking uses the footprints
    const tw = this.site!.twin
    this.polygons('buildings', tw.buildings.map(b => ({ pts: b.footprint, base: 0, top: b.height_m, col: C(b.height_source !== 'default' ? '#0f1b27' : '#151b22', .94), id: 'b:' + b.id })), false, false)
    const rims = this.polyColl('buildings')
    tw.buildings.forEach(b => { const m = b.height_source !== 'default'; rims.add({ positions: b.footprint.concat([b.footprint[0]]).map(p => this.at(p[0], p[1], b.height_m + .2)), width: 1, material: this.solid(m ? COL.cyan : COL.slate, m ? .34 : .22) }) })
  }

  private track(pts: XZ[], lane: number, up: number): Track {
    const len = polyLength(pts), step = Math.max(2, Math.min(6, len / 40)), pos: Cesium.Cartesian3[] = []
    for (let d = 0; d <= len + .01; d += step) { const a = along(pts, Math.min(d, len)); pos.push(this.pos(a.x - a.dz * lane, a.z + a.dx * lane, up)) }
    if (pos.length < 2) pos.push(pos[0])
    return { pos, len, step }
  }

  /* traffic: glowing links sized by volume; particles slow down past capacity (simulated) */
  private buildTraffic() {
    const tr = this.site!.twin.traffic
    if (!tr) return
    const lines = this.polyColl('traffic'), pts = this.pointColl('traffic')
    tr.links.forEach(l => {
      if (l.pts.length < 2) return
      lines.add({ positions: this.line3(l.pts, .5), width: 1.5 + 3.2 * Math.min(l.r, 1.4), material: this.glow(loadColor(l.r), Math.round((.5 + .35 * Math.min(1, l.r)) * 10) / 10) })
      const len = polyLength(l.pts)
      if (len < 6) return
      const n = Math.max(1, Math.min(12, Math.round(len / 26 * Math.min(l.r, 1.4) * 1.4))), lane = 1.2 + .9 * Math.min(l.lanes, 3)
      const fw = this.track(l.pts, lane, 1.2), bw = this.track(l.pts, -lane, 1.2)
      for (let i = 0; i < n; i++) {
        const dir = i % 2 ? 1 : -1
        this.parts.push({ tr: dir > 0 ? fw : bw, d: Math.random() * len, dir, v0: speedKmh(l.c, 0), r: l.r, linkId: l.id,
          p: pts.add({ position: fw.pos[0], pixelSize: 3 + Math.min(l.lanes, 3), color: C(loadColor(l.r), .95) }) })
      }
    })
    this.corridors('congestion', tr.links.filter(l => l.r >= .85 && l.pts.length > 1).map(l => ({ pts: l.pts, w: 4 + 3.2 * l.lanes * 2, col: C(l.r >= 1 ? COL.coral : '#fb923c', .26), h: .15 })), this.tilesOn)
  }

  /* pedestrians: illustrative streams on footpaths (no counts exist) */
  private buildPedestrians() {
    const tw = this.site!.twin, pts = this.pointColl('pedestrian')
    tw.roads.filter(r => r.cls === 'walk' && r.pts.length > 1).forEach(r => {
      const len = polyLength(r.pts)
      if (len < 10) return
      const t = this.track(r.pts, 0, 1)
      for (let i = 0, n = Math.min(5, Math.max(1, Math.round(len / 50))); i < n && this.walkers.length < 700; i++)
        this.walkers.push({ tr: t, d: Math.random() * len, dir: i % 2 ? 1 : -1, v0: 1.4 * 3.6, r: 0, linkId: -1, p: pts.add({ position: t.pos[0], pixelSize: 2.4, color: C('#e2e8f0', .85) }) })
    })
    tw.crossings.forEach(c => pts.add({ position: this.pos(c.x, c.z, .3), pixelSize: 5, color: C('#f8fafc', .9), outlineColor: C(COL.cyan, .6), outlineWidth: 1 }))
  }

  private buildTrees() {
    const tw = this.site!.twin
    if (this.tilesOn) {
      const pc = this.pointColl('trees')
      tw.trees.forEach((t, i) => pc.add({ position: this.pos(t.x, t.z, t.height_m), pixelSize: 4, color: C(COL.emerald, .95), outlineColor: C('#022c22', .8), outlineWidth: 1, id: 't:' + i }))
      const insts = tw.trees.map(t => new Cesium.GeometryInstance({ geometry: new Cesium.EllipseGeometry({ center: this.pos(t.x, t.z), semiMajorAxis: t.crown_r, semiMinorAxis: t.crown_r, vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT }), attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(C(COL.emerald, .22)) } }))
      if (insts.length) this.addPrim('trees', new Cesium.GroundPrimitive({ geometryInstances: insts, appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }), classificationType: Cesium.ClassificationType.BOTH }))
      return
    }
    const insts = tw.trees.map((t, i) => new Cesium.GeometryInstance({
      geometry: new Cesium.EllipsoidGeometry({ radii: new Cesium.Cartesian3(t.crown_r, t.crown_r, t.crown_r * .85), stackPartitions: 8, slicePartitions: 10, vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT }),
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(this.at(t.x, t.z, t.height_m - t.crown_r * .85)), attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(C(t.source === 'osm' ? '#10b981' : '#34d399', .6)) }, id: 't:' + i }))
    if (insts.length) this.addPrim('trees', new Cesium.Primitive({ geometryInstances: insts, appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }) }))
    const trunks = this.polyColl('trees')
    tw.trees.forEach(t => trunks.add({ positions: [this.at(t.x, t.z, 0), this.at(t.x, t.z, Math.max(.5, t.height_m - t.crown_r * 1.5))], width: 1.5, material: this.solid('#475569', .8) }))
  }

  private buildTransit() {
    const tw = this.site!.twin, pc = this.pointColl('transit'), rings = this.polyColl('transit')
    tw.stops.forEach((s, i) => {
      pc.add({ position: this.pos(s.x, s.z, 2), pixelSize: 9, color: C(COL.cyan), outlineColor: C('#ffffff', .9), outlineWidth: 2, disableDepthTestDistance: 2000, id: 's:' + i })
      rings.add({ positions: this.ring(s.x, s.z, 400, .5, 96), width: 1, material: this.dashMat(COL.cyan, .18, 10) })
    })
  }

  private buildEv() {
    const pc = this.pointColl('ev')
    this.site!.twin.ev.forEach((s, i) => {
      pc.add({ position: this.pos(s.x, s.z, 2.5), pixelSize: 10, color: C(COL.emerald), outlineColor: C('#ecfeff', .9), outlineWidth: 2, disableDepthTestDistance: 2000, id: 'e:' + i })
      this.ann.add('ev-' + i, this.pos(s.x, s.z, 5), `<span class="ann-k">EV CHARGER · OBSERVED</span><span class="ann-v">${esc(s.name || 'Mapped')}</span>`, { prio: 2, maxDist: 1100, cls: 'ann-obs layer-ev' })
    })
  }

  /* road widths as dimension lines: observed when OpenStreetMap tags it, estimated when it is a class default */
  private buildWidths() {
    const seen = new Set<string>(), R = this.site!.twin.meta.radius_m, pc = this.polyColl('widths')
    const roads = this.site!.twin.roads.filter(r => r.cls !== 'walk' && r.name && r.pts.length > 1).sort((a, b) => polyLength(b.pts) - polyLength(a.pts))
    for (const r of roads) {
      if (seen.has(r.name!) || seen.size >= 8) continue
      const a = along(r.pts, polyLength(r.pts) / 2)
      if (Math.hypot(a.x, a.z) > R * .85) continue
      seen.add(r.name!)
      this.dimension(pc, a.x, a.z, a.dx, a.dz, r.width_m, r.width_source)
      this.ann.add('w-' + r.id, this.pos(a.x, a.z, 3), widthLabel(r.name!, r.width_m, r.width_source), { prio: 3, maxDist: 650, cls: (r.width_source === 'default' ? 'ann-est' : 'ann-obs') + ' layer-widths' })
    }
  }
  private dimension(pc: Cesium.PolylineCollection, x: number, z: number, dx: number, dz: number, w: number, source: string) {
    const nx = -dz, nz = dx, est = source === 'default', mat = est ? this.dashMat(COL.slate, .9, 8) : this.solid(COL.ice, .95)
    const A: XZ = [x + nx * w / 2, z + nz * w / 2], B: XZ = [x - nx * w / 2, z - nz * w / 2]
    pc.add({ positions: this.line3([A, B], .35), width: 2, material: mat })
    ;[A, B].forEach(p => pc.add({ positions: this.line3([[p[0] - dx * 1.8, p[1] - dz * 1.8], [p[0] + dx * 1.8, p[1] + dz * 1.8]], .35), width: 2, material: this.solid(est ? COL.slate : COL.ice, .95) }))
  }

  /* junctions: points for every node; hot spots get a pulsing disc (one primitive scaled by its matrix, no geometry rebuild) */
  private buildJunctions() {
    const pc = this.pointColl('junctions')
    this.junctions.forEach(j => {
      const hot = j.area, col = hot ? (hot.severity === 'high' ? COL.coral : COL.amber) : COL.cyan
      pc.add({ position: this.pos(j.x, j.z, 1.5), pixelSize: hot ? 11 : 6, color: C(col, hot ? .95 : .75), outlineColor: C('#020617', .9), outlineWidth: 2, disableDepthTestDistance: 3000, id: 'j:' + j.id })
      if (!hot) return
      const c = this.pos(j.x, j.z, .6)
      for (let k = 0; k < 2; k++) {
        const prim = this.addPrim('junctions', new Cesium.Primitive({
          geometryInstances: new Cesium.GeometryInstance({ geometry: new Cesium.EllipseGeometry({ center: c, semiMajorAxis: 1, semiMinorAxis: 1, height: this.groundAt(j.x, j.z) + .6 + k * .05, vertexFormat: Cesium.MaterialAppearance.MaterialSupport.BASIC.vertexFormat }) }),
          appearance: new Cesium.MaterialAppearance({ material: Cesium.Material.fromType('Color', { color: C(col, .3) }), translucent: true, flat: true, faceForward: true, materialSupport: Cesium.MaterialAppearance.MaterialSupport.BASIC }),
          asynchronous: false }))
        this.pulses.push({ prim, c, col: C(col), ph: j.id * .17 + k * .5, base: 14 })
      }
      this.ann.add('j-' + j.id, this.pos(j.x, j.z, 8), `<span class="ann-k">HOT SPOT ${hot.id} · SIMULATED</span><span class="ann-v">${esc(j.name)}</span><span class="ann-m">score ${hot.score} · ${hot.load_ratio}× capacity</span>`, { prio: 6 - hot.id * .1, maxDist: 2600, cls: 'ann-sim' })
    })
  }

  /* ---------- 3D infographics ---------- */
  /* load pillars: a glass column at every busy junction, its height the simulated peak load */
  private buildPillars() {
    const busy = this.junctions.filter(j => j.worst >= .85 || j.area)
    const insts = busy.map(j => {
      const h = 8 + j.worst * 42
      return new Cesium.GeometryInstance({ geometry: new Cesium.CylinderGeometry({ length: h, topRadius: 2.2, bottomRadius: 2.2, slices: 16, vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT }),
        modelMatrix: Cesium.Matrix4.multiplyByTranslation(Cesium.Transforms.eastNorthUpToFixedFrame(this.pos(j.x, j.z)), new Cesium.Cartesian3(0, 0, h / 2), new Cesium.Matrix4()),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(C(loadColor(j.worst), .3)) }, id: 'j:' + j.id })
    })
    if (insts.length) this.addPrim('pillars', new Cesium.Primitive({ geometryInstances: insts, appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }) }))
    const tops = this.polyColl('pillars')
    busy.forEach(j => tops.add({ positions: this.ring(j.x, j.z, 2.4, 8 + j.worst * 42, 24), width: 1.5, material: this.solid(loadColor(j.worst), .9) }))
  }

  /* sun-exposure hex map: share of daytime hours each patch of walkway sits in direct sun (computed) */
  private buildHexmap() {
    const site = this.site!, sh = site.twin.shade, n = sh.shape[1], per = n * n, c = sh.cell_m, R = site.twin.meta.radius_m
    const day = sh.sun.map((s, k) => s.el > 15 ? k : -1).filter(k => k >= 0)
    if (!day.length) return
    const size = 11, w = Math.sqrt(3) * size, items: { pts: XZ[]; base: number; col: Cesium.Color }[] = []
    for (let row = 0, z = -R; z <= R; row++, z += 1.5 * size) for (let x = -R + (row % 2) * w / 2; x <= R; x += w) {
      if (Math.hypot(x, z) > R) continue
      let tot = 0, sun = 0
      for (let dz = -size * .8; dz <= size * .8; dz += c) for (let dx = -size * .8; dx <= size * .8; dx += c) {
        const i = Math.floor((x + dx - sh.origin[0]) / c), j = Math.floor((z + dz - sh.origin[1]) / c)
        if (i < 0 || j < 0 || i >= n || j >= n || site.walk[j * n + i] !== 1) continue
        for (const k of day) { tot++; if (site.stack[k * per + j * n + i] === 255) sun++ }
      }
      if (tot < day.length * 4) continue
      const f = sun / tot
      const col = f > .7 ? C(COL.coral, .5) : f > .45 ? C(COL.amber, .45) : f > .2 ? C('#a3e635', .38) : C(COL.emerald, .38)
      const pts: XZ[] = []
      for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3; pts.push([x + Math.cos(a) * size * .92, z + Math.sin(a) * size * .92]) }
      items.push({ pts, base: this.tilesOn ? 0 : .25, col })
    }
    this.polygons('hexmap', items, this.tilesOn, true)
  }

  /* the sun's path over the site for the modelled day, the hours marked, and a ray from the sun to the ground */
  private buildSunpath() {
    const site = this.site!, sh = site.twin.shade, R = site.twin.meta.radius_m * .85
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(this.at(0, 0, this.groundAt(0, 0)))
    const P = (az: number, el: number) => Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(Math.sin(az) * Math.cos(el) * R, Math.cos(az) * Math.cos(el) * R, Math.sin(el) * R), new Cesium.Cartesian3())
    const pc = this.polyColl('sunpath'), lc = this.labelColl('sunpath'), pt = this.pointColl('sunpath'), arc: Cesium.Cartesian3[] = []
    for (let h = 0; h < sh.hours.length - 1; h++) for (let t = 0; t < 1; t += .2) {
      const a = sh.sun[h], b = sh.sun[h + 1], el = (a.el + (b.el - a.el) * t) * Math.PI / 180
      let daz = b.az - a.az; if (daz > 180) daz -= 360; if (daz < -180) daz += 360
      if (el > -.02) arc.push(P((a.az + daz * t) * Math.PI / 180, Math.max(0, el)))
    }
    if (arc.length > 1) pc.add({ positions: arc, width: 3, material: this.glow(COL.amber, .75, .2) })
    sh.hours.forEach((h, k) => {
      const s = sh.sun[k]
      if (s.el < 0) return
      const p = P(s.az * Math.PI / 180, s.el * Math.PI / 180)
      pt.add({ position: p, pixelSize: 4, color: C(COL.amber, .8) })
      lc.add({ position: p, text: String(h).padStart(2, '0'), font: '500 10px "JetBrains Mono", monospace', fillColor: C('#fde68a', .9), outlineColor: C('#020617', .9), outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -12), disableDepthTestDistance: Number.POSITIVE_INFINITY })
    })
    this.sunMark = pt.add({ position: arc[0] || this.pos(0, 0, R), pixelSize: 16, color: C('#fde68a'), outlineColor: C(COL.amber, .5), outlineWidth: 6 })
    this.sunRay = pc.add({ positions: [this.pos(0, 0, 1), this.pos(0, 0, 2)], width: 1.5, material: this.dashMat('#fde68a', .55, 12) })
    this.sunP = P
  }

  /* a bearing ring with ticks every 10 degrees and the cardinal points */
  private buildCompass() {
    this.clearGroup('compass')
    const R = (this.site ? this.site.twin.meta.radius_m : (this.ctx?.radius ?? 600) * .6) * 1.12, pc = this.polyColl('compass'), lc = this.labelColl('compass')
    pc.add({ positions: this.ring(0, 0, R, .5, 180), width: 1, material: this.solid(COL.cyan, .25) })
    for (let deg = 0; deg < 360; deg += 10) {
      const a = deg * Math.PI / 180, dx = Math.sin(a), dz = -Math.cos(a), L = deg % 90 === 0 ? 18 : deg % 30 === 0 ? 10 : 5
      pc.add({ positions: this.line3([[dx * R, dz * R], [dx * (R + L), dz * (R + L)]], .5), width: deg % 90 === 0 ? 2 : 1, material: this.solid(COL.cyan, deg % 30 === 0 ? .6 : .3) })
      if (deg % 30 === 0) lc.add({ position: this.pos(dx * (R + 34), dz * (R + 34), 1), text: deg % 90 === 0 ? 'NESW'[deg / 90] : String(deg), font: deg % 90 === 0 ? '600 14px Inter, sans-serif' : '500 10px "JetBrains Mono", monospace',
        fillColor: C(deg === 0 ? COL.coral : '#a5f3fc', deg % 90 === 0 ? 1 : .6), outlineColor: C('#020617', .9), outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6000) })
    }
  }

  /* ---------- sun and shade (computed) ---------- */
  private buildShade() {
    const sh = this.site!.twin.shade, n = sh.shape[1], w = n * sh.cell_m
    const nw = this.F.lonLat(sh.origin[0], sh.origin[1]), se = this.F.lonLat(sh.origin[0] + w, sh.origin[1] + w)
    this.shadeEnt = this.viewer.entities.add({ rectangle: { coordinates: Cesium.Rectangle.fromDegrees(nw[0], se[1], se[0], nw[1]), material: new Cesium.ImageMaterialProperty({ image: this.shadeCanvas(), transparent: true }) } })
    this.shadeEnt.show = this.layerOn.shade === true
  }
  setStacks(stack: Uint8Array, walk: Uint8Array) { this.stack = stack; this.walk = walk; if (this.layerOn.shade) this.refreshShade(); else this.shadeDirty = true }
  private refreshShade() { if (this.shadeEnt && this.shadeEnt.rectangle && this.site) this.shadeEnt.rectangle.material = new Cesium.ImageMaterialProperty({ image: this.shadeCanvas(), transparent: true }) }
  private shadeCanvas() {
    const site = this.site!, sh = site.twin.shade, n = sh.shape[1], cv = document.createElement('canvas'); cv.width = cv.height = n
    const ctx = cv.getContext('2d')!, img = ctx.createImageData(n, n), d = img.data, per = n * n, k = this.shadeHour
    const stack = this.stack || site.stack, walk = this.walk || site.walk
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 4, v = stack[k * per + j * n + i]
      if (walk[j * n + i] !== 1) continue
      if (v === 255) { d[o] = 251; d[o + 1] = 176; d[o + 2] = 60; d[o + 3] = 165 }
      else if (v === 90) { d[o] = 52; d[o + 1] = 211; d[o + 2] = 153; d[o + 3] = 165 }
      else if (v === 0) { d[o] = 56; d[o + 1] = 120; d[o + 2] = 220; d[o + 3] = 130 }
    }
    ctx.putImageData(img, 0, 0)
    return cv
  }

  setHourIndex(k: number) {
    this.shadeHour = k
    const site = this.site
    if (!site) return
    if (this.layerOn.shade) this.refreshShade(); else this.shadeDirty = true
    const s = site.twin.shade.sun[Math.min(k, site.twin.shade.sun.length - 1)], az = s.az * Math.PI / 180, el = s.el * Math.PI / 180
    const enu = new Cesium.Cartesian3(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el))
    const m = Cesium.Matrix4.getMatrix3(Cesium.Transforms.eastNorthUpToFixedFrame(this.pos(0, 0)), new Cesium.Matrix3())
    const sun = Cesium.Matrix3.multiplyByVector(m, enu, new Cesium.Cartesian3())
    this.viewer.scene.light = new Cesium.DirectionalLight({ direction: Cesium.Cartesian3.negate(Cesium.Cartesian3.normalize(sun, sun), new Cesium.Cartesian3()), intensity: s.el > 0 ? 2.2 : .4 })
    if (this.sunMark && this.sunP && this.sunRay) {
      const p = this.sunP(az, Math.max(0, el))
      this.sunMark.position = p; this.sunMark.show = s.el > 0
      this.sunRay.positions = [p, this.pos(0, 0, .5)]; this.sunRay.show = s.el > 0
    }
  }

  setLayer(k: LayerKey, on: boolean) {
    this.layerOn[k] = on
    ;(this.prims[k] || []).forEach(p => { p.show = on })
    if (k === 'buildings') for (const g of ['ctx-b', 'ctx-bld']) (this.prims[g] || []).forEach(p => { p.show = on })
    if (k === 'shade' && this.shadeEnt) { this.shadeEnt.show = on; if (on && this.shadeDirty) { this.shadeDirty = false; this.refreshShade() } }
    document.querySelectorAll<HTMLElement>('.layer-' + k).forEach(el => el.classList.toggle('ann-off', !on))
    this.ann.touch()
  }

  /* ---------- per frame: cheap updates only ---------- */
  private tick() {
    const now = performance.now(), dt = Math.min(.1, (now - this.last) / 1000)
    this.last = now; this.frameT = now
    const move = (list: Particle[], ped: boolean) => {
      for (const p of list) {
        if (!p.p.show) continue
        const kmh = ped ? p.v0 : p.v0 / (1 + .15 * Math.pow(p.r * (this.mul.get(p.linkId) ?? 1), 4))
        p.d += kmh / 3.6 * 2.2 * dt   // 2.2x time-lapse
        if (p.d > p.tr.len) p.d -= p.tr.len
        const f = (p.dir > 0 ? p.d : p.tr.len - p.d) / p.tr.step, i = Math.max(0, Math.min(p.tr.pos.length - 2, Math.floor(f)))
        p.p.position = Cesium.Cartesian3.lerp(p.tr.pos[i], p.tr.pos[i + 1], Math.max(0, Math.min(1, f - i)), this.scratch)
      }
    }
    if (this.layerOn.traffic !== false && this.parts.length) move(this.parts, false)
    if (this.layerOn.pedestrian !== false && this.walkers.length) move(this.walkers, true)
    for (const q of this.pulses) {
      const f = this.reduced ? .3 : ((now / 1000) * .5 + q.ph) % 1, s = q.base * (.5 + f * 1.6)
      q.prim.modelMatrix = Cesium.Matrix4.multiply(Cesium.Matrix4.fromTranslation(q.c), Cesium.Matrix4.multiply(Cesium.Matrix4.fromUniformScale(s), Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.negate(q.c, new Cesium.Cartesian3())), new Cesium.Matrix4()), new Cesium.Matrix4())
      const mat = (q.prim.appearance as Cesium.MaterialAppearance).material
      if (mat) mat.uniforms.color = q.col.withAlpha(.32 * (1 - f))
    }
    if (this.orbit && !this.reduced) {
      this.orbit.h += dt * .05
      this.viewer.camera.lookAt(this.orbit.c, new Cesium.HeadingPitchRange(this.orbit.h, this.orbit.p, this.orbit.r))
    }
    if (now - this.camT > 150) {
      this.camT = now
      const cam = this.viewer.camera, cp = cam.positionCartographic, sig = cam.heading.toFixed(3) + cp.height.toFixed(1) + cp.longitude.toFixed(7) + cp.latitude.toFixed(7)
      if (sig !== this.camSig) {
        this.camSig = sig
        const cv = this.viewer.scene.canvas, gp = cam.pickEllipsoid(new Cesium.Cartesian2(cv.clientWidth / 2, cv.clientHeight / 2))
        const mpp = cam.getPixelSize(new Cesium.BoundingSphere(gp || this.pos(0, 0), 1), cv.clientWidth, cv.clientHeight)
        const xz = this.F.xz(Cesium.Math.toDegrees(cp.longitude), Cesium.Math.toDegrees(cp.latitude))
        this.emit('camera', { heading: cam.heading, mpp, x: xz[0], z: xz[1] })
      }
    }
  }

  /* ---------- input: pick by id first, then by position against footprints, roads and trees ---------- */
  private wireInput() {
    const v = this.viewer, h = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    h.setInputAction((e: { position: Cesium.Cartesian2 }) => { this.onPick(this.pickAt(e.position, true)) }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    let last = 0
    h.setInputAction((e: { endPosition: Cesium.Cartesian2 }) => {
      const now = performance.now()
      if (now - last < 90) return
      last = now
      const p = Cesium.Cartesian2.clone(e.endPosition)
      requestAnimationFrame(() => {
        const s = this.pickAt(p, false)
        v.scene.canvas.style.cursor = s ? 'pointer' : ''
        this.emit('hover', s ? { label: this.describe(s), x: p.x, y: p.y } : null)
      })
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    const stop = () => this.stopOrbit()
    v.scene.canvas.addEventListener('pointerdown', stop)
    v.scene.canvas.addEventListener('wheel', stop, { passive: true })
  }

  private pickAt(p: Cesium.Cartesian2, deep: boolean): Selection {
    const hit = this.viewer.scene.pick(p)
    const id = hit && typeof hit.id === 'string' ? hit.id as string : null
    if (id) {
      const [k, v] = id.split(':'), n = +v
      if (k === 'j') return { kind: 'junction', id: n }
      if (k === 'b') return { kind: 'building', id: n }
      if (k === 'cb') return { kind: 'cbuilding', index: n }
      if (k === 'poi') return { kind: 'poi', index: n }
      if (k === 't') return { kind: 'tree', index: n }
      if (k === 's') return { kind: 'stop', index: n }
      if (k === 'e') return { kind: 'ev', index: n }
    }
    if (!deep) return null
    let w: Cesium.Cartesian3 | undefined
    try { w = this.viewer.scene.pickPositionSupported ? this.viewer.scene.pickPosition(p) : undefined } catch { w = undefined }
    w = w || this.viewer.camera.pickEllipsoid(p)
    if (!w) return null
    const cart = Cesium.Cartographic.fromCartesian(w)
    const [x, z] = this.F.xz(Cesium.Math.toDegrees(cart.longitude), Cesium.Math.toDegrees(cart.latitude))
    const tw = this.site?.twin
    if (tw) {
      const b = tw.buildings.find(b => inside(x, z, b.footprint))
      if (b) return { kind: 'building', id: b.id }
      let best: { id: number; d: number } | null = null
      for (const r of tw.roads) {
        if (r.cls === 'walk') continue
        for (let i = 1; i < r.pts.length; i++) { const d = segDist(x, z, r.pts[i - 1], r.pts[i]); if (d < r.width_m / 2 + 2 && (!best || d < best.d)) best = { id: r.id, d } }
      }
      if (best) return { kind: 'road', id: best.id }
      const ti = tw.trees.findIndex(t => dist(t.x, t.z, x, z) < t.crown_r)
      if (ti >= 0) return { kind: 'tree', index: ti }
    }
    if (this.ctx) { const ci = this.ctx.buildings.findIndex(b => inside(x, z, b.pts)); if (ci >= 0) return { kind: 'cbuilding', index: ci } }
    return null
  }

  describe(s: Selection): string {
    if (!s) return ''
    if (s.kind === 'cbuilding') { const b = this.ctx?.buildings[s.index]; return b ? `${b.name || 'Building'} · ${Math.round(b.h)} m${b.tagged ? '' : ' (est.)'}` : '' }
    if (s.kind === 'poi') { const p = this.ctx?.pois[s.index]; return p ? `${p.name || p.kind} · ${p.cat}` : '' }
    const tw = this.site?.twin
    if (!tw) return ''
    if (s.kind === 'junction') { const j = this.junctions.find(x => x.id === s.id); return j ? j.name : 'Junction' }
    if (s.kind === 'road') { const r = tw.roads.find(x => x.id === s.id); return r ? `${r.name || r.highway} · ${r.width_m} m` : 'Road' }
    if (s.kind === 'building') { const b = tw.buildings.find(x => x.id === s.id); return b ? `${b.name || 'Building'} · ${Math.round(b.height_m)} m` : 'Building' }
    if (s.kind === 'tree') { const t = tw.trees[s.index]; return t ? `Tree · ${t.height_m.toFixed(1)} m` : 'Tree' }
    if (s.kind === 'stop') return tw.stops[s.index]?.name || 'Bus stop'
    if (s.kind === 'ev') return tw.ev[s.index]?.name || 'EV charger'
    return ''
  }

  /* ---------- selection ---------- */
  clearSel() { this.sel.forEach(e => this.viewer.entities.remove(e)); this.sel = []; this.ann.clear('sel-') }
  select(s: Selection) {
    this.clearSel()
    if (!s) return
    const add = (o: Cesium.Entity.ConstructorOptions) => { const e = this.viewer.entities.add(o); this.sel.push(e); return e }
    const glow = (a = .85) => new Cesium.PolylineGlowMaterialProperty({ glowPower: .28, taperPower: 1, color: C(COL.cyan, a) })
    const box = (pts: XZ[], h: number) => {
      const c = centroid(pts), g = this.groundAt(c[0], c[1])
      add({ polygon: { hierarchy: new Cesium.PolygonHierarchy(pts.map(p => this.at(p[0], p[1], g))), height: g, extrudedHeight: g + h, material: C(COL.cyan, .2) } })
      add({ polyline: { positions: pts.concat([pts[0]]).map(p => this.at(p[0], p[1], g + h + .3)), width: 3, material: glow(1) } })
      return { c, g }
    }
    if (s.kind === 'cbuilding' || s.kind === 'poi') {
      const ctx = this.ctx
      if (!ctx) return
      if (s.kind === 'cbuilding') { const b = ctx.buildings[s.index]; if (b) { const { c, g } = box(b.pts, b.h); this.ann.add('sel-cb', this.at(c[0], c[1], g + b.h + 4), `<span class="ann-k">HEIGHT · ${b.tagged ? 'OSM TAG' : 'ESTIMATED FROM TYPE'}</span><span class="ann-v">${b.h.toFixed(1)} m</span>`, { prio: 10, maxDist: 5000, cls: (b.tagged ? 'ann-obs' : 'ann-est') + ' ann-sel' }) } }
      else { const p = ctx.pois[s.index]; if (p) add({ polyline: { positions: this.ring(p.x, p.z, 9), width: 2, material: C(POI_COL[p.cat], .95) } }) }
      return
    }
    const tw = this.site?.twin
    if (!tw) return
    if (s.kind === 'junction') {
      const j = this.junctions.find(x => x.id === s.id)
      if (!j) return
      add({ polyline: { positions: [this.pos(j.x, j.z), this.pos(j.x, j.z, 70)], width: 10, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: .15, taperPower: .4, color: C(COL.cyan, .8) }) } })
      add({ polyline: { positions: this.ring(j.x, j.z, 26), width: 2, material: C(COL.cyan, .9) } })
      add({ polyline: { positions: this.ring(j.x, j.z, 40), width: 1, material: new Cesium.PolylineDashMaterialProperty({ color: C(COL.cyan, .5), dashLength: 12 }) } })
      tw.traffic?.links.filter(l => j.links.includes(l.id)).forEach(l => add({ polyline: { positions: this.line3(l.pts, .8), width: 7, material: glow(.6) } }))
    } else if (s.kind === 'road') {
      const r = tw.roads.find(x => x.id === s.id)
      if (!r) return
      add({ polyline: { positions: this.line3(r.pts, .8), width: 8, material: glow() } })
      const a = along(r.pts, polyLength(r.pts) / 2), nx = -a.dz, nz = a.dx, w = r.width_m
      const A: XZ = [a.x + nx * w / 2, a.z + nz * w / 2], B: XZ = [a.x - nx * w / 2, a.z - nz * w / 2]
      add({ polyline: { positions: this.line3([A, B], .9), width: 2.5, material: C(COL.ice) } })
      ;[A, B].forEach(p => add({ polyline: { positions: this.line3([[p[0] - a.dx * 2, p[1] - a.dz * 2], [p[0] + a.dx * 2, p[1] + a.dz * 2]], .9), width: 2.5, material: C(COL.ice) } }))
      this.ann.add('sel-w', this.pos(a.x, a.z, 4), widthLabel(r.name || r.highway, r.width_m, r.width_source), { prio: 10, maxDist: 5000, cls: r.width_source === 'default' ? 'ann-est ann-sel' : 'ann-obs ann-sel' })
    } else if (s.kind === 'building') {
      const b = tw.buildings.find(x => x.id === s.id)
      if (!b) return
      const { c, g } = box(b.footprint, b.height_m)
      this.ann.add('sel-b', this.at(c[0], c[1], g + b.height_m + 4), `<span class="ann-k">HEIGHT · ${b.height_source === 'default' ? 'ASSUMED' : b.height_source === 'lidar' ? 'LIDAR' : 'OSM'}</span><span class="ann-v">${b.height_m.toFixed(1)} m</span>`, { prio: 10, maxDist: 5000, cls: b.height_source === 'default' ? 'ann-est ann-sel' : 'ann-obs ann-sel' })
    } else if (s.kind === 'tree' || s.kind === 'stop' || s.kind === 'ev') {
      const p = s.kind === 'tree' ? tw.trees[s.index] : s.kind === 'stop' ? tw.stops[s.index] : tw.ev[s.index]
      if (!p) return
      add({ polyline: { positions: this.ring(p.x, p.z, s.kind === 'tree' ? Math.max(3, (p as { crown_r?: number }).crown_r || 3) + 1.5 : 8), width: 2, material: C(s.kind === 'tree' ? COL.emerald : COL.cyan, .95) } })
    }
  }

  /* ---------- camera ---------- */
  stopOrbit() { if (this.orbit) { this.orbit = null; this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY) } }
  fly(x: number, z: number, range: number, heading: number, pitch: number, orbit = false, dur = 2.4) {
    this.stopOrbit()
    const c = this.pos(x, z, 2)
    this.viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(c, 1), {
      offset: new Cesium.HeadingPitchRange(heading, pitch, range), duration: this.reduced ? 0 : dur, easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
      complete: () => { if (orbit && !this.reduced) this.orbit = { c, h: heading, p: pitch, r: range } },
    })
  }
  flyToJunction(j: { x: number; z: number }) { this.fly(j.x, j.z, 210, this.viewer.camera.heading + .5, -.52, true, 2.6) }
  focus(x: number, z: number, range = 160) { this.fly(x, z, range, this.viewer.camera.heading + .25, -.6, false, 1.8) }
  preset(p: Preset, instant = false) {
    const R = this.site ? this.site.twin.meta.radius_m : (this.ctx?.radius ?? 600) * .7
    if (p === 'aerial') this.fly(0, 0, R * 3.1, 0, -Math.PI / 2 + .001, false, instant ? 0 : 2.4)
    else if (p === 'isometric') this.fly(0, 0, R * 2.4, Math.PI / 4, -.6, !instant, instant ? 0 : 2.4)
    else {
      this.stopOrbit()
      const lines: XZ[][] = this.site ? this.site.twin.roads.filter(x => x.cls === 'main' || x.cls === 'mid').map(r => r.pts) : (this.ctx?.roads.filter(r => r.cls === 'major' || r.cls === 'mid').map(r => r.pts) ?? [])
      const r = lines.sort((a, b) => polyLength(b) - polyLength(a))[0]
      if (!r) return
      const L = polyLength(r), a = along(r, Math.min(L * .3, 120)), g = this.F.lonLat(a.x - a.dz * 4, a.z + a.dx * 4)
      this.viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(g[0], g[1], this.groundAt(a.x, a.z) + 1.8), orientation: { heading: Math.atan2(a.dx, -a.dz), pitch: -.04, roll: 0 }, duration: this.reduced ? 0 : 3.2, easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT })
    }
  }
  flyToLonLat(lon: number, lat: number) { this.stopOrbit(); this.viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, lat, 1600), orientation: { heading: 0, pitch: -.8, roll: 0 }, duration: this.reduced ? 0 : 3 }) }
  flyToXZ(x: number, z: number) { const c = this.viewer.camera; this.fly(x, z, Math.min(900, Math.max(180, c.positionCartographic.height * 1.3)), c.heading, Math.min(-.35, c.pitch), false, 1.6) }
  resetNorth() { const c = this.viewer.camera; this.stopOrbit(); c.flyTo({ destination: c.positionWC.clone(), orientation: { heading: 0, pitch: c.pitch, roll: 0 }, duration: .8 }) }

  /* ---------- Analyze: a scan sweeps the junction, then context lights up in turn ---------- */
  clearFx() { this.fx.forEach(e => this.viewer.entities.remove(e)); this.fx = []; this.ann.clear('fx-') }
  scan(j: Junction): Promise<void> {
    this.clearFx()
    const t0 = performance.now(), R = 160, add = (o: Cesium.Entity.ConstructorOptions) => { const e = this.viewer.entities.add(o); this.fx.push(e); return e }
    const k = () => Math.min(1, (performance.now() - t0) / 2400)
    add({ polyline: { positions: new Cesium.CallbackProperty(() => this.ring(j.x, j.z, Math.max(1, R * k()), 1, 72), false), width: 3, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: .3, color: new Cesium.CallbackProperty(() => C(COL.cyan, .9 * (1 - k() * .7)), false) }) } })
    add({ polyline: { positions: new Cesium.CallbackProperty(() => { const a = k() * Math.PI * 4; return [this.pos(j.x, j.z, 1), this.pos(j.x + Math.cos(a) * R, j.z + Math.sin(a) * R, 1)] }, false), width: 4,
      material: new Cesium.PolylineGlowMaterialProperty({ glowPower: .25, color: new Cesium.CallbackProperty(() => C(COL.cyan, k() < 1 ? .8 : 0), false) }) } })
    const tw = this.site!.twin, after = (ms: number, f: () => void) => setTimeout(f, this.reduced ? 0 : ms)
    after(700, () => tw.traffic?.links.filter(l => l.pts.some(p => dist(p[0], p[1], j.x, j.z) < R)).forEach(l => add({ polyline: { positions: this.line3(l.pts, 1), width: 5, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: .3, color: C(COL.cyan, .55) }) } })))
    after(1300, () => tw.trees.filter(t => dist(t.x, t.z, j.x, j.z) < R).forEach(t => add({ polyline: { positions: this.ring(t.x, t.z, t.crown_r + 1, .5, 16), width: 1.5, material: C(COL.emerald, .7) } })))
    after(1900, () => [...tw.stops, ...tw.crossings].filter(s => dist(s.x, s.z, j.x, j.z) < R).forEach(s => add({ polyline: { positions: this.ring(s.x, s.z, 4, .4, 24), width: 1.5, material: C(COL.cyan, .7) } })))
    const mine = ++this.scanId
    after(4200, () => { if (mine !== this.scanId) return; this.fx.forEach(e => this.viewer.entities.remove(e)); this.fx = [] })
    return new Promise(res => after(2600, () => res()))
  }
  showFindings(list: { id: string; title: string; basis: string; at: XZ }[]) {
    this.ann.clear('fx-')
    list.forEach((f, i) => this.ann.add('fx-' + f.id, this.pos(f.at[0], f.at[1], 6), `<span class="ann-k">FINDING ${i + 1} · ${f.basis.toUpperCase()}</span><span class="ann-v">${esc(f.title)}</span>`, { prio: 9, maxDist: 4000, cls: 'ann-' + f.basis.slice(0, 3) + ' ann-sel' }))
  }

  /* ---------- Simulate: proposals appear in a wave from the junction ---------- */
  clearProposals() { this.prop.forEach(e => this.viewer.entities.remove(e)); this.prop = []; this.ann.clear('prop-'); this.mul.clear() }
  proposals(j: Junction, recs: Rec[], on: boolean) {
    this.clearProposals()
    if (!on || !this.site) return
    const tw = this.site.twin, items: { e: Cesium.Entity; d: number }[] = []
    const V = (a = .6) => C(COL.violet, a)
    const add = (o: Cesium.Entity.ConstructorOptions, x: number, z: number) => { const e = this.viewer.entities.add(o); e.show = false; this.prop.push(e); items.push({ e, d: dist(x, z, j.x, j.z) }); return e }
    const dash = () => new Cesium.PolylineDashMaterialProperty({ color: V(.9), dashLength: 12 })
    for (const r of recs) {
      const link = r.sol ? tw.traffic?.links.find(l => l.id === r.sol!.link_id) : undefined
      if (r.sol) { const ratio = r.sol.area_load_after / Math.max(.01, r.sol.area_load_before); j.links.forEach(id => this.mul.set(id, ratio)); if (link) this.mul.set(link.id, ratio) }
      if (r.kind === 'bus_lane' && link) {
        const w = 2 + 3.2 * link.lanes * 2, strip = offsetLine(link.pts, w / 2 - 1.7)
        add({ corridor: { positions: this.flat(strip), width: 3.4, material: V(.55) } }, link.pts[0][0], link.pts[0][1])
        ;[-1.7, 1.7].forEach(o => add({ polyline: { positions: this.line3(offsetLine(strip, o), .5), width: 2, material: dash() } }, link.pts[0][0], link.pts[0][1]))
        this.propLabel('bus', link.pts, 'PROPOSED BUS LANE', r)
      } else if (r.kind === 'signal_retiming') {
        ;[[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([a, b], i) => {
          const x = j.x + a * 10, z = j.z + b * 10
          add({ position: this.pos(x, z, 3), cylinder: { length: 6, topRadius: .2, bottomRadius: .25, material: V(.7) } }, x, z)
          add({ position: this.pos(x, z, 6.4), point: { pixelSize: 12, outlineColor: C('#0b1020'), outlineWidth: 2, color: new Cesium.CallbackProperty(() => { const p = (this.frameT / 1000 + (i % 2) * 3) % 6; return C(p < 2.6 ? COL.emerald : p < 3 ? COL.amber : COL.coral) }, false) } }, x, z)
        })
        this.ann.add('prop-sig', this.pos(j.x, j.z, 12), propHtml('SIGNAL CONTROL', r), { prio: 8.5, maxDist: 3000, cls: 'ann-pro ann-sel' })
      } else if (r.kind === 'foot_overbridge' && link) {
        const m = along(link.pts, polyLength(link.pts) / 2), nx = -m.dz, nz = m.dx, w = 2 + 3.2 * link.lanes * 2 + 14, g = this.groundAt(m.x, m.z)
        const quad = (cx: number, cz: number, ux: number, uz: number, hl: number, hw: number) => new Cesium.PolygonHierarchy([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => this.at(cx + ux * hl * s - uz * hw * t, cz + uz * hl * s + ux * hw * t, g)))
        add({ polygon: { hierarchy: quad(m.x, m.z, nx, nz, w / 2, 1.8), height: g + 6.4, extrudedHeight: g + 7.4, material: V(.5), outline: true, outlineColor: V(1) } }, m.x, m.z)
        ;[-1, 1].forEach(sg => add({ polygon: { hierarchy: quad(m.x + nx * sg * w / 2, m.z + nz * sg * w / 2, nx, nz, 2, 2), height: g, extrudedHeight: g + 7.4, material: V(.4), outline: true, outlineColor: V(1) } }, m.x, m.z))
        this.ann.add('prop-bridge', this.pos(m.x, m.z, 10), propHtml('FOOT OVERBRIDGE', r), { prio: 8.5, maxDist: 3000, cls: 'ann-pro ann-sel' })
      } else if (r.kind === 'route_diversion' && link) {
        const rt = routeAround(this.site, link.id)
        if (rt?.detour) {
          rt.detour.links.forEach(l => add({ polyline: { positions: this.line3(l.pts, 1), width: 6, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: .25, color: V(.85) }) } }, l.pts[0][0], l.pts[0][1]))
          const mid = rt.detour.links[Math.floor(rt.detour.links.length / 2)].pts[0]
          this.ann.add('prop-alt', this.pos(mid[0], mid[1], 6), `<span class="ann-k">ALTERNATIVE ROUTE · SIMULATED</span><span class="ann-v">${(rt.detour.t / 60).toFixed(1)} min</span><span class="ann-m">direct ${(rt.direct / 60).toFixed(1)} min at peak load</span>`, { prio: 8.5, maxDist: 3000, cls: 'ann-pro ann-sel' })
        }
        this.propLabel('div', link.pts, 'DIVERSION SIGNS', r)
      } else if (r.kind === 'add_lane' && link) {
        const w = 2 + 3.2 * link.lanes * 2
        add({ corridor: { positions: this.flat(offsetLine(link.pts, w / 2 + 1.7)), width: 3.4, material: V(.45) } }, link.pts[0][0], link.pts[0][1])
        this.propLabel('lane', link.pts, 'EXTRA LANE', r)
      } else if (r.kind === 'trees' && r.trees) {
        r.trees.forEach(t => {
          const g = this.groundAt(t.x, t.z), cy = t.height_m - t.crown_r * .85
          add({ position: this.at(t.x, t.z, g + cy), ellipsoid: { radii: new Cesium.Cartesian3(t.crown_r, t.crown_r, t.crown_r * .85), material: C('#99f6e4', .5), stackPartitions: 8, slicePartitions: 10 } }, t.x, t.z)
        })
        const near = [...r.trees].sort((a, b) => dist(a.x, a.z, j.x, j.z) - dist(b.x, b.z, j.x, j.z))[0]
        if (near) this.ann.add('prop-trees', this.pos(near.x, near.z, 10), propHtml('NEW STREET TREES', r), { prio: 8, maxDist: 3000, cls: 'ann-pro ann-sel' })
      } else if (r.kind === 'crossing' && r.crossing) {
        const c = r.crossing, nx = -c.dz, nz = c.dx
        for (let k = -c.w / 2 + .6; k < c.w / 2 - .4; k += 1.1) {
          const x = c.x + nx * k, z = c.z + nz * k
          add({ polygon: { hierarchy: new Cesium.PolygonHierarchy([[-1.5, -.25], [1.5, -.25], [1.5, .25], [-1.5, .25]].map(([a, b]) => { const p = this.F.lonLat(x + c.dx * a + nx * b, z + c.dz * a + nz * b); return Cesium.Cartesian3.fromDegrees(p[0], p[1]) })), material: C('#f5f3ff', .92) } }, x, z)
        }
        const bx: XZ[] = [[-2.2, -c.w / 2], [2.2, -c.w / 2], [2.2, c.w / 2], [-2.2, c.w / 2], [-2.2, -c.w / 2]].map(([a, b]) => [c.x + c.dx * a + nx * b, c.z + c.dz * a + nz * b])
        add({ polyline: { positions: this.line3(bx, .5), width: 2, material: dash() } }, c.x, c.z)
        this.ann.add('prop-cross', this.pos(c.x, c.z, 6), propHtml('PROTECTED CROSSING', r), { prio: 8.5, maxDist: 3000, cls: 'ann-pro ann-sel' })
      } else if (r.kind === 'ev' && r.ev) {
        r.ev.forEach((p, i) => {
          add({ position: this.pos(p[0], p[1], 2), cylinder: { length: 4, topRadius: .7, bottomRadius: .7, material: V(.75) } }, p[0], p[1])
          add({ position: this.pos(p[0], p[1]), ellipse: { semiMajorAxis: 7, semiMinorAxis: 7, material: V(.25) } }, p[0], p[1])
          this.ann.add('prop-ev' + i, this.pos(p[0], p[1], 7), propHtml('EV CANDIDATE ' + (i + 1), r), { prio: 7, maxDist: 3000, cls: 'ann-pro ann-sel' })
        })
      }
    }
    const t0 = performance.now(), span = this.reduced ? 0 : 1600, max = Math.max(1, ...items.map(i => i.d))
    const step = () => {
      const k = span ? (performance.now() - t0) / span : 1
      items.forEach(i => { if (!i.e.show && i.d / max <= k) i.e.show = true })
      if (k < 1) requestAnimationFrame(step)
    }
    step()
  }
  private propLabel(id: string, pts: XZ[], title: string, r: Rec) {
    const m = along(pts, polyLength(pts) / 2)
    this.ann.add('prop-' + id, this.pos(m.x, m.z, 6), propHtml(title, r), { prio: 8.5, maxDist: 3000, cls: 'ann-pro ann-sel' })
  }

  linkById(id: number): TrafficLink | undefined { return this.site?.twin.traffic?.links.find(l => l.id === id) }
  destroy() { this.viewer.destroy() }
}

/* ---------- helpers ---------- */
function esc(s: string) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)) }
function widthLabel(name: string, w: number, src: string) {
  const s = src === 'osm_width' ? 'OBSERVED · OSM WIDTH TAG' : src === 'lanes' ? 'ESTIMATED · FROM LANE COUNT' : 'ESTIMATED · CLASS DEFAULT'
  return `<span class="ann-k">${s}</span><span class="ann-v">${w.toFixed(1)} m</span><span class="ann-m">${esc(name)}</span>`
}
function propHtml(title: string, r: Rec) {
  return `<span class="ann-k">PROPOSED · ${r.basis.toUpperCase()}</span><span class="ann-v">${title}</span>${r.effect ? `<span class="ann-m">${esc(r.effect)}</span>` : ''}`
}
function inside(x: number, z: number, f: XZ[]) { let c = false; for (let i = 0, j = f.length - 1; i < f.length; j = i++) { const a = f[i], b = f[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c } return c }
function segDist(x: number, z: number, a: XZ, b: XZ) { const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2)); return Math.hypot(a[0] + ex * t - x, a[1] + ez * t - z) }
const iconCache = new Map<PoiCat, HTMLCanvasElement>()
function poiIcon(cat: PoiCat) {
  if (iconCache.has(cat)) return iconCache.get(cat)!
  const cv = document.createElement('canvas'); cv.width = cv.height = 36
  const g = cv.getContext('2d')!, col = POI_COL[cat]
  g.fillStyle = 'rgba(3,7,12,.88)'; g.beginPath(); g.arc(18, 18, 15, 0, 7); g.fill()
  g.strokeStyle = col; g.lineWidth = 2.5; g.stroke()
  g.fillStyle = col; g.font = '700 15px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(POI_GLYPH[cat], 18, 19)
  iconCache.set(cat, cv)
  return cv
}
