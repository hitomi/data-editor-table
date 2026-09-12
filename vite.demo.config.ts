import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      'data-editor-table/styles.css': fileURLToPath(new URL('./src/styles.css', import.meta.url)),
      'data-editor-table': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  // Route and recovery fixtures import these entry points lazily. Prebundle
  // them together so first use cannot reload an active editing session.
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'] },
  root: 'demo',
  server: { host: '127.0.0.1', port: 4178 },
})
