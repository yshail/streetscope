import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Site } from '../lib/types'
import { type PointCloud, loadPoints } from '../lib/data'
import { Frame } from '../lib/geo'
import { BasisChip } from './ui'
import '../lib/gs.js'

declare global { interface Window { GS: any } }   // eslint-disable-line @typescript-eslint/no-explicit-any

const CLASSES = [
  { id: 1, name: 'Ground', col: '#8b8578' }, { id: 2, name: 'Road', col: '#7c93b8' }, { id: 3, name: 'Building', col: '#7dd3fc' },
  { id: 4, name: 'Vegetation', col: '#34d399' }, { id: 5, name: 'Water', col: '#3b82f6' }, { id: 0, name: 'Other', col: '#a78bfa' },
]

const VS = `attribute float cls; attribute vec3 color; uniform float uMask[6]; uniform float uSize; uniform float uScale; varying vec3 vC;
void main(){ int c=int(cls); float on=c==1?uMask[0]:c==2?uMask[1]:c==3?uMask[2]:c==4?uMask[3]:c==5?uMask[4]:uMask[5];
  vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv; gl_PointSize=on>0.5?max(1.5,uSize*uScale/-mv.z):0.0; vC=color; }`
const FS = `varying vec3 vC; void main(){ vec2 d=gl_PointCoord-0.5; float r=dot(d,d); if(r>0.25) discard; gl_FragColor=vec4(vC*(1.0-r*1.2),1.0); }`

/* Point-cloud inspection: real USGS LiDAR where it exists, otherwise the gaussian twin, clearly labelled as generated */
export function PointCloudViewer({ site, hourIdx, onClose }: { site: Site; hourIdx: number; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null), gsCv = useRef<HTMLCanvasElement>(null)
  const [pc, setPc] = useState<PointCloud | null | undefined>(undefined)
  const [mode, setMode] = useState<'lidar' | 'gauss'>('lidar')
  const [mask, setMask] = useState<Record<number, boolean>>({ 0: true, 1: true, 2: true, 3: true, 4: true, 5: true })
  const [color, setColor] = useState<'class' | 'height'>('class')
  const [picked, setPicked] = useState<{ cls: number; agl: number; elev: number; lat: number; lon: number; derived: boolean } | null>(null)
  const [measure, setMeasure] = useState(false)
  const [dist3, setDist3] = useState<{ d: number; h: number; v: number } | null>(null)
  const st = useRef<{ mat?: THREE.ShaderMaterial; geo?: THREE.BufferGeometry; pts?: THREE.Points; line?: THREE.Line; marks: THREE.Vector3[] }>({ marks: [] })

  useEffect(() => { let live = true; loadPoints(site).then(p => { if (live) { setPc(p); if (!p) setMode('gauss') } }); return () => { live = false } }, [site])

  useEffect(() => {
    if (pc === undefined) return
    const el = host.current!, R = site.twin.meta.radius_m
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.setSize(el.clientWidth, el.clientHeight); el.appendChild(renderer.domElement)
    const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, .5, 5000)
    cam.position.set(R * 1.1, R * .8, R * 1.1)
    const ctl = new OrbitControls(cam, renderer.domElement); ctl.enableDamping = true; ctl.target.set(0, 5, 0); ctl.maxPolarAngle = Math.PI * .49
    let gsr: any = null   // eslint-disable-line @typescript-eslint/no-explicit-any
    const s = st.current
    if (mode === 'lidar' && pc) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(pc.xyz, 3))
      geo.setAttribute('cls', new THREE.BufferAttribute(Float32Array.from(pc.cls, c => c & 0x7f), 1))
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pc.count * 3), 3))
      const mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: { uMask: { value: [1, 1, 1, 1, 1, 1] }, uSize: { value: .45 }, uScale: { value: 800 } } })
      const pts = new THREE.Points(geo, mat); scene.add(pts)
      Object.assign(s, { geo, mat, pts })
    } else if (window.GS) {
      try {
        gsr = new window.GS.Renderer(gsCv.current)
        const data = window.GS.fromTwin(site.twin); gsr.setData(data)
        const sh = site.twin.shade, n = sh.shape[1], per = n * n
        gsr.setShade(site.stack.subarray(hourIdx * per, (hourIdx + 1) * per), site.walk, n, sh.origin[0], sh.origin[1], n * sh.cell_m)
      } catch { gsr = null }
    }
    const ray = new THREE.Raycaster(); ray.params.Points = { threshold: .6 }
    const F = new Frame(site.twin.meta.center.lat, site.twin.meta.center.lon)
    const onClick = (e: MouseEvent) => {
      if (!s.pts || !pc) return
      const r = renderer.domElement.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), cam)
      const hit = ray.intersectObject(s.pts).find(h => { const c = pc.cls[h.index!] & 0x7f; return maskRef.current[c] })
      if (!hit) return
      const i = hit.index!, p = new THREE.Vector3(pc.xyz[i * 3], pc.xyz[i * 3 + 1], pc.xyz[i * 3 + 2]), ll = F.lonLat(p.x, p.z)
      setPicked({ cls: pc.cls[i] & 0x7f, derived: (pc.cls[i] & 0x80) > 0, agl: pc.agl[i], elev: p.y + pc.meta.ground_height_m, lon: ll[0], lat: ll[1] })
      if (measureRef.current) {
        s.marks = s.marks.length >= 2 ? [p] : [...s.marks, p]
        if (s.line) { scene.remove(s.line); s.line = undefined }
        if (s.marks.length === 2) {
          const [a, b] = s.marks
          s.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0x22d3ee }))
          scene.add(s.line)
          setDist3({ d: a.distanceTo(b), h: Math.hypot(a.x - b.x, a.z - b.z), v: Math.abs(a.y - b.y) })
        } else setDist3(null)
      }
    }
    renderer.domElement.addEventListener('click', onClick)
    const ro = new ResizeObserver(() => { renderer.setSize(el.clientWidth, el.clientHeight); cam.aspect = el.clientWidth / el.clientHeight; cam.updateProjectionMatrix() }); ro.observe(el)
    const sun = site.twin.shade.sun[hourIdx], az = sun.az * Math.PI / 180, elv = sun.el * Math.PI / 180
    let raf = 0
    const loop = () => {
      ctl.update()
      if (s.mat) s.mat.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan(cam.fov * Math.PI / 360))
      cam.updateMatrixWorld()
      if (gsr) gsr.render(cam.matrixWorldInverse.elements, cam.projectionMatrix.elements, { sun: [Math.sin(az) * Math.cos(elv), Math.max(.02, Math.sin(elv)), -Math.cos(az) * Math.cos(elv)], day: sun.el > 2 ? 1 : .15 })
      renderer.render(scene, cam)
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => { cancelAnimationFrame(raf); ro.disconnect(); renderer.domElement.removeEventListener('click', onClick); ctl.dispose(); renderer.dispose(); s.geo?.dispose(); s.mat?.dispose(); el.innerHTML = ''; Object.assign(s, { geo: undefined, mat: undefined, pts: undefined, line: undefined, marks: [] }) }
  }, [pc, mode, site, hourIdx])

  const maskRef = useRef(mask); maskRef.current = mask
  const measureRef = useRef(measure); measureRef.current = measure
  useEffect(() => {
    const s = st.current
    if (!s.mat || !s.geo || !pc) return
    s.mat.uniforms.uMask.value = [1, 2, 3, 4, 5, 0].map(c => mask[c] ? 1 : 0)
    const col = s.geo.getAttribute('color') as THREE.BufferAttribute, arr = col.array as Float32Array, tmp = new THREE.Color()
    const cc = Object.fromEntries(CLASSES.map(c => [c.id, new THREE.Color(c.col)]))
    for (let i = 0; i < pc.count; i++) {
      if (color === 'class') { const c = cc[pc.cls[i] & 0x7f] || cc[0]; arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b }
      else { tmp.setHSL(.58 - Math.min(1, pc.agl[i] / 40) * .58, .75, .38 + Math.min(1, pc.agl[i] / 40) * .2); arr[i * 3] = tmp.r; arr[i * 3 + 1] = tmp.g; arr[i * 3 + 2] = tmp.b }
    }
    col.needsUpdate = true
  }, [mask, color, pc, mode])

  const name = CLASSES.find(c => c.id === picked?.cls)?.name
  return (
    <div className="absolute inset-0 z-[15] bg-[radial-gradient(120%_90%_at_50%_25%,#13212f_0%,#05090f_60%,#020407_100%)]">
      <canvas ref={gsCv} className="absolute inset-0 h-full w-full" style={{ display: mode === 'gauss' ? 'block' : 'none' }} />
      <div ref={host} className="absolute inset-0" />
      <div className="glass panel-in pointer-events-auto absolute left-4 top-[72px] w-[300px] rounded-2xl p-4">
        <div className="flex items-center justify-between"><span className="label">Point cloud · {site.twin.meta.name}</span><button onClick={onClose} className="text-dim hover:text-ink" aria-label="Back to city">×</button></div>
        <div className="seg mt-3 w-full">
          <button className="flex-1" aria-pressed={mode === 'lidar'} disabled={!pc} onClick={() => setMode('lidar')}>LiDAR points</button>
          <button className="flex-1" aria-pressed={mode === 'gauss'} onClick={() => setMode('gauss')}>Gaussian twin</button>
        </div>
        {mode === 'lidar' && pc && <>
          <div className="mt-3 flex items-center gap-2"><BasisChip b="observed">Measured LiDAR</BasisChip><span className="num text-[12px] text-dim">{pc.count.toLocaleString()} points</span></div>
          <p className="mt-2 text-[11.5px] leading-snug text-dim">{pc.meta.source}.</p>
          <div className="mt-3 flex items-center justify-between"><span className="label">Classes</span>
            <div className="seg"><button aria-pressed={color === 'class'} onClick={() => setColor('class')}>Class</button><button aria-pressed={color === 'height'} onClick={() => setColor('height')}>Height</button></div></div>
          <div className="mt-2">
            {CLASSES.map(c => <button key={c.id} onClick={() => setMask(m => ({ ...m, [c.id]: !m[c.id] }))} className="flex w-full items-center gap-2.5 py-1 text-[12.5px]">
              <i className="h-2.5 w-2.5 rounded-full" style={{ background: c.col, opacity: mask[c.id] ? 1 : .25 }} /><span className="flex-1 text-left">{c.name}</span>
              <span className="num text-[11px] text-dim">{(pc.meta.classes[c.name.toLowerCase()] ?? 0).toLocaleString()}</span></button>)}
          </div>
          <p className="mt-2 text-[10.5px] leading-snug text-faint">{pc.meta.derived.toLocaleString()} points were unlabelled by the survey and classed by us. {pc.meta.derived_note}</p>
          <button onClick={() => { setMeasure(v => !v); setDist3(null); st.current.marks = [] }} className={'btn mt-3 w-full justify-center ' + (measure ? 'btn-primary' : '')}>{measure ? 'Measuring: click two points' : 'Measure distance'}</button>
        </>}
        {mode === 'gauss' && <>
          <div className="mt-3"><BasisChip b="computed">Generated, not measured</BasisChip></div>
          <p className="mt-2 text-[11.5px] leading-snug text-dim">{pc ? 'The same twin drawn as real 3D gaussian splats.' : 'No LiDAR survey covers this site, so this shows the twin drawn as real 3D gaussian splats.'} The gaussians are made from open map data, not trained from photos and not measured.</p>
        </>}
      </div>
      {(picked || dist3) && mode === 'lidar' && <div className="glass rise-in pointer-events-auto absolute right-4 top-[72px] w-[260px] rounded-2xl p-4 text-[12.5px]">
        {picked && <>
          <div className="flex items-center justify-between"><span className="label">Selected point</span><BasisChip b={picked.derived ? 'computed' : 'observed'}>{picked.derived ? 'Class derived' : 'Survey class'}</BasisChip></div>
          <div className="mt-2 text-[16px] font-semibold text-white">{name}</div>
          <div className="mt-2 grid grid-cols-2 gap-y-1.5"><span className="text-dim">Above ground</span><span className="num text-right">{picked.agl.toFixed(2)} m</span>
            <span className="text-dim">Elevation</span><span className="num text-right">{picked.elev.toFixed(2)} m</span>
            <span className="text-dim">Lat, lon</span><span className="num text-right">{picked.lat.toFixed(6)}, {picked.lon.toFixed(6)}</span></div>
        </>}
        {dist3 && <><div className="hair my-3" /><div className="label">Measurement</div>
          <div className="mt-1 num text-[20px] font-semibold text-cyan">{dist3.d.toFixed(2)} m</div>
          <div className="num text-dim">horizontal {dist3.h.toFixed(2)} m · vertical {dist3.v.toFixed(2)} m</div></>}
      </div>}
    </div>
  )
}
