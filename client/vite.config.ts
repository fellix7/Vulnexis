import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Same-origin API calls in dev; no CORS needed on the server. /auth is GitHub sign-in, /v1 the API-key routes.
    proxy: Object.fromEntries(['/api', '/auth', '/v1'].map((p) => [p, process.env.VITE_API_TARGET ?? 'http://localhost:8787'])),
  },
})
