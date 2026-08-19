import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Forward every JSON/API-style call to the Express backend (main.js) on :3000.
    // The old EJS page routes stay on the backend for reference; the React app only
    // talks to the JSON endpoints listed below (see CLAUDE.md "API surface").
    proxy: {
      '/auth': 'http://localhost:3000',
      '/api': 'http://localhost:3000',
      '/product': 'http://localhost:3000',
      '/customer': 'http://localhost:3000',
      '/billing': 'http://localhost:3000',
      '/dashboard/load': 'http://localhost:3000',
    },
  },
})