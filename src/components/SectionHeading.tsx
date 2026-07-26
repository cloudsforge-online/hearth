import type { ReactNode } from 'react'
import Reveal from './Reveal'

type Props = {
  eyebrow: string
  title: ReactNode
  lead?: ReactNode
  className?: string
}

/** Consistent section header: mono eyebrow, display title, optional lead. */
export default function SectionHeading({ eyebrow, title, lead, className = '' }: Props) {
  return (
    <Reveal className={`max-w-3xl ${className}`}>
      <p className="eyebrow flex items-center gap-2">
        <span className="chip-dot" />
        {eyebrow}
      </p>
      <h2 className="display mt-4 text-[clamp(1.9rem,4.4vw,3.1rem)] text-ash">{title}</h2>
      {lead && <p className="mt-5 text-lg leading-relaxed text-ash-dim">{lead}</p>}
    </Reveal>
  )
}
