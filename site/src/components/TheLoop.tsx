import Reveal from './Reveal'
import SectionHeading from './SectionHeading'
import { FORGE_PAY_URL, HEARTH, LOOP_STEPS } from '../lib/hearth'

/**
 * The one thing this site never said: what EMBER is for once you have mined it.
 * Kept deliberately short and stated at the same honesty as the testnet
 * section — the loop is built, the coin is pre-mainnet, and both are said here.
 */
export default function TheLoop() {
  return (
    <section id="loop" className="section">
      <div className="shell">
        <SectionHeading
          eyebrow="Mine · convert · spend"
          title={
            <>
              Mined at home. <span className="text-ember-wash">Spent across CloudsForge.</span>
            </>
          }
          lead="EMBER is not a coin looking for something to buy. Hearth is one of the things CloudsForge makes, and EMBER is how you pay for the rest of them — a currency you produce yourself, on hardware you already own, that settles real charges in real products."
        />

        <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {LOOP_STEPS.map((s, i) => (
            <Reveal key={s.verb} delay={i * 70} className="panel relative flex h-full flex-col p-6">
              <span className="mono text-[0.7rem] text-soot">0{i + 1}</span>
              <h3 className="mt-2 font-display text-xl font-extrabold text-ash">{s.verb}</h3>
              <p className="mono mt-1 text-[0.7rem] uppercase tracking-[0.12em] text-ember-bright">
                {s.where}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-ash-dim">{s.body}</p>
            </Reveal>
          ))}
        </div>

        <Reveal delay={120} className="panel panel-raised mt-6 p-6 md:p-8">
          <div className="grid gap-6 md:grid-cols-[1.4fr_1fr] md:items-center">
            <div>
              <p className="mono text-[0.7rem] uppercase tracking-[0.14em] text-soot">
                Where this actually is
              </p>
              <p className="mt-3 text-sm leading-relaxed text-ash-dim">
                <span className="text-ash">EMBER is pre-mainnet.</span> The network you can run today
                is a testnet: the coin has no market, no price, and nothing mined on it is worth
                money. The path off it is built and running — Forge Pay reads the Hearth chain, and
                custody uses the node’s own key scheme — but it credits deposits at the chain tip
                rather than at a confirmation depth, which is one of the things that has to be fixed
                before any of it holds real value. Treat every EMBER you mine now as a rehearsal.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 md:justify-end">
              <a className="btn btn-ember" href={HEARTH.emberWallet} target="_blank" rel="noreferrer">
                Open the web wallet
              </a>
              <a className="btn btn-ghost" href={FORGE_PAY_URL} target="_blank" rel="noreferrer">
                Your CloudsForge wallet
              </a>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
