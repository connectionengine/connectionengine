import { test, expect } from '@playwright/test';

test('has title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Solid App/);
});

test('shows server message', async ({ page }) => {
  await page.route('http://localhost:3001/health', async route => {
    const json = { message: 'ConnectionEngine', status: 'ok' };
    await route.fulfill({ json });
  });
  await page.goto('/');
  await expect(page.getByText('Client')).toBeVisible();
  // Wait for fetch
  await expect(page.getByText('Shared: ConnectionEngine')).toBeVisible();
  await expect(page.getByText('Server: ConnectionEngine ok')).toBeVisible();
});
