import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  reporter: [['list'], ['./tests/browser-server-reporter.ts']],
  use: {
    baseURL: 'http://127.0.0.1:4179',
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  // Own a fresh server: a reused HMR server can give dynamically imported
  // recovery fixtures different module identities from their static consumers.
  webServer: {
    command: 'pnpm exec vite --config vite.demo.config.ts --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
  },
})
