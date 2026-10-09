import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Built into web/app so the existing static server (scripts/serve.py, port 8765) serves it at /app/,
// next to the twins in web/data. In dev, Vite proxies /data to that server.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../web/app', emptyOutDir: true, chunkSizeWarningLimit: 9000, target: 'es2020' },
  server: { port: 5173, proxy: { '/data': 'http://localhost:8765' } },
})
