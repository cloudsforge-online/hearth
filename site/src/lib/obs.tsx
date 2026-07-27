/* ------------------------------------------------------------------ *
 * CloudsForge — browser observability
 *
 * CANONICAL COPY. Vendored into every frontend as `src/lib/obs.tsx`.
 * Fix it here first, then re-copy. Same reasoning as service-obs.ts: the
 * shared packages publish to npm, and this must not need a release cycle.
 *
 * Requires `@cloudsforge/shared` >= 0.2.0 for the `/products` subpath.
 *
 * Before this, a browser-side failure produced no record anywhere in the
 * system. A render throw was a white page, and nobody found out unless a user
 * described it.
 *
 * Usage, in src/main.tsx:
 *
 *   import { installGlobalErrorHandlers, ErrorBoundary } from './lib/obs.js'
 *   installGlobalErrorHandlers('admin')
 *   createRoot(el).render(
 *     <ErrorBoundary app="admin"><App /></ErrorBoundary>
 *   )
 * ------------------------------------------------------------------ */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { KNOWN_SUBS } from '@cloudsforge/shared/products'

/* ============================ where to send ======================== */

/*
 * The subdomain list is READ from the registry, not restated here.
 *
 * It used to be a literal Set in this file, and the canonical copy drifted
 * behind its own copies: `'crucible'` was added to all five vendored `obs.tsx`
 * files and never to this one, so the file everybody is told to copy *from* was
 * the only stale one. A list that is written down twice is a list that will
 * disagree with itself.
 *
 * `@cloudsforge/shared/products` is a zero-dependency subpath — no zod, no
 * runtime, just the registry — so importing it here costs a bundle nothing and
 * does not reintroduce the release-cycle coupling this file exists to avoid.
 * Adding a product is now one registry entry: every app's obs client learns the
 * new subdomain when it picks up the package.
 */

/**
 * Resolve Lantern's base URL at runtime, the same way `cloudsforgeHosts()` in
 * `@cloudsforge/ui` resolves everything else — so one static bundle works in
 * every environment and nothing is baked in at build time.
 */
export function lanternUrl(): string {
  const host = typeof window === 'undefined' ? '' : window.location.hostname
  if (!host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) {
    return 'http://localhost:4010'
  }
  const parts = host.split('.')
  const apex = parts.length > 2 && KNOWN_SUBS.has(parts[0]) ? parts.slice(1).join('.') : host
  return `https://lantern.${apex}`
}

/* ============================== reporting ========================== */

export interface ClientReport {
  app: string
  level?: 'error' | 'warn' | 'info' | 'fatal'
  type?: string
  message: string
  stack?: string | null
  url?: string
  route?: string
  requestId?: string | null
  statusCode?: number | null
  context?: Record<string, unknown>
}

let appName = 'unknown'

// One broken render can fire the same error hundreds of times a second. Report
// each distinct fault once per session and cap the total: the point is to learn
// that it happened, not to DDoS the log service from the browser.
const seen = new Set<string>()
let sent = 0
const MAX_REPORTS = 40

/** Best effort by design: reporting a failure must never cause one. */
export function report(payload: ClientReport): void {
  try {
    const key = `${payload.type ?? ''}|${payload.message}|${(payload.stack ?? '').slice(0, 200)}`
    if (seen.has(key) || sent >= MAX_REPORTS) return
    seen.add(key)
    sent++

    const body = JSON.stringify({
      ...payload,
      app: payload.app || appName,
      url: payload.url ?? window.location.href,
      route: payload.route ?? window.location.pathname,
      level: payload.level ?? 'error',
    })

    const endpoint = `${lanternUrl()}/ingest/client`

    // sendBeacon survives the page being torn down, which is exactly when the
    // interesting errors happen. It cannot set a content type, so the server
    // parses the body without relying on one.
    if (navigator.sendBeacon?.(endpoint, new Blob([body], { type: 'text/plain' }))) return

    void fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      mode: 'cors',
    }).catch(() => {
      // Lantern being unreachable is not the user's problem and must not
      // surface as one.
    })
  } catch {
    // Ditto for anything above throwing.
  }
}

/**
 * Catch what React cannot: errors outside the render tree, and rejected
 * promises nobody awaited. Both were previously silent.
 */
export function installGlobalErrorHandlers(app: string): void {
  appName = app

  window.addEventListener('error', (event) => {
    // Failed <img>/<script> loads arrive here too and are not app faults.
    if (!event.error && !event.message) return
    report({
      app,
      type: event.error?.name ?? 'WindowError',
      message: event.error?.message ?? event.message,
      stack: event.error?.stack ?? `${event.filename}:${event.lineno}:${event.colno}`,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    report({
      app,
      type: reason?.name ?? 'UnhandledRejection',
      message: reason?.message ?? String(reason),
      stack: reason?.stack ?? null,
      requestId: reason?.requestId ?? null,
      statusCode: reason?.status ?? null,
    })
  })
}

/* ============================ error boundary ======================= */

interface BoundaryProps {
  app: string
  children: ReactNode
}

interface BoundaryState {
  error: Error | null
}

/**
 * The difference between a white page and a page that tells you what happened.
 *
 * Deliberately dependency-free and inline-styled: it has to render correctly
 * when the thing that broke might be the stylesheet, the router, or the design
 * system.
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    report({
      app: this.props.app,
      type: error.name,
      message: error.message,
      stack: `${error.stack ?? ''}\n--- component stack ---${info.componentStack ?? ''}`,
      requestId: (error as { requestId?: string }).requestId ?? null,
    })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const requestId = (error as { requestId?: string }).requestId
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '2rem',
          background: '#0b0908',
          color: '#ece5d6',
          fontFamily: "'Inter', system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: '34rem' }}>
          <div style={{ color: '#e8622c', fontSize: '0.75rem', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
            CloudsForge
          </div>
          <h1 style={{ margin: '0.5rem 0 0.75rem', fontSize: '1.5rem' }}>This page hit an error.</h1>
          <p style={{ margin: '0 0 1rem', color: '#b7ae9b', lineHeight: 1.6 }}>
            It has been reported automatically. Reloading usually clears it; if it
            keeps happening, quote the reference below.
          </p>
          <pre
            style={{
              padding: '0.75rem',
              background: '#141110',
              border: '1px solid rgba(236,229,214,0.1)',
              borderRadius: 6,
              color: '#b7ae9b',
              font: "12px/1.5 'JetBrains Mono', ui-monospace, monospace",
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error.name}: {error.message}
            {requestId ? `\nreference: ${requestId}` : ''}
          </pre>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '0.5rem 1rem',
                borderRadius: 6,
                border: 'none',
                background: '#e8622c',
                color: '#1a0f08',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Reload
            </button>
            <button
              onClick={() => this.setState({ error: null })}
              style={{
                padding: '0.5rem 1rem',
                borderRadius: 6,
                border: '1px solid rgba(236,229,214,0.18)',
                background: 'transparent',
                color: '#ece5d6',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }
}
