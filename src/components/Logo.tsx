import { Link } from 'react-router-dom'
import Img from './Img'
import { HEARTH } from '../lib/hearth'

/** Inline flame emblem — used if the generated Hearth logo asset is missing. */
function FlameMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true" className="shrink-0">
      <path
        d="M16 5c1.1 3.6 1 6.2-1 8.4-1.2-1-1.7-2.4-1.6-4.2C10.6 11.4 9 14.4 9 17.7 9 22 12.1 25 16 25s7-3 7-7.3c0-3.1-1.6-6-4.4-8.5.3 2.4-.3 4.2-1.9 5.6C15.4 12 15.6 9 16 5Z"
        fill="url(#logoFlame)"
      />
      <defs>
        <linearGradient id="logoFlame" x1="16" y1="5" x2="16" y2="25" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--color-flame)" />
          <stop offset="0.55" stopColor="var(--color-ember)" />
          <stop offset="1" stopColor="var(--color-coalglow)" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/** Hearth wordmark — generated emblem asset with an inline-flame fallback. */
export default function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className="group flex items-center gap-2.5" aria-label={`${HEARTH.network} — home`}>
      <Img
        name="/assets/hearth-logo"
        alt={`${HEARTH.network} emblem`}
        decorative
        loading="eager"
        className="h-[26px] w-[26px] shrink-0 object-contain"
        fallback={<FlameMark />}
      />
      {!compact && (
        <span className="font-display text-[1.05rem] font-extrabold tracking-tight text-ash">
          Hearth<span className="text-soot"> · EMBER</span>
        </span>
      )}
    </Link>
  )
}
