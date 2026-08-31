import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['src-legacy/**/*.test.{ts,tsx}'] },
})
