import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Marketing site for Hearth / EMBER — dev port 3003.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 3003, host: true },
  preview: { port: 3003 },
})
