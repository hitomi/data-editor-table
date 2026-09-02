import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'pnpm demo',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: true,
  },
})
