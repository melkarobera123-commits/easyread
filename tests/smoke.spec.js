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

test('account screen offers email sign-in and Google sign-in', async ({ page }) => {
  await page.goto('/');
  await page.locator('#account-btn').click();
  await expect(page.locator('#google-signin')).toBeVisible();
  await expect(page.locator('#email-auth-form')).toBeVisible();
  await expect(page.locator('#auth-tab-signin')).toBeVisible();
  await expect(page.locator('#auth-tab-signup')).toBeVisible();
});


test('desktop navigation supports Library, Notes, and browser history', async ({ page }) => {
  await page.goto('/home');
  await page.locator('#sidebar-library').click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.locator('#library')).toBeVisible();
  await page.locator('#sidebar-notes').click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page.locator('#notes-panel')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.locator('#library')).toBeVisible();
});

test('mobile bottom navigation opens the Library route', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  await expect(page.locator('#mobile-nav')).toBeVisible();
  await page.locator('#mobile-library').click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.locator('#library')).toBeVisible();
});

test('question-mark shortcut opens Keyboard Shortcuts', async ({ page }) => {
  await page.goto('/home');
  await page.keyboard.press('?');
  await expect(page.locator('#shortcuts')).toBeVisible();
});

test('welcome sign-in prompt can be dismissed without blocking reading', async ({ page }) => {
  await page.goto('/home');
  await expect(page.locator('#welcome-signin')).toBeVisible();
  await page.locator('#welcome-dismiss').click();
  await expect(page.locator('#welcome-signin')).toBeHidden();
  await expect(page.locator('#drop')).toBeVisible();
});
