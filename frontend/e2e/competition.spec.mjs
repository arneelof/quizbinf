import { expect, test } from '@playwright/test';

/**
 * A whole competition, in real browsers: the projected game screen and two
 * phones. Pins what only a browser can see — that nicknames reach the lobby,
 * that a phone's tiles lock after the first tap, that the clock closes the
 * question on its own, and that the leaderboard and podium show nicknames in
 * the right order.
 *
 * Set GAME_SHOTS to a directory to keep a screenshot of every stage.
 */

const SHOTS = process.env['GAME_SHOTS'];

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function login(page, username) {
  await page.goto('/login');
  await page.getByPlaceholder('e.g. lukask').fill(username);
  await page.getByRole('button', { name: 'Log in' }).click();
}

async function player(browser, username, nickname, code) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await ctx.newPage();
  await login(page, username);
  await page.goto(`/s/${code}`);
  await page.getByLabel('Nickname').fill(nickname);
  await page.getByRole('button', { name: 'OK, go!' }).click();
  await expect(page.getByText(`Playing as ${nickname}`)).toBeVisible();
  return page;
}

test('a competition from lobby to podium', async ({ browser }) => {
  test.setTimeout(120_000);
  const teacherCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const teacher = await teacherCtx.newPage();
  await login(teacher, 'teacher');
  await teacher.waitForURL('**/teacher');

  // Author through the API: the editor has its own spec, and this one is
  // about the game.
  const title = `Game ${Date.now()}`;
  const quiz = await (await teacher.request.post('/api/quizzes', { data: { title } })).json();
  for (const [text, right, wrong] of [
    ['Which tool aligns sequences?', 'BLAST', 'Excel'],
    ['Which is a protein structure predictor?', 'AlphaFold', 'Photoshop'],
  ]) {
    const resp = await teacher.request.post(`/api/quizzes/${quiz.id}/questions`, {
      data: {
        text,
        choices: [
          { text: right, is_correct: true },
          { text: wrong, is_correct: false },
          { text: 'Word', is_correct: false },
          { text: 'Paint', is_correct: false },
        ],
      },
    });
    expect(resp.ok()).toBeTruthy();
  }

  await teacher.reload();
  const section = teacher
    .locator('section.quiz')
    .filter({ has: teacher.getByRole('heading', { name: title, exact: true }) });
  await section.getByLabel('Seconds per question').selectOption({ label: '10 s' });
  await section.getByRole('button', { name: '🏆 Competition' }).click();
  await teacher.waitForURL('**/teacher/session/*/game');
  const code = teacher.url().split('/session/')[1].split('/')[0];

  // --- lobby: nicknames arrive on the projected screen ---
  const ann = await player(browser, 'ann', 'Speedy Ann', code);
  const ben = await player(browser, 'ben', 'Ben10', code);
  await expect(teacher.locator('.bubble', { hasText: 'Speedy Ann' })).toBeVisible();
  await expect(teacher.locator('.bubble', { hasText: 'Ben10' })).toBeVisible();
  await expect(teacher.locator('img.qr')).toBeVisible();
  await shot(teacher, '1-lobby');
  await shot(ann, '1-phone-lobby');

  // --- question 1: tiles and a running clock on both screens ---
  await teacher.getByRole('button', { name: 'Start ▶' }).click();
  await expect(teacher.locator('.qcard')).toContainText('Which tool aligns sequences?');
  await expect(teacher.locator('app-game-tiles .tile')).toHaveCount(4);
  await expect(teacher.locator('.tick')).toHaveCount(0); // nothing marked while open
  await expect(ann.locator('app-answer-tiles .tile')).toHaveCount(4);
  await expect(ann.locator('app-countdown-bar')).toBeVisible();
  await shot(ann, '2-phone-question');

  await ann.locator('app-answer-tiles .tile', { hasText: 'BLAST' }).click();
  await expect(ann.getByText('Locked in!')).toBeVisible();
  // The first tap counts: the tiles lock.
  await expect(ann.locator('app-answer-tiles .tile').first()).toBeDisabled();
  await ben.locator('app-answer-tiles .tile', { hasText: 'Excel' }).click();
  await expect(teacher.locator('.answers-in .big')).toHaveText('2');
  await shot(teacher, '2-question');

  // --- the teacher stops the clock: results, then the verdict on each phone ---
  await teacher.getByRole('button', { name: /Stop the clock/ }).click();
  await expect(teacher.locator('app-game-tiles .bars')).toBeVisible();
  await expect(teacher.locator('app-game-tiles .tile:not(.dim)')).toContainText('BLAST');
  await expect(ann.getByText('Correct!')).toBeVisible();
  await expect(ben.getByText('Not this time')).toBeVisible();
  await expect(ann.getByText(/You are 1st of 2/)).toBeVisible();
  await shot(teacher, '3-result');
  await shot(ann, '3-phone-correct');
  await shot(ben, '3-phone-wrong');

  // --- leaderboard: nicknames only, winner first ---
  await teacher.getByRole('button', { name: 'Leaderboard ▶' }).click();
  const rows = teacher.locator('app-game-leaderboard .row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Speedy Ann' }).locator('.place')).toHaveText('1');
  await teacher.waitForTimeout(2200); // let the rows settle and the scores count up
  await shot(teacher, '4-leaderboard');
  // The username is never projected, only the nickname.
  expect(await teacher.locator('div.game').innerText()).not.toMatch(/\bann\b/);

  // --- question 2: Ben answers right, Ann lets the clock run out ---
  await teacher.getByRole('button', { name: 'Next question ▶' }).click();
  await expect(teacher.locator('.qcard')).toContainText('protein structure');
  await ben.locator('app-answer-tiles .tile', { hasText: 'AlphaFold' }).click();
  await expect(ben.getByText('Locked in!')).toBeVisible();
  // Nobody touches the teacher's screen: the 10-second clock closes it.
  await expect(teacher.locator('app-game-tiles .bars')).toBeVisible({ timeout: 20_000 });
  await expect(ann.getByText("Time's up")).toBeVisible();
  await shot(ann, '5-phone-timeout');

  await teacher.getByRole('button', { name: 'Leaderboard ▶' }).click();
  await expect(rows).toHaveCount(2);
  await teacher.waitForTimeout(2200);
  await shot(teacher, '5-leaderboard');

  // --- podium ---
  await teacher.getByRole('button', { name: /Final results/ }).click();
  await expect(teacher.locator('app-game-podium .place1 .nick')).toBeVisible({ timeout: 10_000 });
  const winner = await teacher.locator('app-game-podium .place1 .nick').textContent();
  expect(['Speedy Ann', 'Ben10']).toContain(winner?.trim());
  await teacher.waitForTimeout(4500); // the winner rises, then the confetti
  await shot(teacher, '6-podium');
});
