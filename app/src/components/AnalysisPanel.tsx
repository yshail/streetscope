import { useState } from 'react'
import type { Site } from '../lib/types'
import type { Finding, Junction, Rec } from '../lib/model'
import { type DoctorAnswer, askDoctor, modelName } from '../lib/services'
import { BasisChip, Panel } from './ui'

export function AnalysisPanel({ site, j, state, found, recs, onFocus, onPickRec, onClose }: {
  site: Site; j: Junction; state: 'scanning' | 'done'; found: Finding[]; recs: Rec[]
  onFocus: (x: number, z: number) => void; onPickRec: (r: Rec) => void; onClose: () => void
}) {
  const [ai, setAi] = useState<DoctorAnswer | null>(null), [aiBusy, setAiBusy] = useState(false), [aiErr, setAiErr] = useState('')
  const explain = async () => {
    setAiBusy(true); setAiErr(''); setAi(null)
    try {
      setAi(await askDoctor(site.id, { question: `Explain the main problems at the junction of ${j.roads.slice(0, 2).join(' and ') || 'the busiest junction'} and which fix to study first. Use the traffic and shade tools.` }))
    } catch (e) { setAiErr('The AI doctor is not running. Start it with: python scripts/dev_api.py') }
    setAiBusy(false)
  }
  return (
    <div className="pointer-events-none absolute right-4 top-[72px] z-10 w-[392px]">
      <Panel kicker={state === 'scanning' ? 'Analyzing area…' : 'Area analysis · 160 m radius'} title={j.name} onClose={onClose}>
        <div className="scroll-thin max-h-[calc(100vh-190px)] overflow-y-auto">
          {state === 'scanning' && <div className="px-5 py-5"><div className="scanbar h-[2px] rounded bg-cyan/20" /><div className="mt-3 text-[12.5px] text-dim">Reading roads, green space, transit stops and crossings around the junction…</div></div>}
          {state === 'done' && <>
            <div className="px-5 pt-3"><div className="label mb-2">Findings</div></div>
            {found.map((f, i) => (
              <button key={f.id} onClick={() => onFocus(f.at[0], f.at[1])} className="rise-in block w-full px-5 py-2.5 text-left hover:bg-white/[.03]" style={{ animationDelay: i * 140 + 'ms' }}>
                <div className="flex items-center justify-between gap-2"><span className="text-[13.5px] font-medium text-white"><span className="num mr-2 text-cyan">{i + 1}</span>{f.title}</span><BasisChip b={f.basis} /></div>
                <div className="mt-1 pl-5 text-[12px] leading-snug text-dim">{f.detail}</div>
              </button>
            ))}
            <div className="hair mx-5 my-2" />
            <div className="px-5"><div className="label mb-1.5">Possible interventions</div></div>
            {recs.map((r, i) => (
              <button key={r.id} onClick={() => onPickRec(r)} className="rise-in group block w-full px-5 py-2.5 text-left hover:bg-violet/[.06]" style={{ animationDelay: 450 + i * 90 + 'ms' }}>
                <div className="flex items-center justify-between gap-2"><span className="text-[13px] font-medium text-white group-hover:text-violet">{r.title}</span><BasisChip b={r.basis}>{r.basis === 'proposed' ? 'Hypothetical' : r.basis === 'simulated' ? 'Simulated' : 'Computed'}</BasisChip></div>
                <div className="mt-0.5 text-[12px] text-dim">{r.effect}</div>
              </button>
            ))}
            <div className="px-5 pb-1 pt-1 text-[11px] text-faint">Simulated and computed effects come from the twin's models. Hypothetical items have no model behind them and need a study.</div>
            <div className="hair mx-5 my-3" />
            <div className="px-5 pb-4">
              <button className="btn w-full justify-center" onClick={explain} disabled={aiBusy}>
                {aiBusy ? <span className="flex items-center gap-2"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-cyan" />Claude is calling the measuring tools…</span> : 'Explain with Claude'}
              </button>
              {aiErr && <div className="mt-2 text-[12px] text-coral">{aiErr}</div>}
              {ai && <div className="rise-in mt-3 rounded-xl border border-line bg-white/[.02] p-3">
                <div className="mb-1.5 flex items-center justify-between"><span className="label">{ai.llm ? modelName(ai.llm.model) + ' · ' + ai.llm.provider : 'Offline templates'}</span>
                  <span className={'chip ' + (ai.verified ? 'b-computed' : 'b-simulated')}>{ai.verified ? 'All numbers checked' : ai.unverified_numbers.length + ' unchecked'}</span></div>
                <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink/90" dangerouslySetInnerHTML={{ __html: md(ai.answer) }} />
                <div className="mt-2 font-mono text-[10px] text-faint">tools: {ai.tools_called.map(t => t.tool).join(', ')}</div>
              </div>}
            </div>
          </>}
        </div>
      </Panel>
    </div>
  )
}

const md = (t: string) => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)).replace(/^#+\s*(.+)$/gm, '<b>$1</b>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
