import { defineConfig } from '@playwright/test';

// Run with `npm test` (builds the extension and the pipeline harness first)
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list'
});
