import { useEffect, useState } from 'react'
import Logo from './Logo'
import { NAV_LINKS, HEARTH } from '../lib/hearth'

export default function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={`sticky top-[var(--cf-bar-h)] z-50 transition-colors duration-300 ${
        scrolled
          ? 'border-b border-[color-mix(in_srgb,var(--color-ash)_9%,transparent)] bg-[color-mix(in_srgb,var(--color-coal-950)_80%,transparent)] backdrop-blur-md'
          : 'border-b border-transparent'
      }`}
    >
      <nav className="shell flex h-16 items-center justify-between gap-4">
        <Logo />

        <div className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((l) => (
            <a
              key={l.to}
              href={l.to}
              className="mono text-xs uppercase tracking-[0.16em] text-ash-dim transition-colors hover:text-ember-bright"
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <a className="btn btn-ghost" href={HEARTH.github} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a className="btn btn-ember" href="#testnet">
            Run the testnet
          </a>
        </div>

        <button
          type="button"
          className="btn btn-ghost md:hidden"
          aria-expanded={open}
          aria-label="Toggle navigation"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Close' : 'Menu'}
        </button>
      </nav>

      {open && (
        <div className="border-t border-[color-mix(in_srgb,var(--color-ash)_9%,transparent)] bg-[color-mix(in_srgb,var(--color-coal-950)_94%,transparent)] backdrop-blur-md md:hidden">
          <div className="shell flex flex-col gap-1 py-4">
            {NAV_LINKS.map((l) => (
              <a
                key={l.to}
                href={l.to}
                onClick={() => setOpen(false)}
                className="mono py-2 text-sm uppercase tracking-[0.14em] text-ash-dim"
              >
                {l.label}
              </a>
            ))}
            <a
              className="btn btn-ember mt-3"
              href="#testnet"
              onClick={() => setOpen(false)}
            >
              Run the testnet
            </a>
          </div>
        </div>
      )}
    </header>
  )
}
