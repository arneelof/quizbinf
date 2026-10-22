import { expect, test } from '@playwright/test';

/**
 * The competition demo at /demo/competition: no login, nothing sent, and a
 * whole game from nickname to podium with the made-up players.
 *
 * Set SHOTS=dir to keep a screenshot of each step.
 */

const SHOTS = process.env['SHOTS'];

test('the competition demo plays a whole game without logging in', async ({ page }) => {
  test.setTimeout(90_000);
  const posts = [];
  page.on('request', (r) => { if (r.method() !== 'GET') posts.push(r.url()); });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/demo/competition?seconds=5&seed=3');
  await expect(page.getByRole('heading', { name: 'Try competition mode' })).toBeVisible();
  const phone = page.locator('.screen');
  const projector = page.locator('app-demo-projector');
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/demo-game-${name}.png` }); };

  // A made-up player's nickname is taken; then join under one of our own.
  await expect(projector.locator('.bubble')).toHaveCount(8);
  await phone.getByLabel('Nickname').fill('blastoff');
  await phone.getByRole('button', { name: 'OK, go!' }).click();
  await expect(phone.getByText('That nickname is taken')).toBeVisible();
  await phone.getByLabel('Nickname').fill('Visitor');
  await phone.getByRole('button', { name: 'OK, go!' }).click();
  await expect(projector.locator('.bubble.you')).toHaveText('Visitor');
  await shot('1-lobby');

  await projector.getByRole('button', { name: 'Start ▶' }).click();
  for (let i = 1; i <= 4; i++) {
    await expect(projector.locator('.top')).toHaveText(`Question ${i} of 4`);
    // Answer quickly on the first three, and let the clock run out on the last.
    if (i < 4) {
      await phone.locator('app-answer-tiles .tile').first().click();
      await expect(phone.getByText('Locked in!')).toBeVisible();
      if (i === 1) {
        await page.waitForTimeout(600); // let the tiles finish fading in
        await shot('2-question');
      }
    }
    await expect(projector.getByRole('button', { name: 'Leaderboard ▶' })).toBeVisible({ timeout: 10_000 });
    await expect(phone.locator('app-game-verdict .card')).toBeVisible();
    if (i === 1) await shot('3-result');
    if (i === 4) await expect(phone.getByText("Time's up")).toBeVisible();
    await projector.getByRole('button', { name: 'Leaderboard ▶' }).click();
    await expect(projector.locator('app-game-leaderboard .row')).toHaveCount(5);
    if (i === 2) {
      await page.waitForTimeout(2200);
      await shot('4-leaderboard');
    }
    await projector.getByRole('button', { name: i < 4 ? 'Next question ▶' : '🏆 Final results' }).click();
  }

  await expect(projector.locator('app-game-podium .place1 .nick')).toBeVisible({ timeout: 10_000 });
  await expect(phone.getByText(/Game over — you finished/)).toBeVisible();
  await page.waitForTimeout(4000);
  await shot('5-podium');
  expect(posts, 'the demo sent something to the server').toEqual([]);
});
