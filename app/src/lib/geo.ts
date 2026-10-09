/* Local metric frame used by the pipeline: x metres east, z metres south of the site centre. */
const EARTH = 6371008.8, RAD = Math.PI / 180

export class Frame {
  kx: number; kz: number
  constructor(public lat0: number, public lon0: number) {
    this.kx = Math.cos(lat0 * RAD) * RAD * EARTH
    this.kz = RAD * EARTH
  }
  lonLat(x: number, z: number): [number, number] { return [this.lon0 + x / this.kx, this.lat0 - z / this.kz] }
  xz(lon: number, lat: number): [number, number] { return [(lon - this.lon0) * this.kx, -(lat - this.lat0) * this.kz] }
}

export const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz)

export function polyLength(pts: [number, number][]) {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return L
}

/* Point and unit direction at distance d along a polyline */
export function along(pts: [number, number][], d: number) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (d <= L || i === pts.length - 1) {
      const t = L > 0 ? Math.min(1, Math.max(0, d / L)) : 0
      return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: L > 0 ? (b[0] - a[0]) / L : 1, dz: L > 0 ? (b[1] - a[1]) / L : 0 }
    }
    d -= L
  }
  return { x: pts[0][0], z: pts[0][1], dx: 1, dz: 0 }
}

export function offsetLine(pts: [number, number][], o: number): [number, number][] {
  const n = pts.length, out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(n - 1, i + 1)]
    let dx1 = b[0] - a[0], dz1 = b[1] - a[1], dx2 = c[0] - b[0], dz2 = c[1] - b[1]
    const l1 = Math.hypot(dx1, dz1) || 1, l2 = Math.hypot(dx2, dz2) || 1
    dx1 /= l1; dz1 /= l1; dx2 /= l2; dz2 /= l2
    const nx = -(dz1 + dz2), nz = dx1 + dx2, l = Math.hypot(nx, nz) || 1
    out.push([b[0] + nx / l * o, b[1] + nz / l * o])
  }
  return out
}

export function centroid(f: [number, number][]) {
  let x = 0, z = 0
  f.forEach(p => { x += p[0]; z += p[1] })
  return [x / f.length, z / f.length] as [number, number]
}

export function polygonArea(f: [number, number][]) {
  let s = 0
  for (let i = 0; i < f.length; i++) { const a = f[i], b = f[(i + 1) % f.length]; s += a[0] * b[1] - b[0] * a[1] }
  return Math.abs(s) / 2
}
