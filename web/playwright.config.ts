import { defineConfig } from '@playwright/test'

if (!process.env.TEST_BASE_URL) throw new Error('Run python3 tests/browser.py with isolated storage')

export default defineConfig({
  testDir: './tests',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { baseURL: process.env.TEST_BASE_URL, trace: 'retain-on-failure' },
})
