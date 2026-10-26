import { test as base, chromium, BrowserContext } from '@playwright/test';
import path from 'path';

export const DIST = path.resolve(__dirname, '../dist');

// Chromium with the built extension loaded. Audio runs without a user gesture so the
// harness and offscreen recorder can start AudioContexts.
export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      acceptDownloads: true,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        '--autoplay-policy=no-user-gesture-required'
      ]
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker.url().split('/')[2]);
  }
});

export const expect = test.expect;
