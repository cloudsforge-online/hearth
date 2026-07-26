import Reveal from './Reveal'

const POINTS = [
  { k: 'No premine', v: 'Genesis holds no spendable balance. You can’t buy in early — you mine or you earn.' },
  { k: 'No ICO or sale', v: 'No founder or VC allocation. The launch maximizes independent holders from day one.' },
  {
    k: '10% Commons',
    v: '10% of every block accrues to an on-chain treasury, spendable only by hybrid on-chain governance.',
  },
]

export default function CommonsCallout() {
  return (
    <section className="section">
      <div className="shell">
        <Reveal className="panel-ember relative overflow-hidden p-8 md:p-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-24 left-1/2 h-56 w-[70%] -translate-x-1/2 rounded-full opacity-70 blur-3xl"
            style={{ background: 'radial-gradient(closest-side, rgba(255,90,30,0.35), transparent)' }}
          />
          <div className="relative grid gap-10 md:grid-cols-[1fr_1.1fr] md:items-center">
            <div>
              <p className="eyebrow flex items-center gap-2">
                <span className="chip-dot ember-pulse" />
                Fair launch · On-chain Commons
              </p>
              <h2 className="display mt-4 text-[clamp(1.8rem,4vw,2.8rem)] text-ash">
                No founders&apos; wallet.
                <br />
                <span className="text-ember-wash">A treasury you can audit.</span>
              </h2>
              <p className="mt-5 max-w-md leading-relaxed text-ash-dim">
                No multisig of founders, no foundation with a wallet nobody can see. Development is funded transparently,
                on-chain, and spending needs a proposal to pass hybrid governance — coin-weighted votes blended with
                one-node-one-vote to blunt pure plutocracy.
              </p>
            </div>

            <div className="grid gap-3">
              {POINTS.map((p) => (
                <div key={p.k} className="panel flex items-start gap-4 p-5">
                  <span className="mono mt-0.5 shrink-0 rounded-sm bg-[color-mix(in_srgb,var(--color-ember)_16%,transparent)] px-2 py-1 text-[0.68rem] uppercase tracking-[0.12em] text-ember-bright">
                    {p.k}
                  </span>
                  <p className="text-sm leading-relaxed text-ash-dim">{p.v}</p>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
