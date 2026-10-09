import { useEffect, useRef, useState } from 'react'
import { CityScene } from '../scene/CityScene'

/* Owns the Cesium scene. The rest of the app talks to it through the CityScene instance. */
export function CityViewport({ onReady }: { onReady: (s: CityScene) => void }) {
  const host = useRef<HTMLDivElement>(null), credits = useRef<HTMLDivElement>(null), ann = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let scene: CityScene | null = null
    try {
      scene = new CityScene(host.current!, credits.current!, ann.current!)
      onReady(scene)
    } catch (e) { setErr(String((e as Error).message || e)) }
    return () => { scene?.destroy() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="absolute inset-0">
      <div ref={host} className="absolute inset-0" />
      <div ref={ann} className="ann-layer" />
      <div ref={credits} className="credits" />
      {err && <div className="absolute inset-0 grid place-items-center text-dim text-sm">This view needs WebGL: {err}</div>}
    </div>
  )
}
