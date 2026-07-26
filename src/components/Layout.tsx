import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { CloudsForgeBar, accountUrl } from '@cloudsforge/ui'
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
          // Company-wide login lives at the Nimbus Account portal, not the game.
          window.location.assign(`${accountUrl()}/account`)
        }}
      />
      <Nav />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  )
}
