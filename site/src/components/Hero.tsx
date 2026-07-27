import type { CSSProperties } from 'react'
import Img from './Img'
import { HEARTH, HERO_STATS } from '../lib/hearth'

/** Fallback EMBER coin — a struck ember disc — if the render asset is absent. */
function CoinMark() {
  return (
    <svg viewBox="0 0 200 200" className="h-full w-full" aria-hidden="true">
      <defs>
        <radialGradient id="coinFace" cx="42%" cy="36%" r="72%">
          <stop offset="0%" stopColor="#ffd08a" />
          <stop offset="42%" stopColor="var(--color-ember)" />
          <stop offset="100%" stopColor="var(--color-coalglow)" />
        </radialGradient>
        <linearGradient id="coinRim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffcf87" />
          <stop offset="100%" stopColor="#7c2010" />
        </linearGradient>
      </defs>
      <circle cx="100" cy="100" r="92" fill="url(#coinRim)" />
      <circle cx="100" cy="100" r="80" fill="url(#coinFace)" />
      <path
        d="M100 44c3.4 11 3 19-3 25.5-3.6-3-5.1-7.2-4.8-12.6-9 6.7-14.2 15.7-14.2 25.7 0 13 9.4 22.4 22 22.4s22-9.4 22-22.4c0-9.4-4.8-18-13.2-25.5.9 7.2-.9 12.6-5.7 16.8C121.3 63 121.9 54 100 44Z"
        fill="#2a0f06"
        opacity="0.82"
      />
      <text
        x="100"
        y="150"
        textAnchor="middle"
        fontFamily="'JetBrains Mono', monospace"
        fontSize="20"
        fontWeight="700"
        fill="#2a0f06"
        opacity="0.85"
      >
        EMBER
      </text>
    </svg>
  )
}

/** A handful of sparks drifting up from the hearth, decorative + reduced-motion aware. */
function Sparks() {
  const sparks = [
    { left: '12%', dur: 6.5, delay: 0 },
    { left: '28%', dur: 5.2, delay: 1.4 },
    { left: '46%', dur: 7.1, delay: 0.6 },
    { left: '63%', dur: 5.8, delay: 2.1 },
    { left: '78%', dur: 6.9, delay: 1 },
    { left: '90%', dur: 5.5, delay: 2.6 },
  ]
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-40">
      {sparks.map((s, i) => (
        <span
          key={i}
          className="spark"
          style={{ left: s.left, '--spark-dur': `${s.dur}s`, '--spark-delay': `${s.delay}s` } as CSSProperties}
        />
      ))}
    </div>
  )
}

export default function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* generated hearth key art, layered under the ambient glow so it degrades gracefully */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <Img
          name="/assets/hearth-hero"
          alt=""
          decorative
          loading="eager"
          className="h-full w-full object-cover opacity-[0.28]"
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(90% 70% at 78% 12%, transparent, rgba(15,12,9,0.35) 62%), linear-gradient(180deg, rgba(15,12,9,0.55) 0%, rgba(15,12,9,0.72) 55%, var(--color-coal-900) 100%)',
          }}
        />
      </div>

      {/* mantle line — the lip of the hearth */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[color-mix(in_srgb,var(--color-ember)_45%,transparent)] to-transparent"
      />
      <Sparks />

      <div className="shell grid items-center gap-14 pb-20 pt-16 md:pb-28 md:pt-24 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10">
        {/* --- pitch --- */}
        <div className="max-w-2xl">
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <span className="chip">
              <span className="chip-dot ember-pulse" />
              {HEARTH.network} · {HEARTH.coin} ({HEARTH.ticker})
            </span>
          </div>

          <h1 className="display text-[clamp(2.6rem,7vw,5.1rem)] text-ash">
            Money
            <br />
            <span className="text-ember-wash">mined at home.</span>
          </h1>

          <p className="mt-7 max-w-xl text-lg leading-relaxed text-ash-dim">
            <span className="text-ash">Hearth</span> is {HEARTH.pitch.charAt(0).toLowerCase() + HEARTH.pitch.slice(1)}{' '}
            {HEARTH.sub}
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <a className="btn btn-ember" href="#testnet">
              Run the testnet
            </a>
            <a className="btn btn-ghost" href={HEARTH.whitepaper} target="_blank" rel="noreferrer">
              Read the whitepaper
            </a>
          </div>

          <dl className="mt-12 grid max-w-xl grid-cols-2 gap-6 border-t border-[color-mix(in_srgb,var(--color-ash)_9%,transparent)] pt-6 sm:grid-cols-4">
            {HERO_STATS.map((s) => (
              <div key={s.l}>
                <dt className="stat-k text-2xl md:text-[1.7rem]">{s.k}</dt>
                <dd className="stat-l mt-1">{s.l}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* --- signature: the EMBER coin over its glow --- */}
        <div className="relative flex items-center justify-center">
          <div
            aria-hidden="true"
            className="absolute -inset-4 -z-10 rounded-full opacity-80 blur-3xl flame-flicker"
            style={{ background: 'radial-gradient(closest-side, rgba(255,90,30,0.32), transparent 72%)' }}
          />
          <div className="relative aspect-square w-[min(78vw,26rem)]">
            <Img
              name="/assets/ember-coin"
              alt={`The ${HEARTH.ticker} coin`}
              loading="eager"
              className="h-full w-full object-contain drop-shadow-[0_24px_60px_rgba(255,90,30,0.28)]"
              fallback={<CoinMark />}
            />
          </div>
        </div>
      </div>
    </section>
  )
}
