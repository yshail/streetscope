/* Map context for any place on Earth, straight from OpenStreetMap (Overpass) in the browser:
   buildings with heights, roads, green space, water, rail and points of interest within about a kilometre.
   This is what makes the app work worldwide before (or without) a full analysis twin. */
import { Frame, polygonArea, centroid, polyLength } from './geo'
import type { XZ } from './types'

export interface CtxBuilding { pts: XZ[]; h: number; tagged: boolean; name?: string; kind: string; c: XZ; area: number }
export interface CtxRoad { pts: XZ[]; cls: 'major' | 'mid' | 'minor' | 'path' | 'cycle'; name?: string; hw: string; w: number }
export interface CtxArea { pts: XZ[]; kind: 'green' | 'water' | 'park'; area: number }
export interface CtxLine { pts: XZ[]; kind: 'rail' | 'water' }
export type PoiCat = 'health' | 'education' | 'food' | 'shop' | 'transit' | 'parking' | 'civic' | 'leisure'
export interface CtxPoi { x: number; z: number; cat: PoiCat; name?: string; kind: string }
export interface Context {
  lat: number; lon: number; radius: number; frame: Frame
  buildings: CtxBuilding[]; roads: CtxRoad[]; areas: CtxArea[]; lines: CtxLine[]; pois: CtxPoi[]; stops: { x: number; z: number; name?: string }[]
  stats: ContextStats
}
export interface ContextStats {
  buildings: number; taggedHeightPct: number; footprintPct: number; meanHeight: number; tallest: number
  greenPct: number; waterPct: number; roadKm: Record<string, number>; intersections: number
  poi: Record<PoiCat, number>; stops: number; stopCoveragePct: number; mix: number
}

const API_BASE = ((window as { STREETSCOPE?: { api: string } }).STREETSCOPE?.api || 'http://localhost:8766/ask').replace(/\/ask$/, '')
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
const cache = new Map<string, Context>()

function query(lat: number, lon: number, r: number) {
  const a = `(around:${r},${lat},${lon})`
  return `[out:json][timeout:60];(
way["building"]${a};
way["highway"]${a};
way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green|cemetery|allotments)$"]${a};
way["leisure"~"^(park|garden|pitch|playground|nature_reserve|golf_course)$"]${a};
way["natural"~"^(water|wood|scrub|grassland|wetland)$"]${a};
relation["natural"="water"]${a};relation["leisure"="park"]${a};relation["landuse"="forest"]${a};
way["waterway"~"^(river|canal|stream)$"]${a};
way["railway"~"^(rail|subway|light_rail|tram|monorail)$"]${a};
node["amenity"]${a};node["shop"]${a};node["tourism"]${a};node["leisure"]${a};
node["highway"="bus_stop"]${a};node["public_transport"="station"]${a};node["railway"="station"]${a};
);out geom qt;`
}

const HW: Record<string, CtxRoad['cls']> = {
  motorway: 'major', trunk: 'major', primary: 'major', motorway_link: 'major', trunk_link: 'major', primary_link: 'major',
  secondary: 'mid', tertiary: 'mid', secondary_link: 'mid', tertiary_link: 'mid',
  residential: 'minor', unclassified: 'minor', service: 'minor', living_street: 'minor', road: 'minor',
  footway: 'path', pedestrian: 'path', path: 'path', steps: 'path', track: 'path', cycleway: 'cycle',
}
const WIDTH: Record<CtxRoad['cls'], number> = { major: 14, mid: 10, minor: 6.5, path: 2.5, cycle: 2.5 }

function poiCat(t: Record<string, string>): PoiCat | null {
  const a = t.amenity, s = t.shop, tr = t.tourism, l = t.leisure
  if (/^(hospital|clinic|doctors|pharmacy|dentist)$/.test(a)) return 'health'
  if (/^(school|university|college|kindergarten|library)$/.test(a)) return 'education'
  if (/^(restaurant|cafe|fast_food|food_court|bar|pub)$/.test(a)) return 'food'
  if (/^(parking|parking_entrance|bicycle_parking)$/.test(a)) return 'parking'
  if (/^(townhall|police|fire_station|post_office|courthouse|community_centre|place_of_worship)$/.test(a)) return 'civic'
  if (/^(bus_station|ferry_terminal|taxi|charging_station|fuel)$/.test(a) || t.public_transport === 'station' || t.railway === 'station') return 'transit'
  if (s) return 'shop'
  if (tr || /^(park|playground|sports_centre|fitness_centre|garden)$/.test(l)) return 'leisure'
  return null
}

function heightOf(t: Record<string, string>): { h: number; tagged: boolean } {
  const num = (v?: string) => { const m = v && v.match(/[\d.]+/); return m ? parseFloat(m[0]) : NaN }
  const h = num(t.height), lv = num(t['building:levels'])
  if (h > 0 && h < 600) return { h, tagged: true }
  if (lv > 0 && lv < 200) return { h: lv * 3.2 + 1, tagged: true }
  const b = t.building
  const d = b === 'house' || b === 'detached' || b === 'garage' || b === 'shed' || b === 'hut' ? 6 : b === 'apartments' || b === 'office' || b === 'hotel' ? 18 : b === 'commercial' || b === 'retail' || b === 'industrial' || b === 'warehouse' ? 10 : 9
  return { h: d, tagged: false }
}

type El = { type: string; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[]; lat?: number; lon?: number; members?: { role: string; geometry?: { lat: number; lon: number }[] }[] }

async function gzJson(url: string) {
  const r = await fetch(url)
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return new Response(r.body!.pipeThrough(new DecompressionStream('gzip'))).json()
}

/* Where the map comes from, in order: the copy saved with a demo site, the local server's cache, then Overpass itself */
export async function loadContext(lat: number, lon: number, radius = 900, onStatus?: (s: string) => void, saved?: string): Promise<Context> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${radius}`
  if (cache.has(key)) return cache.get(key)!
  let json: { elements: El[] } | null = null, lastErr = ''
  if (saved) { try { onStatus?.('Loading saved map detail…'); json = await gzJson(saved) } catch { /* not saved for this site */ } }
  if (!json) {
    try {
      onStatus?.('Downloading OpenStreetMap within ' + radius + ' m…')
      const r = await fetch(`${API_BASE}/context?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&r=${radius}`)
      if (r.ok) json = await r.json(); else lastErr = (await r.json().catch(() => ({}))).error || 'HTTP ' + r.status
    } catch { /* local server not running: ask Overpass directly */ }
  }
  for (const url of json ? [] : MIRRORS) {
    try {
      onStatus?.('Downloading OpenStreetMap within ' + radius + ' m…')
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query(lat, lon, radius)), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      if (!r.ok) { lastErr = 'HTTP ' + r.status; continue }
      json = await r.json(); break
    } catch (e) { lastErr = String((e as Error).message || e) }
  }
  if (!json) throw new Error('OpenStreetMap is busy (' + lastErr + '). Try again in a minute.')
  onStatus?.('Building ' + json.elements.length.toLocaleString() + ' map features…')
  const F = new Frame(lat, lon), xz = (g: { lat: number; lon: number }) => F.xz(g.lon, g.lat)
  const ctx: Context = { lat, lon, radius, frame: F, buildings: [], roads: [], areas: [], lines: [], pois: [], stops: [], stats: null as unknown as ContextStats }
  for (const e of json.elements) {
    const t = e.tags || {}
    if (e.type === 'node') {
      const p = F.xz(e.lon!, e.lat!)
      if (t.highway === 'bus_stop') { ctx.stops.push({ x: p[0], z: p[1], name: t.name }); continue }
      const cat = poiCat(t)
      if (cat) ctx.pois.push({ x: p[0], z: p[1], cat, name: t.name, kind: t.amenity || t.shop || t.tourism || t.leisure || t.railway || '' })
      continue
    }
    const rings: XZ[][] = e.type === 'way' && e.geometry ? [e.geometry.map(xz)] : (e.members || []).filter(m => m.role !== 'inner' && m.geometry).map(m => m.geometry!.map(xz))
    for (const pts of rings) {
      if (pts.length < 2) continue
      if (t.building && pts.length >= 4) {
        const ring = dedupe(pts)
        const area = polygonArea(ring)
        if (ring.length < 3 || area < 4) continue
        const { h, tagged } = heightOf(t)
        ctx.buildings.push({ pts: ring, h, tagged, name: t.name, kind: t.building, c: centroid(ring), area })
      } else if (t.highway && HW[t.highway]) {
        const cls = HW[t.highway], lanes = parseFloat(t.lanes || '')
        ctx.roads.push({ pts, cls, name: t.name, hw: t.highway, w: parseFloat(t.width || '') || (lanes > 0 ? lanes * 3.3 : WIDTH[cls]) })
      } else if (t.railway) ctx.lines.push({ pts, kind: 'rail' })
      else if (t.waterway) ctx.lines.push({ pts, kind: 'water' })
      else if (pts.length >= 4 && (t.natural === 'water')) ctx.areas.push({ pts: dedupe(pts), kind: 'water', area: polygonArea(pts) })
      else if (pts.length >= 4 && (t.leisure === 'park' || t.leisure === 'garden')) ctx.areas.push({ pts: dedupe(pts), kind: 'park', area: polygonArea(pts) })
      else if (pts.length >= 4 && (t.landuse || t.natural || t.leisure)) ctx.areas.push({ pts: dedupe(pts), kind: 'green', area: polygonArea(pts) })
    }
  }
  ctx.stats = stats(ctx)
  cache.set(key, ctx)
  return ctx
}

function dedupe(pts: XZ[]): XZ[] {
  const out: XZ[] = []
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.abs(q[0] - p[0]) > .05 || Math.abs(q[1] - p[1]) > .05) out.push(p) }
  if (out.length > 1) { const a = out[0], b = out[out.length - 1]; if (Math.abs(a[0] - b[0]) < .05 && Math.abs(a[1] - b[1]) < .05) out.pop() }
  return out
}

function stats(c: Context): ContextStats {
  const disc = Math.PI * c.radius * c.radius, inR = (p: XZ) => Math.hypot(p[0], p[1]) <= c.radius
  const bl = c.buildings.filter(b => inR(b.c))
  const roadKm: Record<string, number> = {}
  c.roads.forEach(r => { roadKm[r.cls] = (roadKm[r.cls] || 0) + polyLength(r.pts) / 1000 })
  const ends = new Map<string, number>()
  c.roads.filter(r => r.cls !== 'path' && r.cls !== 'cycle').forEach(r => r.pts.forEach(p => { const k = Math.round(p[0]) + ',' + Math.round(p[1]); ends.set(k, (ends.get(k) || 0) + 1) }))
  const poi = { health: 0, education: 0, food: 0, shop: 0, transit: 0, parking: 0, civic: 0, leisure: 0 } as Record<PoiCat, number>
  c.pois.forEach(p => { poi[p.cat]++ })
  const covered = bl.filter(b => c.stops.some(s => Math.hypot(s.x - b.c[0], s.z - b.c[1]) <= 400)).length
  const sum = (k: CtxArea['kind'][]) => Math.min(100, 100 * c.areas.filter(a => k.includes(a.kind) && inR(centroid(a.pts))).reduce((s, a) => s + a.area, 0) / disc)
  return {
    buildings: bl.length, taggedHeightPct: bl.length ? Math.round(100 * bl.filter(b => b.tagged).length / bl.length) : 0,
    footprintPct: Math.round(1000 * bl.reduce((s, b) => s + b.area, 0) / disc) / 10,
    meanHeight: bl.length ? Math.round(10 * bl.reduce((s, b) => s + b.h, 0) / bl.length) / 10 : 0, tallest: Math.round(Math.max(0, ...bl.map(b => b.h))),
    greenPct: Math.round(10 * sum(['green', 'park'])) / 10, waterPct: Math.round(10 * sum(['water'])) / 10, roadKm,
    intersections: [...ends.values()].filter(v => v >= 3).length, poi, stops: c.stops.length,
    stopCoveragePct: bl.length ? Math.round(100 * covered / bl.length) : 0,
    mix: (['health', 'education', 'food', 'shop', 'transit', 'leisure'] as PoiCat[]).filter(k => poi[k] > 0).length,
  }
}
