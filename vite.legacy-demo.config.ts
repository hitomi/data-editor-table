import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'demo-legacy',
  resolve: {
    alias: [
      { find: 'react-data-grid-ext/styles.css', replacement: path.resolve(import.meta.dirname, 'src-legacy/styles.css') },
      { find: 'react-data-grid-ext', replacement: path.resolve(import.meta.dirname, 'src-legacy/index.ts') },
    ],
  },
  build: { outDir: '../legacy-demo-dist', emptyOutDir: true },
})
