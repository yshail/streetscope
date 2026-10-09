import type { Rec } from '../lib/model'
import { BasisChip, Panel } from './ui'

/* Compare interventions on one chart: modelled effect against assumed cost. Hypothetical items sit in their own lane
   because there is no model behind their effect. */
const SHORT: Record<string, string> = { bus_lane: 'Bus lane', signal_retiming: 'Signals', foot_overbridge: 'Overbridge', route_diversion: 'Diversion', add_lane: 'Extra lane' }

export function CompareView({ recs, onPreview, onClose, junctionName }: { recs: Rec[]; onPreview: (r: Rec) => void; onClose: () => void; junctionName: string }) {
  const modelled = recs.filter(r => r.sol), other = recs.filter(r => !r.sol)
  const W = 340, H = 190, L = 34, B = 26, T = 12, Rr = 12
  const maxCost = Math.max(10, ...modelled.map(r => r.costLakh)), minEff = Math.min(-5, ...modelled.map(r => r.sol!.area_load_change_pct))
  const X = (c: number) => L + Math.log10(1 + c) / Math.log10(1 + maxCost) * (W - L - Rr), Y = (e: number) => T + (e / minEff) * (H - T - B)
  return (
    <div className="pointer-events-none absolute right-4 top-[72px] z-10 w-[392px]">
      <Panel kicker={'Compare · ' + junctionName} title="Effect against cost" onClose={onClose}>
        <div className="px-5 pt-3">
          <div className="flex items-center justify-between"><span className="label">Peak load change on the worst approach</span><BasisChip b="simulated" /></div>
          <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 w-full" role="img" aria-label="Simulated load change against assumed cost">
            {[0, .5, 1].map(f => <line key={f} x1={L} x2={W - Rr} y1={T + f * (H - T - B)} y2={T + f * (H - T - B)} stroke="rgba(148,178,210,.12)" />)}
            <text x={L - 6} y={T + 4} textAnchor="end" fontSize="9" fill="#8a9bb0" className="num">0%</text>
            <text x={L - 6} y={H - B + 3} textAnchor="end" fontSize="9" fill="#8a9bb0" className="num">{Math.round(minEff)}%</text>
            <text x={L} y={H - 6} fontSize="9" fill="#8a9bb0">cheaper</text><text x={W - Rr} y={H - 6} fontSize="9" fill="#8a9bb0" textAnchor="end">assumed cost, log scale →</text>
            {modelled.map(r => {
              const cx = X(r.costLakh), cy = Y(r.sol!.area_load_change_pct)
              return <g key={r.id} className="cursor-pointer" onClick={() => onPreview(r)}>
                <circle cx={cx} cy={cy} r={r.sol!.recommended ? 7 : 5} fill={r.sol!.recommended ? 'rgba(167,139,250,.35)' : 'rgba(251,191,36,.25)'} stroke={r.sol!.recommended ? '#a78bfa' : '#fbbf24'} strokeWidth="1.5" />
                <text x={cx > W * .62 ? cx - 9 : cx + 9} y={cy + 3} fontSize="10" fill="#e6edf5" textAnchor={cx > W * .62 ? 'end' : 'start'}>{SHORT[r.kind] || r.title}</text>
              </g>
            })}
          </svg>
        </div>
        <div className="hair mx-5 my-2" />
        <div className="scroll-thin max-h-[24vh] overflow-y-auto pb-2">
          {[...modelled, ...other].map(r => (
            <button key={r.id} onClick={() => onPreview(r)} className="grid w-full grid-cols-[1fr_auto] gap-x-3 px-5 py-2 text-left hover:bg-white/[.03]">
              <span className="text-[13px] text-white">{r.title}</span>
              <span className="num text-right text-[12.5px] text-ink">₹ {r.costLakh >= 100 ? (r.costLakh / 100).toFixed(1) + ' cr' : r.costLakh.toFixed(1) + ' L'}</span>
              <span className="text-[11.5px] text-dim">{r.effect}</span>
              <span className="text-right"><BasisChip b={r.basis}>{r.basis === 'proposed' ? 'Hypothetical' : undefined}</BasisChip></span>
            </button>
          ))}
        </div>
        <div className="px-5 pb-4 text-[11px] text-faint">Costs are assumed unit rates, not quotes. Click any item to preview it in 3D.</div>
      </Panel>
    </div>
  )
}
