import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ErrorBoundary, installGlobalErrorHandlers } from './lib/obs'
import { AuthProvider } from './lib/auth'
import '@cloudsforge/ui/tokens.css'
import '@cloudsforge/ui/ui.css'
import './index.css'

installGlobalErrorHandlers('hearth')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary app="hearth">
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
