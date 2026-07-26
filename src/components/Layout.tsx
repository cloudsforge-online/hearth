import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { CloudsForgeBar } from '@cloudsforge/ui'
import Nav from './Nav'
import Footer from './Footer'
import { STUDIO_URL } from '../lib/hearth'

/** Where the shared bar's "Sign in" sends people — the Play/login surface. */
const PLAY_URL = import.meta.env.VITE_PLAY_URL ?? 'http://localhost:3001'

/** Resets scroll on navigation so deep pages start at the top. */
function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [pathname])
  return null
}

export default function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <ScrollToTop />
      <CloudsForgeBar
        current="crypto"
        account={{ signedIn: false }}
        onSignIn={() => {
          window.location.href = PLAY_URL
        }}
        productUrls={{ site: STUDIO_URL, play: PLAY_URL }}
      />
      <Nav />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  )
}
