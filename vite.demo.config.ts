import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'demo',
  resolve: { alias: { 'react-data-grid-ext': path.resolve(import.meta.dirname, 'src/index.ts') } },
  build: { outDir: '../demo-dist', emptyOutDir: true },
})
