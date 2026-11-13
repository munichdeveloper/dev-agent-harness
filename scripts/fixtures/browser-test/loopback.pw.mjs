import { expect, test } from '@playwright/test';
test('loads a page from a local server', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading')).toHaveText('served on loopback');
});
