const { test, expect } = require('@playwright/test');

test('home page provides an accessible upload entry point', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/EasyRead/);
  await expect(page.getByText('Choose a file or drop it here')).toBeVisible();
  await expect(page.locator('#file')).toHaveAttribute('accept', /\.pptx/);
  await expect(page.locator('#file')).not.toHaveAttribute('accept', /\.ppt,/);
});

test('reader preferences persist locally', async ({ page }) => {
  await page.goto('/');
  await page.locator('#settings-btn').evaluate(button => button.click());
  await page.locator('#reading-goal').selectOption('20');
  await page.reload();
  await expect(page.locator('#reading-goal')).toHaveValue('20');
});

test('tablet layout does not show the desktop sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/');
  await expect(page.locator('#app-sidebar')).toBeHidden();
});


test('reader controls are present and keyboard friendly', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#reader-page-jump')).toHaveAttribute('min', '1');
  await expect(page.locator('#timer-toggle')).toBeVisible();
  await expect(page.locator('#timer-reset')).toBeVisible();
  await expect(page.locator('#pdf-preview-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#text-smaller')).toHaveAttribute('aria-label', /Decrease text size/);
  await expect(page.locator('#text-larger')).toHaveAttribute('aria-label', /Increase text size/);
});

test('account screen exposes only configured Google sign-in', async ({ page }) => {
  await page.goto('/');
  await page.locator('#account-btn').click();
  await expect(page.locator('#google-signin')).toBeVisible();
  await expect(page.locator('#email-auth-form')).toHaveCount(0);
});
