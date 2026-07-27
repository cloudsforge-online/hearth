import Reveal from './Reveal'
import SectionHeading from './SectionHeading'
import Img from './Img'
import { MINING_POINTS } from '../lib/hearth'

/** Fallback art tile — a warm hearth-side gradient — if the render is missing. */
function MiningFallback() {
  return (
    <div
      aria-hidden="true"
      className="h-full w-full"
      style={{
        background:
          'radial-gradient(80% 90% at 30% 100%, color-mix(in srgb, var(--color-ember) 45%, transparent), transparent 60%), linear-gradient(180deg, var(--color-coal-800), var(--color-coal-950))',
      }}
    />
  )
}

export default function Mining() {
  return (
    <section id="mining" className="section">
      <div className="shell">
        <SectionHeading
          eyebrow="Mining · Homefire"
          title={
            <>
              Mine EMBER by the fire on the{' '}
              <span className="text-ember-wash">computer you already own.</span>
            </>
          }
          lead="Homefire is a RandomX-class, memory-hard, CPU-only proof of work — non-outsourceable, so pools can’t form and a farm earns no more per dollar than your laptop."
        />

        <div className="mt-14 grid gap-6 lg:grid-cols-[0.95fr_1.05fr] lg:items-stretch">
          {/* generated art */}
          <Reveal className="panel panel-raised relative overflow-hidden">
            <div className="aspect-[4/3] w-full lg:h-full">
              <Img
                name="/assets/mining-home"
                alt="Someone mining EMBER on a home computer beside a glowing hearth"
                className="h-full w-full object-cover"
                fallback={<MiningFallback />}
              />
            </div>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'linear-gradient(180deg, transparent 50%, rgba(15,12,9,0.55) 100%)',
              }}
            />
            <div className="absolute bottom-0 left-0 right-0 flex flex-wrap items-center gap-2 p-5">
              <span className="chip">RandomX-class</span>
              <span className="chip">Memory-hard</span>
              <span className="chip">CPU-only</span>
              <span className="chip">Polite mining</span>
            </div>
          </Reveal>

          {/* pillars */}
          <div className="grid gap-4 sm:grid-cols-2">
            {MINING_POINTS.map((p, i) => (
              <Reveal key={p.title} delay={i * 60} className="panel flex h-full flex-col p-6">
                <span className="mono text-[0.7rem] text-soot">0{i + 1}</span>
                <h3 className="mt-2 font-display text-lg font-bold text-ash">{p.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ash-dim">{p.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
