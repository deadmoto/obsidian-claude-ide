import { defineConfig } from '@playwright/test';

// E2E tests here drive the real Obsidian.app via CDP — they manage their own
// browser, so the project doesn't need a baseURL / dev server.
export default defineConfig({
  testDir: './tests/e2e',
  retries: 0,
  // One worker — only one Obsidian instance at a time can hold the IDE lock.
  workers: 1,
  reporter: [['list']]
});
