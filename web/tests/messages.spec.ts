import { test, expect } from '@playwright/test';

test('file upload and download loop', async ({ page }) => {
  await page.goto('/');
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('input[type="file"]'),
  ]);
  await fileChooser.setFiles('tests/testdata/sample.txt');

  await page.click('button:has-text("Upload")');
  await expect(page.locator('text=Upload complete')).toBeVisible();

  // Assume the server returns a message with id and filename
  const messages = await page.locator('.message').allTextContents();
  const fileMsg = messages.find((m) => m.includes('sample.txt'));
  expect(fileMsg).toBeDefined();

  // Trigger download
  await page.click(`text=sample.txt`);
  // Verify download file exists
  const download = await page.waitForEvent('download');
  const path = await download.path();
  expect(path).toBeTruthy();
});
