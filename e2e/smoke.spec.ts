import { test, expect } from '@playwright/test';

/** Smoke: Vite is started by playwright.config webServer (local or CI). */
test('home responds', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.ok()).toBeTruthy();
});

test('app shell renders without uncaught errors', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  await page.goto('/');
  await expect(page.locator('body')).toBeVisible();

  // Allow brief hydration / lazy chunks
  await page.waitForTimeout(1500);

  expect(pageErrors).toEqual([]);
});

test('root uses design token font family', async ({ page }) => {
  await page.goto('/');
  const fontFamily = await page.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue('--font-family').trim();
  });
  expect(fontFamily.length).toBeGreaterThan(0);
});

test('design tokens expose primary background', async ({ page }) => {
  await page.goto('/');
  const bgPrimary = await page.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
  });
  expect(bgPrimary.length).toBeGreaterThan(0);
});

test('first-run setup, main app shell, or dev browser notice is present', async ({ page }) => {
  await page.goto('/');
  const setup = page.getByTestId('library-setup');
  const shell = page.getByTestId('app-shell');
  const devNotice = page.getByTestId('dev-browser-notice');
  await expect(setup.or(shell).or(devNotice)).toBeVisible({ timeout: 15_000 });
});
