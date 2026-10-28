import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// `npm run dev` proxies the API to the Python server (`motion --no-open`), which
// otherwise serves the built dist/ itself.
export default defineConfig({
  plugins: [preact()],
  build: {
    rollupOptions: { input: { editor: 'index.html', render: 'render.html' } },
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:3790', '/projects': 'http://127.0.0.1:3790' },
  },
})
