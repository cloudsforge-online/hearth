import Logo from './Logo'
import { FOOTER_LINKS, HEARTH, STUDIO_URL } from '../lib/hearth'

export default function Footer() {
  return (
    <footer className="relative border-t border-[color-mix(in_srgb,var(--color-ash)_9%,transparent)] bg-[color-mix(in_srgb,var(--color-coal-950)_55%,transparent)]">
      <div className="shell grid gap-10 py-14 md:grid-cols-[1.6fr_1fr_1fr]">
        <div className="max-w-sm">
          <Logo />
          <p className="mt-4 text-sm leading-relaxed text-ash-dim">
            Hearth is a people-mined, ASIC-resistant proof-of-work cryptocurrency built to spend, not hoard. Fair launch,
            no premine, an on-chain Commons — money mined at home.
          </p>
          <p className="eyebrow mt-5">A {HEARTH.studio} project</p>
        </div>

        <nav className="flex flex-col gap-3">
          <span className="eyebrow mb-1">Build on it</span>
          {FOOTER_LINKS.build.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-ash-dim transition-colors hover:text-ember-bright"
            >
              {l.label}
            </a>
          ))}
          <a
            href={STUDIO_URL}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-ash-dim transition-colors hover:text-ember-bright"
          >
            CloudsForge studio
          </a>
        </nav>

        <nav className="flex flex-col gap-3">
          <span className="eyebrow mb-1">The network</span>
          {FOOTER_LINKS.network.map((l) => (
            <a key={l.label} href={l.href} className="text-sm text-ash-dim transition-colors hover:text-ash">
              {l.label}
            </a>
          ))}
        </nav>
      </div>

      <div className="seam" />
      <div className="shell flex flex-col items-start justify-between gap-2 py-6 md:flex-row md:items-center">
        <p className="mono text-xs text-soot">
          © {new Date().getFullYear()} Hearth · {HEARTH.coin} ({HEARTH.ticker}) · MIT licensed
        </p>
        <p className="mono text-xs text-soot">Pre-mainnet · Fair launch · No premine</p>
      </div>
    </footer>
  )
}
