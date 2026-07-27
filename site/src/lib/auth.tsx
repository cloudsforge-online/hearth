import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  cloudsforgeHosts,
  consumeAuthCallback,
  signInRedirect,
  signOutRedirect,
} from '@cloudsforge/ui'

/* ------------------------------------------------------------------ *
 * One CloudsForge account, on Hearth too.
 *
 * The same shape as Crucible's `lib/auth.tsx`, minus the parts a marketing
 * site has no use for: this page makes exactly one authenticated request, so
 * there is no request layer to build around it.
 *
 * The token keys are the shared CloudsForge ones — a session established at
 * the Account portal and handed to this origin is stored where every other
 * product looks for it.
 * ------------------------------------------------------------------ */

const ACCESS_KEY = 'cf.accessToken'
const REFRESH_KEY = 'cf.refreshToken'

/** The subset of Nimbus's PublicUser the shared bar renders. */
interface Viewer {
  handle: string
  roles: readonly string[]
}

interface AuthContextValue {
  user: Viewer | null
  /** true until the initial session check resolves */
  loading: boolean
  signedIn: boolean
  signIn: () => void
  signOut: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

function setTokens(tokens: { accessToken: string; refreshToken: string }) {
  localStorage.setItem(ACCESS_KEY, tokens.accessToken)
  localStorage.setItem(REFRESH_KEY, tokens.refreshToken)
}

function clearTokens() {
  localStorage.removeItem(ACCESS_KEY)
  localStorage.removeItem(REFRESH_KEY)
}

/**
 * Who the viewer is, or null. One silent refresh on a 401, because an access
 * token outlives a page load by less than this site's average visit.
 *
 * Only a real 401 clears the session: Nimbus being unreachable is not the
 * viewer's tokens going bad, and signing them out for it is how a network blip
 * became a logout everywhere.
 */
async function fetchViewer(): Promise<Viewer | null> {
  const nimbus = cloudsforgeHosts().nimbus

  const me = async (): Promise<Response | null> => {
    const token = localStorage.getItem(ACCESS_KEY)
    if (!token) return null
    try {
      return await fetch(`${nimbus}/auth/me`, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      })
    } catch {
      return null
    }
  }

  let res = await me()
  if (res?.status === 401) {
    const refreshToken = localStorage.getItem(REFRESH_KEY)
    let refreshed = false
    if (refreshToken) {
      try {
        const r = await fetch(`${nimbus}/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        })
        if (r.ok) {
          setTokens(await r.json())
          refreshed = true
        }
      } catch {
        // unreachable — fall through and leave the tokens alone
      }
    }
    if (!refreshed) {
      clearTokens()
      return null
    }
    res = await me()
  }

  if (!res?.ok) return null
  const user = (await res.json()) as { handle?: string; roles?: string[] }
  if (!user?.handle) return null
  return { handle: user.handle, roles: user.roles ?? [] }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Viewer | null>(null)
  const [loading, setLoading] = useState(true)

  // Bootstrap: redeem any SSO hand-off code from the CloudsForge Account portal
  // for this origin's own tokens, then — if we hold tokens — confirm who we are.
  useEffect(() => {
    let active = true
    void (async () => {
      const handed = await consumeAuthCallback()
      if (handed) setTokens(handed)
      const viewer = await fetchViewer()
      if (active) {
        setUser(viewer)
        setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const signIn = useCallback(() => {
    signInRedirect()
  }, [])

  const signOut = useCallback(() => {
    clearTokens()
    setUser(null)
    signOutRedirect(window.location.origin)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, signedIn: !!user, signIn, signOut }),
    [user, loading, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
