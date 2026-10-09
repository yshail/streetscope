import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { Selection, Site, TrafficLink, XZ } from '../lib/types'
import { Frame, along, centroid, dist, offsetLine, polyLength } from '../lib/geo'
import { type Junction, type Rec, routeAround, speedKmh } from '../lib/model'
import { Annotations } from './annotations'

export type LayerKey = 'traffic' | 'congestion' | 'pedestrian' | 'shade' | 'trees' | 'transit' | 'ev' | 'widths' | 'buildings'
export type Preset = 'aerial' | 'isometric' | 'street'

/* Palette: cyan = structure and selection, emerald = environment, amber -> coral = congestion, violet = proposals */
const C = (css: string, a = 1) => Cesium.Color.fromCssColorString(css).withAlpha(a)
export const COL = {
  cyan: '#22d3ee', ice: '#cffafe', emerald: '#34d399', amber: '#fbbf24', coral: '#fb7185', violet: '#a78bfa', slate: '#64748b',
}
export const loadColor = (r: number) => r >= 1 ? COL.coral : r >= .85 ? '#fb923c' : r >= .6 ? COL.amber : COL.cyan

interface Particle { pts: XZ[]; len: number; d: number; dir: number; lane: number; cls: string; r: number; linkId: number; p: Cesium.PointPrimitive }

export class CityScene {
  viewer: Cesium.Viewer
  ann: Annotations
  site: Site | null = null
  F: Frame = new Frame(0, 0)
  tilesOn = false
  reduced = false
  private tileset: Cesium.Cesium3DTileset | null = null
  private hgrid: Float32Array | null = null
  private hn = 48
  private layers: Record<string, Cesium.Entity[]> = {}
  private layerOn: Record<string, boolean> = {}
  private pickMap = new WeakMap<object, Selection>()
  private sel: Cesium.Entity[] = []
  private hov: Cesium.Entity[] = []
  private prop: Cesium.Entity[] = []
  private fx: Cesium.Entity[] = []
  private flow: Cesium.PointPrimitiveCollection
  private peds: Cesium.PointPrimitiveCollection
  private parts: Particle[] = []
  private walkers: Particle[] = []
  private mul = new Map<number, number>()
  private orbit: { c: Cesium.Cartesian3; h: number; p: number; r: number } | null = null
  private last = performance.now()
  private shadeHour = 0
  private shadeEnt: Cesium.Entity | null = null
  junctions: Junction[] = []
  onPick: (s: Selection) => void = () => {}
  onHover: (h: { label: string; x: number; y: number } | null) => void = () => {}
  onCamera: (heading: number, metresPerPx: number) => void = () => {}

  constructor(el: HTMLElement, creditEl: HTMLElement, annEl: HTMLElement) {
    this.viewer = new Cesium.Viewer(el, {
      baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
        url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', maximumLevel: 16,
        credit: new Cesium.Credit('Basemap: Esri, HERE, Garmin, © OpenStreetMap contributors'),
      })),
      animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, fullscreenButton: false, infoBox: false, selectionIndicator: false, creditContainer: creditEl,
      msaaSamples: 4, useBrowserRecommendedResolution: true,
    })
    const base = this.viewer.imageryLayers.get(0); base.brightness = .55; base.contrast = 1.25; base.saturation = .6
    const s = this.viewer.scene
    s.globe.baseColor = C('#05080d')
    s.backgroundColor = C('#03060a')
    s.globe.showGroundAtmosphere = false
    s.globe.depthTestAgainstTerrain = false
    s.fog.enabled = true
    s.screenSpaceCameraController.maximumZoomDistance = 25000
    s.screenSpaceCameraController.minimumZoomDistance = 2
    this.ann = new Annotations(s, annEl)
    this.flow = s.primitives.add(new Cesium.PointPrimitiveCollection())
    this.peds = s.primitives.add(new Cesium.PointPrimitiveCollection())
    this.darkLook(true)
    s.preRender.addEventListener(() => this.tick())
    this.wireInput()
  }

  private darkLook(dark: boolean) {
    const s = this.viewer.scene
    s.skyAtmosphere.show = !dark
    if (s.skyBox) s.skyBox.show = !dark
    if (s.sun) s.sun.show = !dark
    if (s.moon) s.moon.show = false
    s.fog.enabled = !dark
    const bloom = s.postProcessStages.bloom
    bloom.enabled = dark
    Object.assign(bloom.uniforms, { glowOnly: false, contrast: 128, brightness: -.32, delta: 1, sigma: 2.2, stepSize: 1 })
  }

  /* ---------- Google Photorealistic 3D Tiles (display only) ---------- */
  async setTiles(key: string): Promise<string | null> {
    if (this.tileset) { this.viewer.scene.primitives.remove(this.tileset); this.tileset = null }
    if (!key) { this.tilesOn = false; this.viewer.scene.globe.show = true; this.darkLook(true); await this.groundAndRebuild(); return null }
    try {
      if (key.startsWith('eyJ')) { Cesium.Ion.defaultAccessToken = key; this.tileset = await Cesium.createGooglePhotorealistic3DTileset() }
      else this.tileset = await Cesium.createGooglePhotorealistic3DTileset({ key, onlyUsingWithGoogleGeocoder: true })
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

  /* ---------- ground heights under the overlays (tiles are on the ellipsoid's real height; the dark map is at 0) ---------- */
  private async groundAndRebuild() {
    this.hgrid = null
    if (this.tilesOn && this.site) {
      const R = this.site.twin.meta.radius_m, pts: XZ[] = [[0, 0]]
      this.site.twin.roads.forEach(r => {
        if (r.cls === 'walk' || r.bridge) return
        const L = polyLength(r.pts)
        for (let d = 0; d < L; d += 20) { const a = along(r.pts, d); if (Math.hypot(a.x, a.z) < R * 1.1) pts.push([a.x, a.z]) }
      })
      const sample = pts.filter((_, i) => i % Math.max(1, Math.ceil(pts.length / 700)) === 0)
      try {
        const got = await this.viewer.scene.sampleHeightMostDetailed(sample.map(p => { const g = this.F.lonLat(p[0], p[1]); return Cesium.Cartographic.fromDegrees(g[0], g[1]) }))
        const ok = got.map((c, i) => ({ x: sample[i][0], z: sample[i][1], h: c && Number.isFinite(c.height) ? c.height : NaN })).filter(s => Number.isFinite(s.h))
        // drop samples on roofs, bridges or trees: more than 4 m above the local median
        const clean = ok.filter(s => {
          const nb = ok.filter(o => dist(o.x, o.z, s.x, s.z) < 90).map(o => o.h).sort((a, b) => a - b)
          return s.h <= nb[nb.length >> 1] + 4
        })
        if (clean.length > 5) {
          const n = this.hn, g = new Float32Array(n * n), span = R * 2.4
          for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const x = -span / 2 + (i + .5) * span / n, z = -span / 2 + (j + .5) * span / n
            const near = clean.map(s => ({ d: dist(s.x, s.z, x, z), h: s.h })).sort((a, b) => a.d - b.d).slice(0, 8)
            let w = 0, a = 0
            near.forEach(s => { const k = 1 / Math.max(1, s.d) ** 2; w += k; a += k * s.h })
            g[j * n + i] = a / w
          }
          this.hgrid = g
        }
      } catch { /* heights stay flat at 0 if sampling is not available */ }
    }
    this.rebuild()
  }

  groundAt(x: number, z: number) {
    if (!this.hgrid || !this.site) return 0
    const n = this.hn, span = this.site.twin.meta.radius_m * 2.4
    const fx = Math.min(n - 1.001, Math.max(0, (x + span / 2) / span * n - .5)), fz = Math.min(n - 1.001, Math.max(0, (z + span / 2) / span * n - .5))
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, g = this.hgrid
    return (g[j * n + i] * (1 - tx) + g[j * n + i + 1] * tx) * (1 - tz) + (g[(j + 1) * n + i] * (1 - tx) + g[(j + 1) * n + i + 1] * tx) * tz
  }

  pos(x: number, z: number, up = 0) { const g = this.F.lonLat(x, z); return Cesium.Cartesian3.fromDegrees(g[0], g[1], this.groundAt(x, z) + up) }
  private flat(pts: XZ[]) { const out: number[] = []; pts.forEach(p => { const g = this.F.lonLat(p[0], p[1]); out.push(g[0], g[1]) }); return Cesium.Cartesian3.fromDegreesArray(out) }
  private ring(x: number, z: number, r: number, up = .4, n = 64) { const out: Cesium.Cartesian3[] = []; for (let i = 0; i <= n; i++) { const a = i / n * Math.PI * 2; out.push(this.pos(x + Math.cos(a) * r, z + Math.sin(a) * r, up)) } return out }

  /* ---------- site ---------- */
  async loadSite(site: Site, junctions: Junction[]) {
    this.site = site; this.junctions = junctions
    this.F = new Frame(site.twin.meta.center.lat, site.twin.meta.center.lon)
    await this.groundAndRebuild()
    this.preset('isometric', true)
  }

  private add(group: string, o: Cesium.Entity.ConstructorOptions, pick?: Selection) {
    const e = this.viewer.entities.add(o)
    ;(this.layers[group] ||= []).push(e)
    if (pick) this.pickMap.set(e, pick)
    e.show = this.layerOn[group] !== false
    return e
  }

  private clearGroup(group: string) { (this.layers[group] || []).forEach(e => this.viewer.entities.remove(e)); this.layers[group] = [] }

  rebuild() {
    const site = this.site
    if (!site) return
    const ents = this.viewer.entities
    ents.suspendEvents()
    Object.keys(this.layers).forEach(k => this.clearGroup(k))
    this.ann.clear('')
    this.clearSel(); this.clearHover(); this.clearProposals(); this.clearFx()
    this.buildBase(); this.buildBuildings(); this.buildTraffic(); this.buildPedestrians(); this.buildTrees(); this.buildTransit(); this.buildEv(); this.buildWidths(); this.buildJunctions(); this.buildShade()
    ents.resumeEvents()
    this.setHourIndex(this.shadeHour)
  }

  /* study boundary and a faint metric grid: coordinate detail used sparingly */
  private buildBase() {
    const R = this.site!.twin.meta.radius_m
    this.add('base', { polyline: { positions: this.ring(0, 0, R, .3, 128), width: 1.2, material: new Cesium.PolylineDashMaterialProperty({ color: C(COL.cyan, .35), dashLength: 18 }) } })
    this.ann.add('base-r', this.pos(R * .707, -R * .707, 2), `<span class="ann-k">STUDY AREA</span><span class="ann-v">R ${Math.round(R)} m</span>`, { prio: 0, maxDist: 6000, cls: 'ann-quiet' })
    if (!this.tilesOn) {
      for (let v = -Math.floor(R / 100) * 100; v <= R; v += 100) {
        const h = Math.sqrt(Math.max(0, R * R - v * v))
        this.add('base', { polyline: { positions: [this.pos(v, -h, .2), this.pos(v, h, .2)], width: 1, material: C(COL.cyan, .05) } })
        this.add('base', { polyline: { positions: [this.pos(-h, v, .2), this.pos(h, v, .2)], width: 1, material: C(COL.cyan, .05) } })
      }
      this.site!.twin.roads.forEach(r => {
        if (r.pts.length < 2) return
        this.add('base', { corridor: { positions: this.flat(r.pts), width: r.cls === 'walk' ? 2.2 : r.width_m, material: C(r.cls === 'walk' ? '#1e2a36' : '#141d27', .95) } },
          r.cls !== 'walk' ? { kind: 'road', id: r.id } : undefined)
      })
    } else {
      // pick targets only: the photoreal tiles show the real roads
      this.site!.twin.roads.forEach(r => {
        if (r.pts.length < 2 || r.cls === 'walk') return
        this.add('base', { corridor: { positions: this.flat(r.pts), width: r.width_m, material: C('#000000', .01) } }, { kind: 'road', id: r.id })
      })
    }
  }

  private buildBuildings() {
    const tw = this.site!.twin
    tw.buildings.forEach(b => {
      const c = centroid(b.footprint), g = this.groundAt(c[0], c[1]), measured = b.height_source !== 'default'
      const hier = new Cesium.PolygonHierarchy(b.footprint.map(p => Cesium.Cartesian3.fromDegrees(...this.F.lonLat(p[0], p[1]), g)))
      if (this.tilesOn) {
        this.add('buildings', { polygon: { hierarchy: hier, height: g, extrudedHeight: g + b.height_m, material: C('#ffffff', .012) } }, { kind: 'building', id: b.id })
      } else {
        this.add('buildings', { polygon: { hierarchy: hier, height: 0, extrudedHeight: b.height_m, material: C(measured ? '#0f1b27' : '#151b22', .93) } }, { kind: 'building', id: b.id })
        const top = b.footprint.concat([b.footprint[0]]).map(p => Cesium.Cartesian3.fromDegrees(...this.F.lonLat(p[0], p[1]), b.height_m + .2))
        this.add('buildings', { polyline: { positions: top, width: 1, material: C(measured ? COL.cyan : COL.slate, measured ? .32 : .22) } })
      }
    })
  }

  /* ---------- traffic: glowing links sized by volume, particles that slow down past capacity (simulated) ---------- */
  private buildTraffic() {
    const tr = this.site!.twin.traffic
    this.flow.removeAll(); this.parts = []
    if (!tr) return
    tr.links.forEach(l => {
      if (l.pts.length < 2) return
      const w = 1.5 + 3.2 * Math.min(l.r, 1.4)
      this.add('traffic', { polyline: { positions: this.flat(l.pts), width: w, clampToGround: true, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: .25, taperPower: 1, color: C(loadColor(l.r), .55 + .35 * Math.min(1, l.r)) }) } })
      if (l.r >= .85) this.add('congestion', { corridor: { positions: this.flat(l.pts), width: 4 + 3.2 * l.lanes * 2, material: C(l.r >= 1 ? COL.coral : '#fb923c', .28) } })
      const len = polyLength(l.pts), n = Math.max(1, Math.min(14, Math.round(len / 24 * Math.min(l.r, 1.4) * 1.5)))
      if (len < 6) return
      for (let i = 0; i < n; i++) {
        const dir = i % 2 ? 1 : -1
        this.parts.push({ pts: l.pts, len, d: Math.random() * len, dir, lane: dir * (1.2 + .9 * Math.min(l.lanes, 3)), cls: l.c, r: l.r, linkId: l.id,
          p: this.flow.add({ position: this.pos(l.pts[0][0], l.pts[0][1], 1.2), pixelSize: 3.2 + Math.min(l.lanes, 3), color: C(loadColor(l.r), .95), disableDepthTestDistance: 0 }) })
      }
    })
    this.flow.show = this.layerOn.traffic !== false
  }

  /* pedestrians: illustrative streams on footpaths (no counts exist), slower and white */
  private buildPedestrians() {
    this.peds.removeAll(); this.walkers = []
    const tw = this.site!.twin
    tw.roads.filter(r => r.cls === 'walk' && r.pts.length > 1).forEach(r => {
      const len = polyLength(r.pts)
      if (len < 10) return
      const n = Math.min(6, Math.max(1, Math.round(len / 45)))
      for (let i = 0; i < n && this.walkers.length < 900; i++)
        this.walkers.push({ pts: r.pts, len, d: Math.random() * len, dir: i % 2 ? 1 : -1, lane: 0, cls: 'walk', r: 0, linkId: -1,
          p: this.peds.add({ position: this.pos(r.pts[0][0], r.pts[0][1], 1), pixelSize: 2.4, color: C('#e2e8f0', .85), disableDepthTestDistance: 0 }) })
    })
    tw.crossings.forEach(c => this.add('pedestrian', { position: this.pos(c.x, c.z, .3), point: { pixelSize: 5, color: C('#f8fafc', .9), outlineColor: C(COL.cyan, .6), outlineWidth: 1 } }))
    this.peds.show = this.layerOn.pedestrian !== false
  }

  private buildTrees() {
    const tw = this.site!.twin
    tw.trees.forEach((t, i) => {
      const g = this.groundAt(t.x, t.z), osm = t.source === 'osm'
      if (this.tilesOn) {
        this.add('trees', { position: this.pos(t.x, t.z), ellipse: { semiMajorAxis: t.crown_r, semiMinorAxis: t.crown_r, material: C(COL.emerald, .22) } }, { kind: 'tree', index: i })
        this.add('trees', { position: this.pos(t.x, t.z, t.height_m), point: { pixelSize: 4, color: C(COL.emerald, .95), outlineColor: C('#022c22', .8), outlineWidth: 1 } })
      } else {
        const cy = t.height_m - t.crown_r * .85
        this.add('trees', { position: Cesium.Cartesian3.fromDegrees(...this.F.lonLat(t.x, t.z), g + cy), ellipsoid: { radii: new Cesium.Cartesian3(t.crown_r, t.crown_r, t.crown_r * .85), material: C(osm ? '#10b981' : '#34d399', .55) } }, { kind: 'tree', index: i })
        this.add('trees', { position: Cesium.Cartesian3.fromDegrees(...this.F.lonLat(t.x, t.z), g + cy / 2), cylinder: { length: cy, topRadius: .15, bottomRadius: .22, material: C('#475569', .8) } })
      }
    })
  }

  private buildTransit() {
    const tw = this.site!.twin
    tw.stops.forEach((s, i) => {
      this.add('transit', { position: this.pos(s.x, s.z, 2), point: { pixelSize: 9, color: C(COL.cyan), outlineColor: C('#ffffff', .9), outlineWidth: 2, disableDepthTestDistance: 2000 } }, { kind: 'stop', index: i })
      this.add('transit', { polyline: { positions: this.ring(s.x, s.z, 400, .5, 96), width: 1, material: new Cesium.PolylineDashMaterialProperty({ color: C(COL.cyan, .18), dashLength: 10 }) } })
      if (i < 10) this.ann.add('stop-' + i, this.pos(s.x, s.z, 4), `<span class="ann-k">BUS STOP</span><span class="ann-v">${esc(s.name || 'Stop')}</span>`, { prio: 2, maxDist: 900, cls: 'ann-obs layer-transit' })
    })
  }

  private buildEv() {
    this.site!.twin.ev.forEach((s, i) => {
      this.add('ev', { position: this.pos(s.x, s.z, 2.5), point: { pixelSize: 10, color: C(COL.emerald), outlineColor: C('#ecfeff', .9), outlineWidth: 2, disableDepthTestDistance: 2000 } }, { kind: 'ev', index: i })
      this.ann.add('ev-' + i, this.pos(s.x, s.z, 5), `<span class="ann-k">EV CHARGER</span><span class="ann-v">${esc(s.name || 'Mapped')}</span>`, { prio: 2, maxDist: 1200, cls: 'ann-obs layer-ev' })
    })
  }

  /* road widths as dimension lines: observed when OpenStreetMap tags it, estimated when it is a class default */
  private buildWidths() {
    const seen = new Set<string>(), R = this.site!.twin.meta.radius_m
    const roads = this.site!.twin.roads.filter(r => r.cls !== 'walk' && r.name && r.pts.length > 1).sort((a, b) => polyLength(b.pts) - polyLength(a.pts))
    for (const r of roads) {
      if (seen.has(r.name!) || seen.size >= 8) continue
      const L = polyLength(r.pts), a = along(r.pts, L / 2)
      if (Math.hypot(a.x, a.z) > R * .85) continue
      seen.add(r.name!)
      this.dimension('widths', a.x, a.z, a.dx, a.dz, r.width_m, r.width_source)
      this.ann.add('w-' + r.id, this.pos(a.x, a.z, 3), widthLabel(r.name!, r.width_m, r.width_source), { prio: 3, maxDist: 700, cls: (r.width_source === 'default' ? 'ann-est' : 'ann-obs') + ' layer-widths' })
    }
  }

  private dimension(group: string, x: number, z: number, dx: number, dz: number, w: number, source: string) {
    const nx = -dz, nz = dx, col = source === 'default' ? COL.slate : COL.ice
    const A: XZ = [x + nx * w / 2, z + nz * w / 2], B: XZ = [x - nx * w / 2, z - nz * w / 2]
    const mat = source === 'default' ? new Cesium.PolylineDashMaterialProperty({ color: C(col, .9), dashLength: 8 }) : C(col, .95)
    this.add(group, { polyline: { positions: this.flat([A, B]), width: 2, clampToGround: true, material: mat } })
    ;[A, B].forEach(p => this.add(group, { polyline: { positions: this.flat([[p[0] - dx * 1.8, p[1] - dz * 1.8], [p[0] + dx * 1.8, p[1] + dz * 1.8]]), width: 2, clampToGround: true, material: C(col, .95) } }))
  }

  /* junction markers: every node where three or more links meet; hot spots get a numbered amber/coral ring */
  private buildJunctions() {
    this.junctions.forEach(j => {
      const hot = j.area, col = hot ? (hot.severity === 'high' ? COL.coral : COL.amber) : COL.cyan
      this.add('junctions', { position: this.pos(j.x, j.z, 1.5), point: { pixelSize: hot ? 11 : 6, color: C(col, hot ? .95 : .75), outlineColor: C('#020617', .9), outlineWidth: 2, disableDepthTestDistance: 3000 } }, { kind: 'junction', id: j.id })
      if (hot) {
        this.add('junctions', { position: this.pos(j.x, j.z), ellipse: { semiMajorAxis: new Cesium.CallbackProperty(() => this.pulse(j.id, 14, 34), false), semiMinorAxis: new Cesium.CallbackProperty(() => this.pulse(j.id, 14, 34), false),
          material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => C(col, .32 * (1 - this.phase(j.id))), false)) } }, { kind: 'junction', id: j.id })
        this.ann.add('j-' + j.id, this.pos(j.x, j.z, 8), `<span class="ann-k">HOT SPOT ${hot.id} · SIMULATED</span><span class="ann-v">${esc(j.name)}</span><span class="ann-m">score ${hot.score} · ${hot.load_ratio}× capacity</span>`, { prio: 6 - hot.id * .1, maxDist: 2600, cls: 'ann-sim' })
      }
    })
  }
  private frameT = performance.now()   // one time per frame, so paired values (ellipse axes) always match
  private phase(id: number) { return this.reduced ? .3 : ((this.frameT / 1000) * .5 + id * .17) % 1 }
  private pulse(id: number, a: number, b: number) { return a + (b - a) * this.phase(id) }

  /* ---------- sun and shade (computed) ---------- */
  private buildShade() {
    const sh = this.site!.twin.shade, n = sh.shape[1], w = n * sh.cell_m
    const nw = this.F.lonLat(sh.origin[0], sh.origin[1]), se = this.F.lonLat(sh.origin[0] + w, sh.origin[1] + w)
    this.shadeEnt = this.add('shade', { rectangle: { coordinates: Cesium.Rectangle.fromDegrees(nw[0], se[1], se[0], nw[1]), material: new Cesium.ImageMaterialProperty({ image: this.shadeCanvas(), transparent: true }) } })
  }

  setStacks(stack: Uint8Array, walk: Uint8Array) { this.stack = stack; this.walk = walk; if (this.shadeEnt && this.shadeEnt.rectangle) this.shadeEnt.rectangle.material = new Cesium.ImageMaterialProperty({ image: this.shadeCanvas(), transparent: true }) }
  private stack: Uint8Array | null = null
  private walk: Uint8Array | null = null

  private shadeCanvas() {
    const site = this.site!, sh = site.twin.shade, n = sh.shape[1], cv = document.createElement('canvas'); cv.width = cv.height = n
    const ctx = cv.getContext('2d')!, img = ctx.createImageData(n, n), d = img.data, per = n * n, k = this.shadeHour
    const stack = this.stack || site.stack, walk = this.walk || site.walk
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 4, v = stack[k * per + j * n + i]
      let near = walk[j * n + i] === 1
      if (!near) for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1; di++) { const jj = j + dj, ii = i + di; if (jj >= 0 && jj < n && ii >= 0 && ii < n && walk[jj * n + ii] === 1) { near = true; break } }
      if (!near) continue
      const a = walk[j * n + i] === 1 ? 165 : 55
      if (v === 255) { d[o] = 251; d[o + 1] = 176; d[o + 2] = 60; d[o + 3] = a }
      else if (v === 90) { d[o] = 52; d[o + 1] = 211; d[o + 2] = 153; d[o + 3] = a }
      else if (v === 0) { d[o] = 56; d[o + 1] = 120; d[o + 2] = 220; d[o + 3] = a * .8 }
    }
    ctx.putImageData(img, 0, 0)
    return cv
  }

  setHourIndex(k: number) {
    this.shadeHour = k
    const site = this.site
    if (!site) return
    if (this.shadeEnt && this.shadeEnt.rectangle) this.shadeEnt.rectangle.material = new Cesium.ImageMaterialProperty({ image: this.shadeCanvas(), transparent: true })
    // light the scene from the real sun position at this hour
    const s = site.twin.shade.sun[k], az = s.az * Math.PI / 180, el = s.el * Math.PI / 180
    const enu = new Cesium.Cartesian3(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el))
    const m = Cesium.Matrix4.getMatrix3(Cesium.Transforms.eastNorthUpToFixedFrame(this.pos(0, 0)), new Cesium.Matrix3())
    const sun = Cesium.Matrix3.multiplyByVector(m, enu, new Cesium.Cartesian3())
    this.viewer.scene.light = new Cesium.DirectionalLight({ direction: Cesium.Cartesian3.negate(Cesium.Cartesian3.normalize(sun, sun), new Cesium.Cartesian3()), intensity: s.el > 0 ? 2.2 : .4 })
  }

  setLayer(k: LayerKey, on: boolean) {
    this.layerOn[k] = on
    ;(this.layers[k] || []).forEach(e => { e.show = on })
    if (k === 'traffic') this.flow.show = on
    if (k === 'pedestrian') this.peds.show = on
    document.querySelectorAll<HTMLElement>('.layer-' + k).forEach(el => el.classList.toggle('ann-off', !on))
  }

  /* ---------- per frame ---------- */
  private tick() {
    const now = performance.now(), dt = Math.min(.1, (now - this.last) / 1000)
    this.last = now; this.frameT = now
    if (this.flow.show) for (const p of this.parts) {
      const r = p.r * (this.mul.get(p.linkId) ?? 1), v = speedKmh(p.cls, r) / 3.6 * 2.2   // 2.2x time-lapse
      p.d += p.dir * v * dt
      if (p.d > p.len) p.d -= p.len
      if (p.d < 0) p.d += p.len
      const a = along(p.pts, p.d)
      p.p.position = this.pos(a.x - a.dz * p.lane, a.z + a.dx * p.lane, 1.2)
    }
    if (this.peds.show) for (const p of this.walkers) {
      p.d += p.dir * 1.4 * 2.2 * dt
      if (p.d > p.len) p.d -= p.len
      if (p.d < 0) p.d += p.len
      const a = along(p.pts, p.d)
      p.p.position = this.pos(a.x, a.z, 1)
    }
    if (this.orbit && !this.reduced) {
      this.orbit.h += dt * .05
      this.viewer.camera.lookAt(this.orbit.c, new Cesium.HeadingPitchRange(this.orbit.h, this.orbit.p, this.orbit.r))
    }
    const cam = this.viewer.camera, cv = this.viewer.scene.canvas
    const mpp = cam.getPixelSize(new Cesium.BoundingSphere(cam.pickEllipsoid(new Cesium.Cartesian2(cv.clientWidth / 2, cv.clientHeight / 2)) || this.pos(0, 0), 1), cv.clientWidth, cv.clientHeight)
    this.onCamera(cam.heading, mpp)
  }

  /* ---------- input: pick, hover, stop the orbit when the user takes over ---------- */
  private wireInput() {
    const v = this.viewer, h = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    const pickAt = (p: Cesium.Cartesian2) => {
      const hits = v.scene.drillPick(p, 4)
      for (const hit of hits) { const id = hit && hit.id; if (id && this.pickMap.has(id)) return this.pickMap.get(id)! }
      return null
    }
    h.setInputAction((e: { position: Cesium.Cartesian2 }) => { this.onPick(pickAt(e.position)) }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    let busy = false
    h.setInputAction((e: { endPosition: Cesium.Cartesian2 }) => {
      if (busy) return
      busy = true
      requestAnimationFrame(() => {
        busy = false
        const s = pickAt(e.endPosition)
        v.scene.canvas.style.cursor = s ? 'pointer' : ''
        this.onHover(s ? { label: this.describe(s), x: e.endPosition.x, y: e.endPosition.y } : null)
        this.hover(s)
      })
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    const stop = () => this.stopOrbit()
    v.scene.canvas.addEventListener('pointerdown', stop)
    v.scene.canvas.addEventListener('wheel', stop, { passive: true })
  }

  describe(s: Selection): string {
    const tw = this.site?.twin
    if (!s || !tw) return ''
    if (s.kind === 'junction') { const j = this.junctions.find(x => x.id === s.id); return j ? j.name : 'Junction' }
    if (s.kind === 'road') { const r = tw.roads.find(x => x.id === s.id); return r ? `${r.name || r.highway} · ${r.width_m} m` : 'Road' }
    if (s.kind === 'building') { const b = tw.buildings.find(x => x.id === s.id); return b ? `${b.name || 'Building'} · ${Math.round(b.height_m)} m` : 'Building' }
    if (s.kind === 'tree') { const t = tw.trees[s.index]; return `Tree · ${t.height_m.toFixed(1)} m` }
    if (s.kind === 'stop') return tw.stops[s.index]?.name || 'Bus stop'
    if (s.kind === 'ev') return tw.ev[s.index]?.name || 'EV charger'
    return ''
  }

  private clearHover() { this.hov.forEach(e => this.viewer.entities.remove(e)); this.hov = [] }
  private hoverKey = ''
  private hover(s: Selection) {
    const key = s ? JSON.stringify(s) : ''
    if (key === this.hoverKey) return
    this.hoverKey = key
    this.clearHover()
    if (!s || !this.site) return
    const tw = this.site.twin, add = (o: Cesium.Entity.ConstructorOptions) => this.hov.push(this.viewer.entities.add(o))
    if (s.kind === 'road') { const r = tw.roads.find(x => x.id === s.id); if (r) add({ polyline: { positions: this.flat(r.pts), width: 6, clampToGround: true, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: .3, color: C(COL.cyan, .7) }) } }) }
    if (s.kind === 'building') { const b = tw.buildings.find(x => x.id === s.id); if (b) { const g = this.groundAt(...centroid(b.footprint)); add({ polyline: { positions: b.footprint.concat([b.footprint[0]]).map(p => Cesium.Cartesian3.fromDegrees(...this.F.lonLat(p[0], p[1]), g + b.height_m + .3)), width: 2, material: C(COL.cyan, .9) } }) } }
    if (s.kind === 'junction') { const j = this.junctions.find(x => x.id === s.id); if (j) add({ polyline: { positions: this.ring(j.x, j.z, 18), width: 2, material: C(COL.cyan, .9) } }) }
  }

  /* ---------- selection ---------- */
  clearSel() { this.sel.forEach(e => this.viewer.entities.remove(e)); this.sel = []; this.ann.clear('sel-') }
  select(s: Selection) {
    this.clearSel()
    if (!s || !this.site) return
    const tw = this.site.twin, add = (o: Cesium.Entity.ConstructorOptions) => { const e = this.viewer.entities.add(o); this.sel.push(e); return e }
    const glow = (a = .85) => new Cesium.PolylineGlowMaterialProperty({ glowPower: .28, taperPower: 1, color: C(COL.cyan, a) })
    if (s.kind === 'junction') {
      const j = this.junctions.find(x => x.id === s.id)
      if (!j) return
      add({ polyline: { positions: [this.pos(j.x, j.z), this.pos(j.x, j.z, 70)], width: 10, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: .15, taperPower: .4, color: C(COL.cyan, .8) }) } })
      add({ polyline: { positions: this.ring(j.x, j.z, 26), width: 2, material: C(COL.cyan, .9) } })
      add({ polyline: { positions: this.ring(j.x, j.z, 40), width: 1, material: new Cesium.PolylineDashMaterialProperty({ color: C(COL.cyan, .5), dashLength: 12 }) } })
      tw.traffic?.links.filter(l => j.links.includes(l.id)).forEach(l => add({ polyline: { positions: this.flat(l.pts), width: 7, clampToGround: true, material: glow(.6) } }))
    } else if (s.kind === 'road') {
      const r = tw.roads.find(x => x.id === s.id)
      if (!r) return
      add({ polyline: { positions: this.flat(r.pts), width: 8, clampToGround: true, material: glow() } })
      const a = along(r.pts, polyLength(r.pts) / 2)
      this.dimensionSel(a.x, a.z, a.dx, a.dz, r.width_m, r.width_source)
      this.ann.add('sel-w', this.pos(a.x, a.z, 4), widthLabel(r.name || r.highway, r.width_m, r.width_source), { prio: 10, maxDist: 5000, cls: r.width_source === 'default' ? 'ann-est ann-sel' : 'ann-obs ann-sel' })
    } else if (s.kind === 'building') {
      const b = tw.buildings.find(x => x.id === s.id)
      if (!b) return
      const c = centroid(b.footprint), g = this.groundAt(c[0], c[1])
      add({ polygon: { hierarchy: new Cesium.PolygonHierarchy(b.footprint.map(p => Cesium.Cartesian3.fromDegrees(...this.F.lonLat(p[0], p[1]), g))), height: g, extrudedHeight: g + b.height_m, material: C(COL.cyan, .2) } })
      add({ polyline: { positions: b.footprint.concat([b.footprint[0]]).map(p => Cesium.Cartesian3.fromDegrees(...this.F.lonLat(p[0], p[1]), g + b.height_m + .3)), width: 3, material: glow(1) } })
      this.ann.add('sel-b', Cesium.Cartesian3.fromDegrees(...this.F.lonLat(c[0], c[1]), g + b.height_m + 4), `<span class="ann-k">HEIGHT · ${b.height_source === 'default' ? 'ASSUMED' : b.height_source === 'lidar' ? 'LIDAR' : 'OSM'}</span><span class="ann-v">${b.height_m.toFixed(1)} m</span>`, { prio: 10, maxDist: 5000, cls: b.height_source === 'default' ? 'ann-est ann-sel' : 'ann-obs ann-sel' })
    } else if (s.kind === 'tree' || s.kind === 'stop' || s.kind === 'ev') {
      const p = s.kind === 'tree' ? tw.trees[s.index] : s.kind === 'stop' ? tw.stops[s.index] : tw.ev[s.index]
      if (!p) return
      add({ polyline: { positions: this.ring(p.x, p.z, s.kind === 'tree' ? Math.max(3, (p as { crown_r?: number }).crown_r || 3) + 1.5 : 8), width: 2, material: C(s.kind === 'tree' ? COL.emerald : COL.cyan, .95) } })
    }
  }
  private dimensionSel(x: number, z: number, dx: number, dz: number, w: number, source: string) {
    const before = this.layers.sel || []
    this.dimension('sel', x, z, dx, dz, w, source)
    this.sel.push(...(this.layers.sel || []).filter(e => !before.includes(e)))
    this.layers.sel = []
  }

  /* ---------- camera ---------- */
  stopOrbit() { if (this.orbit) { this.orbit = null; this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY) } }
  private fly(x: number, z: number, range: number, heading: number, pitch: number, orbit = false, dur = 2.4) {
    this.stopOrbit()
    const c = this.pos(x, z, 2)
    this.viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(c, 1), {
      offset: new Cesium.HeadingPitchRange(heading, pitch, range), duration: this.reduced ? 0 : dur,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
      complete: () => { if (orbit && !this.reduced) this.orbit = { c, h: heading, p: pitch, r: range } },
    })
  }
  flyToJunction(j: { x: number; z: number }) { this.fly(j.x, j.z, 210, this.viewer.camera.heading + .5, -.52, true, 2.6) }
  focus(x: number, z: number, range = 160) { this.fly(x, z, range, this.viewer.camera.heading + .25, -.6, false, 1.8) }
  preset(p: Preset, instant = false) {
    const site = this.site
    if (!site) return
    const R = site.twin.meta.radius_m
    if (p === 'aerial') this.fly(0, 0, R * 3.1, 0, -Math.PI / 2 + .001, false, instant ? 0 : 2.4)
    else if (p === 'isometric') this.fly(0, 0, R * 2.3, Math.PI / 4, -.6, !instant, instant ? 0 : 2.4)
    else {
      this.stopOrbit()
      const r = [...site.twin.roads].filter(x => x.cls === 'main' || x.cls === 'mid').sort((a, b) => polyLength(b.pts) - polyLength(a.pts))[0]
      if (!r) return
      const L = polyLength(r.pts), a = along(r.pts, Math.min(L * .3, 120)), g = this.F.lonLat(a.x - a.dz * 4, a.z + a.dx * 4)
      this.viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(g[0], g[1], this.groundAt(a.x, a.z) + 1.8),
        orientation: { heading: Math.atan2(a.dx, -a.dz), pitch: -.04, roll: 0 }, duration: this.reduced ? 0 : 3.2, easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT })
    }
  }
  flyToLonLat(lon: number, lat: number) {
    this.stopOrbit()
    this.viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, lat, 900), orientation: { heading: 0, pitch: -.7, roll: 0 }, duration: this.reduced ? 0 : 3 })
  }
  resetNorth() { const c = this.viewer.camera; this.stopOrbit(); c.flyTo({ destination: c.positionWC.clone(), orientation: { heading: 0, pitch: c.pitch, roll: 0 }, duration: .8 }) }

  /* ---------- Analyze: a scan sweeps the junction, then context lights up in turn ---------- */
  private scanId = 0
  clearFx() { this.fx.forEach(e => this.viewer.entities.remove(e)); this.fx = []; this.ann.clear('fx-') }
  scan(j: Junction): Promise<void> {
    this.clearFx()
    const t0 = performance.now(), R = 160, add = (o: Cesium.Entity.ConstructorOptions) => { const e = this.viewer.entities.add(o); this.fx.push(e); return e }
    const k = () => Math.min(1, (performance.now() - t0) / 2400)
    add({ polyline: { positions: new Cesium.CallbackProperty(() => this.ring(j.x, j.z, Math.max(1, R * k()), 1, 72), false), width: 3, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: .3, color: new Cesium.CallbackProperty(() => C(COL.cyan, .9 * (1 - k() * .7)), false) }) } })
    add({ polyline: { positions: new Cesium.CallbackProperty(() => { const a = k() * Math.PI * 4; return [this.pos(j.x, j.z, 1), this.pos(j.x + Math.cos(a) * R, j.z + Math.sin(a) * R, 1)] }, false), width: 4,
      material: new Cesium.PolylineGlowMaterialProperty({ glowPower: .25, color: new Cesium.CallbackProperty(() => C(COL.cyan, k() < 1 ? .8 : 0), false) }) } })
    const tw = this.site!.twin, after = (ms: number, f: () => void) => setTimeout(f, this.reduced ? 0 : ms)
    after(700, () => tw.traffic?.links.filter(l => l.pts.some(p => dist(p[0], p[1], j.x, j.z) < R)).forEach(l => add({ polyline: { positions: this.flat(l.pts), width: 5, clampToGround: true, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: .3, color: C(COL.cyan, .55) }) } })))
    after(1300, () => tw.trees.filter(t => dist(t.x, t.z, j.x, j.z) < R).forEach(t => add({ position: this.pos(t.x, t.z), ellipse: { semiMajorAxis: t.crown_r + 1, semiMinorAxis: t.crown_r + 1, material: C(COL.emerald, .28) } })))
    after(1900, () => [...tw.stops, ...tw.crossings].filter(s => dist(s.x, s.z, j.x, j.z) < R).forEach(s => add({ polyline: { positions: this.ring(s.x, s.z, 4, .4, 24), width: 1.5, material: C(COL.cyan, .7) } })))
    // the scan is a moment, not a state: clear the sweep and the context highlights once it is done
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
    const dash = (pts: XZ[], a = .9) => new Cesium.PolylineDashMaterialProperty({ color: V(a), dashLength: 12 })
    for (const r of recs) {
      const link = r.sol ? tw.traffic?.links.find(l => l.id === r.sol!.link_id) : undefined
      if (r.sol) {
        const ratio = r.sol.area_load_after / Math.max(.01, r.sol.area_load_before)
        j.links.forEach(id => this.mul.set(id, ratio)); if (link) this.mul.set(link.id, ratio)
      }
      if (r.kind === 'bus_lane' && link) {
        const w = 2 + 3.2 * link.lanes * 2, strip = offsetLine(link.pts, w / 2 - 1.7)
        add({ corridor: { positions: this.flat(strip), width: 3.4, material: V(.55) } }, link.pts[0][0], link.pts[0][1])
        ;[-1.7, 1.7].forEach(o => add({ polyline: { positions: this.flat(offsetLine(strip, o)), width: 2, clampToGround: true, material: dash(strip) } }, link.pts[0][0], link.pts[0][1]))
        this.propLabel('bus', link.pts, 'PROPOSED BUS LANE', r)
      } else if (r.kind === 'signal_retiming') {
        ;[[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([a, b], i) => {
          const x = j.x + a * 10, z = j.z + b * 10
          add({ position: this.pos(x, z, 3), cylinder: { length: 6, topRadius: .2, bottomRadius: .25, material: V(.7) } }, x, z)
          add({ position: this.pos(x, z, 6.4), point: { pixelSize: 12, outlineColor: C('#0b1020'), outlineWidth: 2, color: new Cesium.CallbackProperty(() => { const p = (performance.now() / 1000 + (i % 2) * 3) % 6; return C(p < 2.6 ? COL.emerald : p < 3 ? COL.amber : COL.coral) }, false) } }, x, z)
        })
        this.ann.add('prop-sig', this.pos(j.x, j.z, 12), propHtml('SIGNAL CONTROL', r), { prio: 8.5, maxDist: 3000, cls: 'ann-pro ann-sel' })
      } else if (r.kind === 'foot_overbridge' && link) {
        const m = along(link.pts, polyLength(link.pts) / 2), nx = -m.dz, nz = m.dx, w = 2 + 3.2 * link.lanes * 2 + 14, g = this.groundAt(m.x, m.z)
        const quad = (cx: number, cz: number, ux: number, uz: number, hl: number, hw: number) => new Cesium.PolygonHierarchy([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => Cesium.Cartesian3.fromDegrees(...this.F.lonLat(cx + ux * hl * s - uz * hw * t, cz + uz * hl * s + ux * hw * t), g)))
        add({ polygon: { hierarchy: quad(m.x, m.z, nx, nz, w / 2, 1.8), height: g + 6.4, extrudedHeight: g + 7.4, material: V(.5), outline: true, outlineColor: V(1) } }, m.x, m.z)
        ;[-1, 1].forEach(sg => add({ polygon: { hierarchy: quad(m.x + nx * sg * w / 2, m.z + nz * sg * w / 2, nx, nz, 2, 2), height: g, extrudedHeight: g + 7.4, material: V(.4), outline: true, outlineColor: V(1) } }, m.x, m.z))
        this.ann.add('prop-bridge', this.pos(m.x, m.z, 10), propHtml('FOOT OVERBRIDGE', r), { prio: 8.5, maxDist: 3000, cls: 'ann-pro ann-sel' })
      } else if (r.kind === 'route_diversion' && link) {
        const rt = routeAround(this.site, link.id)
        if (rt?.detour) {
          rt.detour.links.forEach(l => add({ polyline: { positions: this.flat(l.pts), width: 6, clampToGround: true, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: .25, color: V(.85) }) } }, l.pts[0][0], l.pts[0][1]))
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
          add({ position: Cesium.Cartesian3.fromDegrees(...this.F.lonLat(t.x, t.z), g + cy), ellipsoid: { radii: new Cesium.Cartesian3(t.crown_r, t.crown_r, t.crown_r * .85), material: C('#99f6e4', .5) } }, t.x, t.z)
          add({ polyline: { positions: this.ring(t.x, t.z, t.crown_r + .8, .4, 24), width: 1.5, material: dash([]) } }, t.x, t.z)
        })
        const near = [...r.trees].sort((a, b) => dist(a.x, a.z, j.x, j.z) - dist(b.x, b.z, j.x, j.z))[0]
        if (near) this.ann.add('prop-trees', this.pos(near.x, near.z, 10), propHtml('NEW STREET TREES', r), { prio: 8, maxDist: 3000, cls: 'ann-pro ann-sel' })
      } else if (r.kind === 'crossing' && r.crossing) {
        const c = r.crossing, nx = -c.dz, nz = c.dx
        for (let k = -c.w / 2 + .6; k < c.w / 2 - .4; k += 1.1) {
          const x = c.x + nx * k, z = c.z + nz * k
          add({ polygon: { hierarchy: new Cesium.PolygonHierarchy([[-1.5, -.25], [1.5, -.25], [1.5, .25], [-1.5, .25]].map(([a, b]) => { const p = this.F.lonLat(x + c.dx * a + nx * b, z + c.dz * a + nz * b); return Cesium.Cartesian3.fromDegrees(p[0], p[1]) })), material: C('#f5f3ff', .92) } }, x, z)
        }
        const box: XZ[] = [[-2.2, -c.w / 2], [2.2, -c.w / 2], [2.2, c.w / 2], [-2.2, c.w / 2], [-2.2, -c.w / 2]].map(([a, b]) => [c.x + c.dx * a + nx * b, c.z + c.dz * a + nz * b])
        add({ polyline: { positions: this.flat(box), width: 2, clampToGround: true, material: dash(box) } }, c.x, c.z)
        this.ann.add('prop-cross', this.pos(c.x, c.z, 6), propHtml('PROTECTED CROSSING', r), { prio: 8.5, maxDist: 3000, cls: 'ann-pro ann-sel' })
      } else if (r.kind === 'ev' && r.ev) {
        r.ev.forEach((p, i) => {
          add({ position: this.pos(p[0], p[1], 2), cylinder: { length: 4, topRadius: .7, bottomRadius: .7, material: V(.75) } }, p[0], p[1])
          add({ position: this.pos(p[0], p[1]), ellipse: { semiMajorAxis: 7, semiMinorAxis: 7, material: V(.25) } }, p[0], p[1])
          this.ann.add('prop-ev' + i, this.pos(p[0], p[1], 7), propHtml('EV CANDIDATE ' + (i + 1), r), { prio: 7, maxDist: 3000, cls: 'ann-pro ann-sel' })
        })
      }
    }
    // reveal in a wave outward from the junction
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

function esc(s: string) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)) }
function widthLabel(name: string, w: number, src: string) {
  const s = src === 'osm_width' ? 'OBSERVED · OSM WIDTH TAG' : src === 'lanes' ? 'ESTIMATED · FROM LANE COUNT' : 'ESTIMATED · CLASS DEFAULT'
  return `<span class="ann-k">${s}</span><span class="ann-v">${w.toFixed(1)} m</span><span class="ann-m">${esc(name)}</span>`
}
function propHtml(title: string, r: Rec) {
  return `<span class="ann-k">PROPOSED · ${r.basis.toUpperCase()}</span><span class="ann-v">${title}</span>${r.effect ? `<span class="ann-m">${esc(r.effect)}</span>` : ''}`
}
