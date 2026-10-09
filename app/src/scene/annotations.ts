import * as Cesium from 'cesium'

/* HTML labels anchored to world positions. Work is done only when the camera moved or labels changed: positions are
   re-projected, low-priority labels hide when they would overlap a more important one, a floating panel, or when the
   camera is too far away. Panel outlines are measured a few times a second, never every frame. */
interface Item { id: string; pos: Cesium.Cartesian3; el: HTMLDivElement; prio: number; maxDist: number; w: number; h: number; tf: string; vis: boolean }
type Box = [number, number, number, number]

export class Annotations {
  private items = new Map<string, Item>()
  private s1 = new Cesium.Cartesian3()
  private s2 = new Cesium.Cartesian2()
  private lastView = new Cesium.Matrix4()
  private dirty = true
  private occ: Box[] = []
  private occT = 0

  constructor(private scene: Cesium.Scene, private host: HTMLElement) {
    scene.postRender.addEventListener(() => this.update())
    window.addEventListener('resize', () => { this.occT = 0; this.dirty = true })
  }

  add(id: string, pos: Cesium.Cartesian3, html: string, o: { prio?: number; maxDist?: number; cls?: string } = {}) {
    this.remove(id)
    const el = document.createElement('div')
    el.className = 'ann ' + (o.cls || '')
    el.innerHTML = html
    el.style.visibility = 'hidden'
    this.host.appendChild(el)
    this.items.set(id, { id, pos, el, prio: o.prio ?? 1, maxDist: o.maxDist ?? 1600, w: 0, h: 0, tf: '', vis: false })
    this.dirty = true
    return el
  }

  remove(id: string) {
    const it = this.items.get(id)
    if (it) { it.el.remove(); this.items.delete(id); this.dirty = true }
  }

  touch() { this.dirty = true }

  clear(prefix: string) { [...this.items.keys()].filter(k => k.startsWith(prefix)).forEach(k => this.remove(k)) }

  private setVis(it: Item, v: boolean) { if (it.vis !== v) { it.vis = v; it.el.style.visibility = v ? 'visible' : 'hidden'; it.el.style.opacity = v ? '1' : '0' } }

  private update() {
    const now = performance.now()
    if (now - this.occT > 350) {
      this.occT = now
      const hr = this.host.getBoundingClientRect()
      const occ = [...document.querySelectorAll<HTMLElement>('.glass')].map(e => e.getBoundingClientRect()).filter(r => r.width > 0)
        .map(r => [r.left - hr.left, r.top - hr.top, r.right - hr.left, r.bottom - hr.top] as Box)
      if (JSON.stringify(occ) !== JSON.stringify(this.occ)) { this.occ = occ; this.dirty = true }
    }
    const vm = this.scene.camera.viewMatrix
    if (!this.dirty && Cesium.Matrix4.equalsEpsilon(vm, this.lastView, 1e-10)) return
    Cesium.Matrix4.clone(vm, this.lastView)
    this.dirty = false
    const cam = this.scene.camera, cp = cam.positionWC, dir = cam.directionWC, placed: Box[] = []
    const list = [...this.items.values()].sort((a, b) => b.prio - a.prio)
    for (const it of list) {
      if (it.el.classList.contains('ann-off')) { this.setVis(it, false); continue }
      const d = Cesium.Cartesian3.distance(cp, it.pos)
      const to = Cesium.Cartesian3.subtract(it.pos, cp, this.s1)
      const win = d <= it.maxDist && Cesium.Cartesian3.dot(to, dir) > 0 ? Cesium.SceneTransforms.worldToWindowCoordinates(this.scene, it.pos, this.s2) : undefined
      if (!win) { this.setVis(it, false); continue }
      if (!it.w) { it.w = it.el.offsetWidth; it.h = it.el.offsetHeight }
      const box: Box = [win.x - 6, win.y - it.h, win.x - 6 + it.w, win.y]
      const over = (b: Box) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]
      if (this.occ.some(over) || (it.prio < 9 && placed.some(over))) { this.setVis(it, false); continue }
      placed.push(box)
      const tf = `translate3d(${Math.round(win.x)}px,${Math.round(win.y)}px,0)`
      if (tf !== it.tf) { it.tf = tf; it.el.style.transform = tf }
      this.setVis(it, true)
    }
  }
}
