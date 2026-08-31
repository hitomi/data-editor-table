import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      'react-data-grid-ext/styles.css': fileURLToPath(new URL('./src/styles.css', import.meta.url)),
      'react-data-grid-ext': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  root: 'demo',
  server: { host: '127.0.0.1', port: 4178 },
})
