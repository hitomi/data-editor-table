import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 15_000,
  use: { baseURL: 'http://127.0.0.1:4178', browserName: 'chromium' },
  webServer: {
    command: 'pnpm demo --host 127.0.0.1 --port 4178',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
  },
})
