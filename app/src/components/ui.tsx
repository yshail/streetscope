import type { ReactNode } from 'react'
import type { Basis } from '../lib/types'
import { BASIS_LABEL } from '../lib/model'

export function BasisChip({ b, children }: { b: Basis; children?: ReactNode }) {
  return <span className={'chip b-' + b}>{children ?? BASIS_LABEL[b]}</span>
}

export function Stat({ label, value, unit, b, sub }: { label: string; value: ReactNode; unit?: string; b?: Basis; sub?: ReactNode }) {
  return (
    <div className="py-2">
      <div className="flex items-center justify-between gap-3"><span className="label">{label}</span>{b && <BasisChip b={b} />}</div>
      <div className="mt-1 flex items-baseline gap-1.5"><span className="num text-[22px] font-semibold tracking-tight text-white">{value}</span>{unit && <span className="text-xs text-dim">{unit}</span>}</div>
      {sub && <div className="mt-0.5 text-[11.5px] leading-snug text-dim">{sub}</div>}
    </div>
  )
}

export function Panel({ title, kicker, onClose, children, className = '' }: { title: ReactNode; kicker?: ReactNode; onClose?: () => void; children: ReactNode; className?: string }) {
  return (
    <section className={'glass panel-in pointer-events-auto rounded-2xl ' + className}>
      <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0">
          {kicker && <div className="label mb-1">{kicker}</div>}
          <h2 className="truncate text-[17px] font-semibold tracking-tight text-white">{title}</h2>
        </div>
        {onClose && <button onClick={onClose} aria-label="Close panel" className="-mr-1 grid h-7 w-7 place-items-center rounded-lg text-dim hover:bg-white/5 hover:text-ink">×</button>}
      </header>
      <div className="hair" />
      {children}
    </section>
  )
}

export const fmt = (v: number | null | undefined, d = 1) => v == null || Number.isNaN(v) ? '–' : v.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d })
