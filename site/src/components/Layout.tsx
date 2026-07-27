import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { CloudsForgeBar } from '@cloudsforge/ui'
import { useAuth } from '../lib/auth'
import Nav from './Nav'
import Footer from './Footer'

/** Resets scroll on navigation so deep pages start at the top. */
function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [pathname])
  return null
}

export default function Layout() {
  const { user, signIn, signOut } = useAuth()

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <ScrollToTop />
      <CloudsForgeBar
        current="crypto"
        account={{ signedIn: !!user, handle: user?.handle, roles: user?.roles }}
        onSignIn={signIn}
        onSignOut={signOut}
      />
      <Nav />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  )
}
