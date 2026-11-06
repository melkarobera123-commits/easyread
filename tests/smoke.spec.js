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

test('reading progress summarizes the current week and streak', async ({ page }) => {
  await page.addInitScript(() => {
    const date = new Date();
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    localStorage.setItem('er-reading-days', JSON.stringify({ [key]: 1800 }));
    localStorage.setItem('er-reading-goal', '20');
    localStorage.setItem('er-stats', JSON.stringify({ test: { seconds: 1800 } }));
  });
  await page.goto('/');
  await page.locator('#sidebar-reading-progress').click();
  await expect(page.locator('.weekly-progress-summary')).toContainText('30 minutes read');
  await expect(page.locator('.weekly-progress-summary')).toContainText('1 of 7 active days');
  await expect(page.locator('.weekly-progress-summary')).toContainText('1-day reading streak');
  await expect(page.locator('.weekly-progress > progress')).toHaveAttribute('aria-label', /30 of 140 minutes/);
  await expect(page.locator('.weekly-progress-list li')).toHaveCount(7);
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

test('high-contrast preference is keyboard accessible and persists', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles({
    name: 'accessibility-test.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('A short reading sample for accessibility settings.')
  });
  await page.locator('.toolbar-more > summary').click();
  await expect(page.locator('#settings-btn')).toBeVisible();
  await page.locator('#settings-btn').click();
  await page.locator('#contrast').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#contrast')).toBeChecked();
  await expect(page.locator('body')).toHaveClass(/high-contrast/);
  await page.reload();
  await expect(page.locator('body')).toHaveClass(/high-contrast/);
});

test('account screen offers email sign-in and Google sign-in', async ({ page }) => {
  await page.goto('/');
  await page.locator('#account-btn').click();
  await expect(page.locator('#google-signin')).toBeVisible();
  await expect(page.locator('#email-auth-form')).toBeVisible();
  await expect(page.locator('#auth-tab-signin')).toBeVisible();
  await expect(page.locator('#auth-tab-signup')).toBeVisible();
});

test('admin dashboard navigation is hidden until an admin signs in', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#dashboard-btn')).toBeHidden();
  await expect(page.locator('#sidebar-dashboard')).toBeHidden();
});

test('skip link moves keyboard focus to the main content', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#top')).toBeFocused();
});

test('library search and type filters include document categories and collections', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('easyread-library-v2', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('books', 'readwrite');
      transaction.objectStore('books').put({
        key: 'library-test-presentation',
        type: 'pptx',
        name: 'quarterly-review.pptx',
        title: 'Quarterly Review',
        collections: ['work'],
        opened: Date.now(),
        progress: 10,
        favorite: false
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  });
  await page.locator('#sidebar-library').click();
  await expect(page.locator('#library-result-count')).toHaveText('Showing 1 of 1 books.');
  await page.locator('#library-filter').selectOption('presentations');
  await expect(page.locator('#library-list')).toContainText('Quarterly Review');
  await page.locator('#library-search').fill('work');
  await expect(page.locator('#library-result-count')).toHaveText('Showing 1 of 1 books.');
  await page.locator('#library-search').fill('not found');
  await expect(page.locator('#library-result-count')).toHaveText('Showing 0 of 1 books.');
});

test('reading backup can be restored while signed out', async ({ page }) => {
  await page.goto('/');
  await page.locator('#sidebar-reading-progress').click();
  await page.locator('#backup-import-input').setInputFiles({
    name: 'easyread-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      format: 'easyread-reading-backup',
      version: 1,
      notes: [{ id: 'restored-note', text: 'Restored note', created: 1 }],
      readingDays: { '2026-01-02': 180 },
      readingGoal: 15,
      books: []
    }))
  });
  await expect(page.locator('#backup-import-status')).toContainText('restored and merged');
  const restored = await page.evaluate(() => ({
    notes: JSON.parse(localStorage.getItem('er-notes') || '[]'),
    days: JSON.parse(localStorage.getItem('er-reading-days') || '{}'),
    goal: localStorage.getItem('er-reading-goal')
  }));
  expect(restored.notes.some(note => note.id === 'restored-note')).toBe(true);
  expect(restored.days['2026-01-02']).toBe(180);
  expect(restored.goal).toBe('15');
});

test('support report downloads locally as JSON', async ({ page }) => {
  await page.goto('/');
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => exportSupportReport());
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^easyread-support-report-\d{4}-\d{2}-\d{2}\.json$/);
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
