import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// В dev запросы /api и /ws проксируются на FastAPI (порт 8000)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
})
