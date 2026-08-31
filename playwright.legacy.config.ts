import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests-legacy/e2e',
  timeout: 15_000,
  use: { baseURL: 'http://127.0.0.1:4180', browserName: 'chromium' },
  webServer: {
    command: 'pnpm demo:legacy --host 127.0.0.1 --port 4180',
    url: 'http://127.0.0.1:4180',
    reuseExistingServer: false,
  },
})
