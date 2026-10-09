import type { Metric, Rec } from '../lib/model'
import { BasisChip, fmt } from './ui'

/* Before / Proposed: choose interventions, toggle the state, read a few comparable metrics */
export function SimulationController({ recs, chosen, toggle, proposed, setProposed, metrics, junctionName }: {
  recs: Rec[]; chosen: Set<string>; toggle: (id: string) => void; proposed: boolean; setProposed: (v: boolean) => void; metrics: Metric[]; junctionName: string
}) {
  return (
    <>
      <div className="pointer-events-none absolute right-4 top-[72px] z-10 w-[372px]">
        <section className="glass panel-in pointer-events-auto rounded-2xl">
          <div className="px-5 pt-4 pb-3"><div className="label">Simulation · {junctionName}</div><h2 className="mt-1 text-[17px] font-semibold text-white">Interventions</h2></div>
          <div className="hair" />
          <div className="scroll-thin max-h-[34vh] overflow-y-auto py-1">
            {recs.map(r => (
              <button key={r.id} onClick={() => toggle(r.id)} className="flex w-full items-start gap-3 px-5 py-2.5 text-left hover:bg-white/[.03]">
                <span className="switch mt-0.5" role="switch" aria-checked={chosen.has(r.id)} aria-label={r.title} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2"><span className="text-[13px] font-medium text-white">{r.title}</span><BasisChip b={r.basis}>{r.basis === 'proposed' ? 'Hypothetical' : undefined}</BasisChip></span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-dim">{r.assumption}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="hair" />
          <div className="px-5 py-3 text-[11px] leading-relaxed text-faint">Each traffic fix was re-run on its own in the screening model; the tool does not simulate fixes together, so only one traffic fix is active at a time. Nothing here is an engineering design.</div>
        </section>
      </div>
      <BeforeAfterComparison metrics={metrics} proposed={proposed} setProposed={setProposed} />
    </>
  )
}

export function BeforeAfterComparison({ metrics, proposed, setProposed }: { metrics: Metric[]; proposed: boolean; setProposed: (v: boolean) => void }) {
  return (
    <div className="pointer-events-auto absolute bottom-[76px] left-1/2 z-10 -translate-x-1/2">
      <div className="mb-2 flex justify-center">
        <div className="glass seg !rounded-xl !p-1" role="tablist" aria-label="State">
          <button aria-pressed={!proposed} onClick={() => setProposed(false)}>Current</button>
          <button aria-pressed={proposed} onClick={() => setProposed(true)} className={proposed ? '!bg-violet/20 !text-violet-100 !shadow-[inset_0_0_0_1px_rgba(167,139,250,.5)]' : ''}>Proposed</button>
        </div>
      </div>
      <div className="glass rise-in flex rounded-2xl px-2 py-2.5">
        {metrics.map(m => {
          const v = proposed ? m.after : m.before, changed = m.after != null && m.before != null && Math.abs(m.after - m.before) > 1e-9
          const good = changed && (m.better === 'lower' ? m.after! < m.before! : m.after! > m.before!)
          return (
            <div key={m.key} className="min-w-[118px] border-r border-line px-3.5 last:border-0">
              <div className="label truncate !text-[9px]">{m.label}</div>
              <div className="mt-1 flex items-baseline gap-1">
                <span className={'num text-[19px] font-semibold tracking-tight ' + (proposed && changed ? (good ? 'text-emerald' : 'text-coral') : 'text-white')}>{m.key === 'delay' && v != null && v > 0 ? '+' : ''}{fmt(v, m.digits ?? 1)}</span>
                <span className="text-[10.5px] text-dim">{m.unit}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5"><span className={'chip !px-1 !py-0.5 !text-[8px] b-' + m.basis}>{m.basis}</span>{proposed && changed && <span className="num text-[10px] text-dim">was {fmt(m.before, m.digits ?? 1)}</span>}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
