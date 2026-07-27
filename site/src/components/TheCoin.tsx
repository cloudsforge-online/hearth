import Reveal from './Reveal'
import SectionHeading from './SectionHeading'
import Img from './Img'
import { COIN_FACTS, EMISSION_ROWS, HEARTH } from '../lib/hearth'

/** Small fallback if the coin render is missing here too. */
function CoinFallback() {
  return (
    <div
      aria-hidden="true"
      className="grid h-full w-full place-items-center rounded-full"
      style={{ background: 'radial-gradient(closest-side, var(--color-ember), var(--color-coalglow))' }}
    >
      <span className="mono text-sm font-bold text-[#2a0f06]">EMBER</span>
    </div>
  )
}

export default function TheCoin() {
  return (
    <section id="coin" className="section">
      <div className="shell">
        <SectionHeading
          eyebrow="The coin"
          title={
            <>
              One coin, built like <span className="text-ember-wash">money — not gold.</span>
            </>
          }
          lead="Disinflationary emission into a perpetual tail, offset by a burned base fee. Uncapped on purpose: a small, predictable holding cost keeps EMBER moving."
        />

        <div className="mt-14 grid gap-6 lg:grid-cols-[1fr_1.05fr] lg:items-start">
          {/* spec facts */}
          <Reveal className="panel panel-raised overflow-hidden">
            <div className="flex items-center gap-4 border-b border-[color-mix(in_srgb,var(--color-ash)_9%,transparent)] p-6">
              <div className="h-14 w-14 shrink-0">
                <Img
                  name="/assets/ember-coin"
                  alt={`${HEARTH.ticker} coin`}
                  className="h-full w-full object-contain"
                  fallback={<CoinFallback />}
                />
              </div>
              <div>
                <p className="font-display text-xl font-extrabold text-ash">
                  {HEARTH.coin} <span className="text-soot">·</span> {HEARTH.ticker}
                </p>
                <p className="mono text-xs text-soot">on the {HEARTH.network} network</p>
              </div>
            </div>
            <dl className="divide-y divide-[color-mix(in_srgb,var(--color-ash)_7%,transparent)]">
              {COIN_FACTS.map((f) => (
                <div key={f.k} className="flex items-baseline justify-between gap-6 px-6 py-3.5">
                  <dt className="mono text-[0.72rem] uppercase tracking-[0.12em] text-soot">{f.k}</dt>
                  <dd className="text-right text-sm font-medium text-ash">{f.v}</dd>
                </div>
              ))}
            </dl>
          </Reveal>

          {/* emission table */}
          <Reveal delay={80}>
            <div className="panel panel-raised overflow-hidden">
              <div className="flex items-center justify-between gap-4 border-b border-[color-mix(in_srgb,var(--color-ash)_9%,transparent)] p-6">
                <div>
                  <p className="font-display text-lg font-bold text-ash">Emission &amp; the fee burn</p>
                  <p className="mono text-xs text-soot">modeled — not a promise</p>
                </div>
                <span className="chip">net inflation → ~0%</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-right">
                  <thead>
                    <tr className="mono text-[0.66rem] uppercase tracking-[0.1em] text-soot">
                      <th className="px-4 py-3 text-left font-medium">Year</th>
                      <th className="px-4 py-3 font-medium">Reward</th>
                      <th className="px-4 py-3 font-medium">Issued/yr</th>
                      <th className="px-4 py-3 font-medium">Burned/yr</th>
                      <th className="px-4 py-3 font-medium">Supply</th>
                      <th className="px-4 py-3 font-medium">Net %</th>
                    </tr>
                  </thead>
                  <tbody className="mono text-sm">
                    {EMISSION_ROWS.map((r) => (
                      <tr
                        key={r.yr}
                        className="border-t border-[color-mix(in_srgb,var(--color-ash)_7%,transparent)] text-ash-dim"
                      >
                        <td className="px-4 py-3 text-left text-ash">{r.yr}</td>
                        <td className="px-4 py-3">{r.reward}</td>
                        <td className="px-4 py-3">{r.issued}</td>
                        <td className="px-4 py-3 text-ember-bright">{r.burned}</td>
                        <td className="px-4 py-3">{r.supply}</td>
                        <td className="px-4 py-3 text-ash">{r.net}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-[color-mix(in_srgb,var(--color-ash)_9%,transparent)] p-5">
                <p className="text-sm leading-relaxed text-ash-dim">
                  By year 10 net inflation is roughly <span className="text-ash">0.4%</span>; long-run it hovers near a
                  few tenths of a percent — and <span className="text-ash">falls</span> as usage (and burn) rises. More
                  spending tightens the money; idleness loosens it slightly. Exactly the incentive money should have.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
