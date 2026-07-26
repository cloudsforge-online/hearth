import { useState, type CSSProperties, type ReactNode } from 'react'

type ImgProps = {
  /** Asset path without extension, e.g. "/assets/hearth-hero". Prefers .png, falls back to .svg. */
  name: string
  alt: string
  className?: string
  style?: CSSProperties
  /** Rendered if both the .png and .svg are missing (e.g. offline / not yet generated). */
  fallback?: ReactNode
  loading?: 'lazy' | 'eager'
  /** Decorative images get empty alt + aria-hidden so screen readers skip them. */
  decorative?: boolean
}

/**
 * asset-forge writes real art as .png; offline mode writes .svg. We can't know
 * which exists at build time, so start at .png and swap to .svg on error, then
 * to a caller-supplied fallback if neither is present.
 */
export default function Img({ name, alt, className, style, fallback, loading = 'lazy', decorative }: ImgProps) {
  const [src, setSrc] = useState(`${name}.png`)
  const [failed, setFailed] = useState(false)

  if (failed) return <>{fallback ?? null}</>

  return (
    <img
      src={src}
      alt={decorative ? '' : alt}
      aria-hidden={decorative || undefined}
      className={className}
      style={style}
      loading={loading}
      decoding="async"
      draggable={false}
      onError={() => {
        if (src.endsWith('.png')) setSrc(`${name}.svg`)
        else setFailed(true)
      }}
    />
  )
}
