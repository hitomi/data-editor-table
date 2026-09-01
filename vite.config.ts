import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: 'src/vite-entry.ts',
        engine: 'src/engine.ts',
        'locales/zh-CN': 'src/locales/zh-cn.ts',
      },
      fileName: (_format, entryName) => `${entryName}.js`,
      formats: ['es'],
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', 'react-dom'],
    },
    sourcemap: true,
  },
})
