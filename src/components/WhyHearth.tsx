import Reveal from './Reveal'
import SectionHeading from './SectionHeading'
import { WHY_ROWS } from '../lib/hearth'

export default function WhyHearth() {
  return (
    <section id="why" className="section">
      <div className="shell">
        <SectionHeading
          eyebrow="Why Hearth"
          title={
            <>
              Proof-of-work was <span className="text-ember-wash">one CPU, one vote.</span> Hearth gives that back.
            </>
          }
          lead="Bitcoin became a game for warehouse farms and a few pools, and almost everything since became a chip you hoard rather than money you spend. Hearth fixes the specific things that pushed ordinary people out."
        />

        <div className="mt-14 grid gap-4 md:hidden">
          {WHY_ROWS.map((r) => (
            <Reveal key={r.problem} className="panel p-5">
              <p className="mono text-[0.7rem] uppercase tracking-[0.12em] text-soot">The problem</p>
              <p className="mt-1 font-display text-lg font-bold text-ash">{r.problem}</p>
              <div className="seam my-4" />
              <p className="mono text-[0.7rem] uppercase tracking-[0.12em] text-ember-bright">What Hearth does</p>
              <p className="mt-1 text-sm leading-relaxed text-ash-dim">{r.solution}</p>
            </Reveal>
          ))}
        </div>

        {/* the problem/solution table, desktop */}
        <Reveal className="panel panel-raised mt-14 hidden overflow-hidden md:block">
          <div className="grid grid-cols-[1fr_1.4fr] border-b border-[color-mix(in_srgb,var(--color-ash)_9%,transparent)] bg-[color-mix(in_srgb,var(--color-coal-800)_50%,transparent)]">
            <div className="px-6 py-4">
              <span className="mono text-[0.7rem] uppercase tracking-[0.16em] text-soot">Big crypto problem</span>
            </div>
            <div className="border-l border-[color-mix(in_srgb,var(--color-ash)_9%,transparent)] px-6 py-4">
              <span className="mono text-[0.7rem] uppercase tracking-[0.16em] text-ember-bright">What Hearth does</span>
            </div>
          </div>
          {WHY_ROWS.map((r, i) => (
            <div
              key={r.problem}
              className={`grid grid-cols-[1fr_1.4fr] ${
                i < WHY_ROWS.length - 1
                  ? 'border-b border-[color-mix(in_srgb,var(--color-ash)_7%,transparent)]'
                  : ''
              }`}
            >
              <div className="px-6 py-5">
                <p className="font-display text-[1.05rem] font-bold leading-snug text-ash">{r.problem}</p>
              </div>
              <div className="border-l border-[color-mix(in_srgb,var(--color-ash)_9%,transparent)] px-6 py-5">
                <p className="text-sm leading-relaxed text-ash-dim">{r.solution}</p>
              </div>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  )
}
