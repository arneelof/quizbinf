import { expect, test } from '@playwright/test';

/**
 * The public demo at /demo: no login, every kind can be answered, and the
 * projector pane draws the result with the visitor's answer included. Nothing
 * reaches the server (no POST to the API).
 *
 * Set SHOTS=dir to keep a screenshot of each step for a human to look at.
 */

const SHOTS = process.env['SHOTS'];

test('the demo runs every kind without logging in', async ({ page }) => {
  const posts = [];
  page.on('request', (r) => { if (r.method() !== 'GET') posts.push(r.url()); });
  await page.goto('/demo');
  await expect(page.getByRole('heading', { name: 'Try the lecture quiz' })).toBeVisible();
  const phone = page.locator('.screen');
  const projector = page.locator('.projector');
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/demo-${name}.png`, fullPage: true }); };

  // 1. Choose one, asked twice
  await expect(projector).toContainText('Answer on the phone');
  await phone.getByRole('button', { name: '0.1', exact: true }).click();
  await expect(projector.locator('.bar.post')).toHaveCount(4);
  await expect(projector.locator('.row').nth(2).locator('.n').first()).toHaveText('7');
  await shot('1-choice');

  await page.getByRole('button', { name: /^2\./ }).click();
  await phone.getByRole('button', { name: /Leucine/ }).click();
  await phone.getByRole('button', { name: /Valine/ }).click();
  await phone.getByRole('button', { name: 'Send' }).click();
  await expect(projector.locator('.bar.pre')).toHaveCount(5);
  await shot('2-multi');

  await page.getByRole('button', { name: /^3\./ }).click();
  await phone.getByRole('button', { name: 'Send' }).click();
  await expect(projector.locator('.bar.pre')).toHaveCount(4);
  await shot('3-rank');

  await page.getByRole('button', { name: /^4\./ }).click();
  await phone.locator('input[type=number]').fill('21');
  await phone.getByRole('button', { name: 'Send' }).click();
  await expect(projector).toContainText('Answer: 20 ± 2 thousand');
  await shot('4-number');

  await page.getByRole('button', { name: /^5\./ }).click();
  await phone.getByRole('button', { name: '4', exact: true }).click();
  await expect(projector.locator('.bar.pre')).toHaveCount(5);
  await shot('5-scale');

  await page.getByRole('button', { name: /^6\./ }).click();
  await phone.locator('input.word').first().fill('backpropagation');
  await phone.getByRole('button', { name: 'Send' }).click();
  await expect(projector.locator('.word', { hasText: /^backpropagation$/ })).toHaveCount(1);
  await shot('6-word');

  await page.getByRole('button', { name: /^7\./ }).click();
  await phone.locator('textarea').fill('Dropout, please.');
  await phone.getByRole('button', { name: 'Send' }).click();
  await expect(projector.locator('.card')).toHaveCount(6);
  await shot('7-text');

  await page.getByRole('button', { name: /^8\./ }).click();
  await phone.locator('.tap img').click({ position: { x: 200, y: 80 } });
  await expect(projector.locator('.dot')).toHaveCount(24);
  await shot('8-point');

  // Answers are kept when going back.
  await page.getByRole('button', { name: /^1\./ }).click();
  await expect(phone.getByRole('button', { name: '0.1', exact: true })).toHaveClass(/selected/);
  expect(posts.filter((u) => u.includes('/api/'))).toEqual([]);
});
