import * as Cesium from 'cesium'

/* HTML labels anchored to world positions. Re-projected every frame; low-priority labels hide when they would
   overlap a more important one or when the camera is too far away. */
interface Item { id: string; pos: Cesium.Cartesian3; el: HTMLDivElement; prio: number; maxDist: number; w: number; h: number }

export class Annotations {
  private items = new Map<string, Item>()
  private s1 = new Cesium.Cartesian3()
  private s2 = new Cesium.Cartesian2()

  constructor(private scene: Cesium.Scene, private host: HTMLElement) {
    scene.postRender.addEventListener(() => this.update())
  }

  add(id: string, pos: Cesium.Cartesian3, html: string, o: { prio?: number; maxDist?: number; cls?: string } = {}) {
    this.remove(id)
    const el = document.createElement('div')
    el.className = 'ann ' + (o.cls || '')
    el.innerHTML = html
    this.host.appendChild(el)
    this.items.set(id, { id, pos, el, prio: o.prio ?? 1, maxDist: o.maxDist ?? 1600, w: 0, h: 0 })
    return el
  }

  remove(id: string) {
    const it = this.items.get(id)
    if (it) { it.el.remove(); this.items.delete(id) }
  }

  clear(prefix: string) {
    [...this.items.keys()].filter(k => k.startsWith(prefix)).forEach(k => this.remove(k))
  }

  private update() {
    const cam = this.scene.camera, cp = cam.positionWC, dir = cam.directionWC
    const placed: [number, number, number, number][] = []
    // floating panels hide the labels behind them
    const hostR = this.host.getBoundingClientRect()
    const occ = [...document.querySelectorAll<HTMLElement>('.glass')].map(e => e.getBoundingClientRect()).filter(r => r.width > 0)
      .map(r => [r.left - hostR.left, r.top - hostR.top, r.right - hostR.left, r.bottom - hostR.top] as [number, number, number, number])
    const list = [...this.items.values()].sort((a, b) => b.prio - a.prio)
    for (const it of list) {
      const d = Cesium.Cartesian3.distance(cp, it.pos)
      const to = Cesium.Cartesian3.subtract(it.pos, cp, this.s1)
      const win = d <= it.maxDist && Cesium.Cartesian3.dot(to, dir) > 0
        ? Cesium.SceneTransforms.worldToWindowCoordinates(this.scene, it.pos, this.s2) : undefined
      if (!win) { it.el.style.opacity = '0'; it.el.style.visibility = 'hidden'; continue }
      if (!it.w) { it.w = it.el.offsetWidth; it.h = it.el.offsetHeight }
      const box: [number, number, number, number] = [win.x - 6, win.y - it.h, win.x - 6 + it.w, win.y]
      const over = (b: [number, number, number, number]) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]
      const hit = occ.some(over) || (it.prio < 9 && placed.some(over))
      if (hit) { it.el.style.opacity = '0'; it.el.style.visibility = 'hidden'; continue }
      placed.push(box)
      it.el.style.visibility = 'visible'
      it.el.style.opacity = '1'
      it.el.style.transform = `translate3d(${Math.round(win.x)}px,${Math.round(win.y)}px,0)`
    }
  }
}
