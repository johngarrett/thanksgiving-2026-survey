import { test, expect, type Page } from '@playwright/test';

const publicUrl = 'http://127.0.0.1:5373';
const adminUrl = 'http://127.0.0.1:5374/admin/';
async function adminLogin(page: Page) {
  await page.goto(adminUrl);
  await page.getByLabel('Admin password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
}

test('public modal, multiple choices, custom food, recipe links, and returning guests', async ({ page }) => {
  await page.goto(publicUrl);
  await expect(page.getByRole('button', { name: 'Submit selections' })).toBeEnabled();
  const food = page.getByRole('group', { name: 'I sign up to make:' });
  await food.getByRole('checkbox', { name: 'Mac and cheese', exact: true }).check();
  await food.getByLabel('Recipe URL (optional)').first().fill('https://example.com/mac');
  await expect(food.locator('.custom-choice').getByLabel('Recipe URL (optional)')).not.toBeVisible();
  await food.getByLabel('Other (add your own)').fill('Pumpkin pie');
  await food.getByLabel('Recipe URL (optional)').last().fill('https://example.com/pie');
  await page.getByRole('checkbox', { name: 'Set the table', exact: true }).check();
  await page.getByRole('button', { name: 'Submit selections' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Your name')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Submit selections' }).click();
  await page.getByLabel('Your name').fill('Alex');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(food.getByRole('checkbox', { name: 'Pumpkin pie — Alex' })).toBeDisabled();
  await expect(food.getByRole('checkbox', { name: 'Mac and cheese — Alex' })).toBeDisabled();
  await expect(food.getByRole('link', { name: 'Recipe' }).last()).toHaveAttribute('href', 'https://example.com/pie');
  await page.reload();
  await expect(food.getByRole('checkbox', { name: 'Pumpkin pie — Alex' })).toBeDisabled();
  // Unchecked URL inputs must not interfere with submitting another selection.
  await food.getByRole('checkbox', { name: 'Salad', exact: true }).check();
  await food.getByLabel('Recipe URL (optional)').nth(3).fill('bad-url');
  await food.getByRole('checkbox', { name: 'Salad', exact: true }).uncheck();
  await food.getByRole('checkbox', { name: 'Stuffing', exact: true }).check();
  await page.getByRole('button', { name: 'Submit selections' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('conflict preserves name and remaining selections; refresh errors are visible', async ({ page, browser }) => {
  await page.goto(publicUrl);
  await page.getByRole('checkbox', { name: 'Stuffing', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Salad', exact: true }).check();
  await page.getByRole('button', { name: 'Submit selections' }).click();
  await page.getByLabel('Your name').fill('Jordan');
  const other = await browser.newPage();
  await other.goto(publicUrl);
  await other.getByRole('checkbox', { name: 'Stuffing', exact: true }).check();
  await other.getByRole('button', { name: 'Submit selections' }).click();
  await other.getByLabel('Your name').fill('Sam');
  await other.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(other.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Stuffing — Sam' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Salad', exact: true })).toBeChecked();
  await expect(page.getByRole('status').first()).toContainText('no longer available');
  await page.getByRole('button', { name: 'Submit selections' }).click();
  await expect(page.getByLabel('Your name')).toHaveValue('Jordan');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.route('**/api/form', route => route.abort());
  await page.reload();
  await expect(page.getByRole('status').first()).toContainText('Could not refresh');
  await other.close();
});

test('admin edits, assigns, clears, reorders by pointer and keyboard, and deletes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  await adminLogin(page);
  await page.getByLabel('New section title').fill('Desserts');
  await page.getByRole('button', { name: 'Add section', exact: true }).click();
  const desserts = page.getByRole('group', { name: 'Desserts', exact: true });
  await desserts.getByLabel('New option').fill('Apple pie');
  await desserts.getByRole('button', { name: 'Add option', exact: true }).click();
  await desserts.getByLabel('New option').fill('Brownies');
  await desserts.getByRole('button', { name: 'Add option', exact: true }).click();
  const apple = desserts.locator('.option').first();
  await apple.getByLabel('Guest name').fill('Pat');
  await apple.getByRole('button', { name: 'Assign claim' }).click();
  await expect(desserts).toContainText('Claimed by Pat');
  page.once('dialog', dialog => dialog.accept());
  await desserts.getByRole('button', { name: 'Clear claim' }).click();
  await expect(desserts).not.toContainText('Claimed by Pat');
  // Pointer drag on an option handle.
  const list = desserts.locator('[data-list]');
  const first = list.locator(':scope > [data-item]').first();
  const last = list.locator(':scope > [data-item]').last();
  const handle = first.locator('.handle');
  await handle.scrollIntoViewIfNeeded();
  const a = await handle.boundingBox(), b = await last.boundingBox();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height - 5, { steps: 12 });
  await page.mouse.up();
  await expect(list.locator(':scope > [data-item]').first().getByLabel('Option label')).toHaveValue('Brownies');
  await desserts.getByRole('button', { name: 'Save order', exact: true }).click();
  await page.reload();
  await expect(desserts.locator('[data-list] > [data-item]').first().getByLabel('Option label')).toHaveValue('Brownies');
  await desserts.locator('[data-list] > [data-item]').last().getByRole('button', { name: 'Move up', exact: true }).focus();
  await page.keyboard.press('Enter');
  await desserts.getByRole('button', { name: 'Save order', exact: true }).click();
  await expect(desserts.locator('[data-list] > [data-item]').first().getByLabel('Option label')).toHaveValue('Apple pie');
  await page.getByLabel('Page title', { exact: true }).fill('Thanksgiving dinner');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await desserts.getByRole('button', { name: 'Delete section', exact: true }).click();
  await expect(desserts).toHaveCount(0);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('mobile form fits the viewport and shows custom task inputs', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(publicUrl);
  const tasks = page.getByRole('group', { name: 'I sign up to do:' });
  await expect(tasks.getByLabel('Other (add your own)')).toBeVisible();
  await expect(tasks.locator('.custom-choice').getByLabel('Recipe URL (optional)')).not.toBeVisible();
  await tasks.getByLabel('Other (add your own)').fill('Walk the dog');
  await expect(tasks.getByLabel('Recipe URL (optional)').last()).toBeVisible();
  await tasks.getByLabel('Other (add your own)').fill('');
  await expect(tasks.locator('.custom-choice').getByLabel('Recipe URL (optional)')).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
