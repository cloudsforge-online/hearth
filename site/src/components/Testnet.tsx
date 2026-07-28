import Reveal from './Reveal'
import SectionHeading from './SectionHeading'
import {
  HEARTH,
  TESTNET_BOOT,
  TESTNET_NODES,
  TESTNET_QUERY,
  TESTNET_SUPPLY,
} from '../lib/hearth'

export default function Testnet() {
  return (
    <section id="testnet" className="section">
      <div className="shell">
        <SectionHeading
          eyebrow="Run the testnet"
          title={
            <>
              A three-node EMBER network,{' '}
              <span className="text-ember-wash">booting on your machine.</span>
            </>
          }
          lead="The repo ships a Docker Compose testnet — a seed plus miners gossiping over P2P, with a bundled web wallet and live block explorer. No accounts, no faucet signup: bring it up and query the chain."
        />

        <div className="mt-14 grid gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
          {/* commands */}
          <Reveal className="panel panel-raised overflow-hidden">
            <div className="border-b border-[color-mix(in_srgb,var(--color-ash)_9%,transparent)] px-6 py-4">
              <p className="mono text-[0.7rem] uppercase tracking-[0.14em] text-soot">1 — Boot the network</p>
            </div>
            <div className="p-6">
              <pre className="codeblock">
                <span className="tok-comment"># seed + 2 miners + web wallet & explorer</span>
                {'\n'}
                <span className="tok-cmd">docker compose</span> <span className="tok-flag">-f</span>{' '}
                hearth/docker-compose.testnet.yml up <span className="tok-flag">--build</span>
              </pre>

              <p className="mono mt-6 text-[0.7rem] uppercase tracking-[0.14em] text-soot">2 — Query a node</p>
              <pre className="codeblock mt-3">
                <span className="tok-comment"># node RPCs on :8645 · :8647 · :8649</span>
                {'\n'}
                <span className="tok-cmd">curl</span> localhost:8645/info
                {'\n'}
                <span className="tok-cmd">curl</span> localhost:8645/supply
              </pre>
              <p className="mono mt-4 break-all text-xs text-soot">
                {TESTNET_BOOT}
                <span className="sr-only">
                  ; {TESTNET_QUERY}; {TESTNET_SUPPLY}
                </span>
              </p>
            </div>
          </Reveal>

          {/* nodes + web links */}
          <div className="grid gap-6">
            <Reveal delay={60} className="panel p-6">
              <p className="font-display text-lg font-bold text-ash">The three nodes</p>
              <p className="mt-1 text-sm text-ash-dim">Each exposes an HTTP / JSON-RPC / SSE endpoint.</p>
              <ul className="mt-5 space-y-2">
                {TESTNET_NODES.map((n) => (
                  <li
                    key={n.name}
                    className="flex items-center justify-between gap-4 rounded-sm bg-[color-mix(in_srgb,var(--color-coal-950)_60%,transparent)] px-4 py-3"
                  >
                    <span className="mono text-sm text-ash">{n.name}</span>
                    <span className="mono text-sm text-ember-bright">{n.rpc}</span>
                  </li>
                ))}
              </ul>
            </Reveal>

            <Reveal delay={120} className="panel p-6">
              <p className="font-display text-lg font-bold text-ash">Then open the web experience</p>
              <p className="mt-1 text-sm leading-relaxed text-ash-dim">
                The bundle ships a <span className="text-ash">web wallet</span>, a{' '}
                <span className="text-ash">browser miner</span> and a live{' '}
                <span className="text-ash">block explorer</span>, all reading the running chain — plus a
                mockup of an “Accept EMBER” merchant button, which simulates its settlement and is not
                yet an SDK you can take a payment with.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <a className="btn btn-ember" href={HEARTH.explorer} target="_blank" rel="noreferrer">
                  Open the explorer
                </a>
                <a className="btn btn-ghost" href={HEARTH.github} target="_blank" rel="noreferrer">
                  Read the docs
                </a>
              </div>
              <p className="mono mt-5 text-xs text-soot">
                Pre-mainnet: consensus, the Rust core and the Tab channel layer all still need audits and a
                public testnet before launch. The Rust core is a benchmark and a set of libraries today, not a
                second node.
              </p>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  )
}
