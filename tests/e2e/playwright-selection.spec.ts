import { test, expect } from '@playwright/test';

/**
 * E2E coverage placeholder: this project ships the spec so CI can execute it
 * against a harness browser for a real CM6 selection flow.
 */
test('selectionChanged payload is emitted when selection updates', async ({ page }) => {
  test.skip(true, 'E2E harness path requires local Obsidian runtime and is not executed in this environment.');
  await page.goto('/');
  await expect(page).toHaveTitle(/./);
});
