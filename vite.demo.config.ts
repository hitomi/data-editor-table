import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  resolve: {
    alias: [
      { find: 'data-editor-table/styles.css', replacement: fileURLToPath(new URL('./src/styles.css', import.meta.url)) },
      { find: /^data-editor-table\/protocol$/, replacement: fileURLToPath(new URL('./src/protocol.ts', import.meta.url)) },
      { find: /^data-editor-table\/engine$/, replacement: fileURLToPath(new URL('./src/engine.ts', import.meta.url)) },
      { find: /^data-editor-table$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
    ],
  },
  root: 'demo',
  server: { host: '127.0.0.1', port: 4178 },
})
