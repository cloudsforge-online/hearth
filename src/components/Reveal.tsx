import { useEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode, type Ref } from 'react'

type RevealProps = {
  children: ReactNode
  delay?: number
  as?: keyof JSX.IntrinsicElements
  className?: string
}

/** Fades + lifts content into view on scroll. Reduced-motion friendly via CSS. */
export default function Reveal({ children, delay = 0, as = 'div', className = '' }: RevealProps) {
  const ref = useRef<HTMLElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true)
            io.disconnect()
          }
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const Tag = as as 'div'
  const style = { '--reveal-delay': `${delay}ms` } as CSSProperties

  return (
    <Tag ref={ref as Ref<HTMLDivElement>} className={`reveal ${shown ? 'is-in' : ''} ${className}`} style={style}>
      {children}
    </Tag>
  )
}
