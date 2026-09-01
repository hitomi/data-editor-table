import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: 'pnpm demo',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: true,
  },
})
