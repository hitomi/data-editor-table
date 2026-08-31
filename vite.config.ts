import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      // Keep the CSS side effect in the runtime bundle entry, not the public
      // declaration entry. TypeScript consumers can import the root package
      // without needing a project-specific `*.css` ambient declaration.
      entry: {
        index: 'src/vite-entry.ts',
        engine: 'src/engine.ts',
      },
      cssFileName: 'styles',
      fileName: (_format, entryName) => `${entryName}.js`,
      formats: ['es'],
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', 'react-dom'],
    },
    sourcemap: true,
  },
})
