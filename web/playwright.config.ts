import { defineConfig } from '@playwright/test'

if (!process.env.TEST_BASE_URL) throw new Error('Run bash tests/browser.sh with isolated storage')

export default defineConfig({
  testDir: './tests',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { baseURL: process.env.TEST_BASE_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'browser', use: { browserName: 'chromium',
    ...(process.env.FILEHOP_TEST_CHROME === '1' ? { channel: 'chrome' as const } : {}) } }],
})
