/* Small clients: the Streetscope doctor (Claude), live weather and air quality, and place search. None need a key. */

declare global { interface Window { STREETSCOPE?: { api: string; token?: string } } }
const API = (window.STREETSCOPE && window.STREETSCOPE.api) || 'http://localhost:8766/ask'

export interface DoctorStatus { mode: 'claude' | 'llm' | 'offline'; model: string | null; provider: string | null }
export interface DoctorAnswer {
  answer: string; verified: boolean; unverified_numbers: number[]; tools_called: { tool: string }[]
  llm?: { provider: string; model: string; turns: number }; fallback_reason?: string
  map_points?: { lat: number; lon: number; label: string; kind?: string }[]
}

export async function doctorStatus(): Promise<DoctorStatus | null> {
  try { return await (await fetch(API.replace(/\/ask$/, '/status'))).json() } catch { return null }
}

export async function askDoctor(site: string, body: { question?: string; mode?: 'brief' }): Promise<DoctorAnswer> {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(window.STREETSCOPE?.token ? { 'x-ask-token': window.STREETSCOPE.token } : {}) }, body: JSON.stringify({ site, ...body }) })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
  return j
}

export const modelName = (m: string | null | undefined) => !m ? 'offline templates' : /sonnet-5-5/.test(m) ? 'Claude Sonnet 5.5' : m

export interface Weather { temp: number; feels: number; uv: number | null; wind: number; humidity: number; pm25: number | null; time: string }

/* Open-Meteo: current conditions and air quality at the site, no key needed */
export async function liveWeather(lat: number, lon: number): Promise<Weather | null> {
  try {
    const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,uv_index&timezone=auto`)).json()
    let pm25: number | null = null
    try { const a = await (await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5`)).json(); pm25 = a.current?.pm2_5 ?? null } catch { /* air quality is optional */ }
    const c = w.current
    return { temp: c.temperature_2m, feels: c.apparent_temperature, uv: c.uv_index ?? null, wind: c.wind_speed_10m, humidity: c.relative_humidity_2m, pm25, time: c.time }
  } catch { return null }
}

export interface Place { name: string; lat: number; lon: number }
/* OpenStreetMap Nominatim geocoder (light use only, per its usage policy) */
export async function searchPlaces(q: string): Promise<Place[]> {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en' } })
  if (!r.ok) return []
  return (await r.json()).map((p: { display_name: string; lat: string; lon: string }) => ({ name: p.display_name, lat: +p.lat, lon: +p.lon }))
}

/* Twin builder (scripts/builder.py behind scripts/dev_api.py): build a twin for any place, then follow its progress */
const BASE = API.replace(/\/ask$/, '')
export interface BuildJob {
  id: string; site: string; name: string; state: 'running' | 'done' | 'error'; pct: number; step: string
  error: string | null; elapsed_s: number; last: string; radius: number
}

export async function startBuild(p: { lat: number; lon: number; name: string; radius: number; tz: number }): Promise<BuildJob> {
  const r = await fetch(BASE + '/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
  return j
}

export async function buildStatus(id: string): Promise<BuildJob> {
  const r = await fetch(BASE + '/build/' + id)
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
  return j
}

/* The site's UTC offset in hours (Open-Meteo resolves the time zone), so the shade uses local clock hours */
export async function utcOffsetHours(lat: number, lon: number): Promise<number> {
  try {
    const j = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&timezone=auto`)).json()
    if (typeof j.utc_offset_seconds === 'number') return j.utc_offset_seconds / 3600
  } catch { /* fall back to the longitude */ }
  return Math.round(lon / 15)
}

/* Settings that live only in this browser */
export const store = {
  get(k: string, d = '') { try { return localStorage.getItem(k) ?? d } catch { return d } },
  set(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}
