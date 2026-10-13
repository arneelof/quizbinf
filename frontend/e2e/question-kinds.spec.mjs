import { expect, test } from '@playwright/test';

/**
 * Every kind of question that is not single-choice, through a real browser:
 * the student's phone gives each kind its own input, and once the round is
 * halted the projected Report view and the phone draw the result — histogram,
 * scale bars, word cloud, answer cards (one hidden by the teacher), taps on a
 * figure, average ranks, several-choice bars.
 *
 * Set SHOTS=dir to keep a screenshot of each result for a human to look at.
 */

const SHOTS = process.env['SHOTS'];

async function loginAs(page, username) {
  await page.goto('/login');
  await page.getByPlaceholder('e.g. lukask').fill(username);
  await page.getByRole('button', { name: 'Log in' }).click();
}

const QUESTIONS = [
  { text: 'How many residues long is the helix?', kind: 'number', mode: 'once',
    settings: { min: 0, max: 100, answer: 18, tolerance: 2, unit: 'residues' } },
  { text: 'How confident are you about backpropagation?', kind: 'scale', mode: 'once',
    settings: { min: 1, max: 5, min_label: 'not at all', max_label: 'completely' } },
  { text: 'One or two words: what does a hidden layer do?', kind: 'word', mode: 'once',
    settings: { max_words: 2 } },
  { text: 'What was unclear today?', kind: 'text', mode: 'once' },
  { text: 'Which are activation functions?', kind: 'multi', mode: 'once',
    choices: [{ text: 'ReLU', is_correct: true }, { text: 'Adam' }, { text: 'sigmoid', is_correct: true }] },
  { text: 'Order by size, largest first', kind: 'rank', mode: 'once',
    choices: [{ text: 'cell' }, { text: 'protein' }, { text: 'atom' }] },
  { text: 'Where is the figure’s centre?', kind: 'point', mode: 'once' },
];

test('every kind of question can be answered and its result drawn', async ({ browser }) => {
  const teacherCtx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const teacher = await teacherCtx.newPage();
  await loginAs(teacher, 'teacher');
  await teacher.waitForURL('**/teacher');
  const api = teacher.request;

  // The figure for the tap question goes through the same upload as the editor's.
  const upload = await api.post('/api/images', {
    multipart: { file: { name: 'fig.png', mimeType: 'image/png',
      buffer: (await import('node:fs')).readFileSync(new URL('./fig.png', import.meta.url)) } },
  });
  expect(upload.status()).toBe(201);
  const figure = (await upload.json()).url;

  const quiz = await (await api.post('/api/quizzes', { data: { title: 'Kinds quiz' } })).json();
  const questions = [];
  for (const q of QUESTIONS) {
    const body = { choices: [], ...q, ...(q.kind === 'point' ? { image_url: figure } : {}) };
    const resp = await api.post(`/api/quizzes/${quiz.id}/questions`, { data: body });
    expect(resp.status(), q.text).toBe(201);
    questions.push(await resp.json());
  }
  const session = await (await api.post(`/api/sessions?quiz_id=${quiz.id}`)).json();
  const code = session.code;

  const students = [];
  for (const name of ['kinda', 'kindb', 'kindc']) {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 800 } });
    const page = await ctx.newPage();
    await loginAs(page, name);
    await page.goto(`/s/${code}`);
    await expect(page.locator('.waiting')).toBeVisible();
    students.push(page);
  }

  // What each student does, per kind, through the phone's own controls.
  const answer = {
    number: async (p, i) => {
      await p.locator('input.num').fill(['18', '20', '35'][i]);
      await p.getByRole('button', { name: 'Send' }).click();
    },
    scale: async (p, i) => p.locator('.scale .step').nth([3, 3, 1][i]).click(),
    word: async (p, i) => {
      const words = [['transform', 'features'], ['features'], ['Features', 'magic']][i];
      for (let k = 0; k < words.length; k++) await p.locator('input.word').nth(k).fill(words[k]);
      await p.getByRole('button', { name: 'Send' }).click();
    },
    text: async (p, i) => {
      await p.locator('textarea.text').fill(['The chain rule', 'Why ReLU works', 'nonsense answer'][i]);
      await p.getByRole('button', { name: 'Send' }).click();
    },
    multi: async (p, i) => {
      for (const c of [['ReLU', 'sigmoid'], ['ReLU'], ['ReLU', 'Adam']][i]) {
        await p.locator('.choice', { hasText: c }).click();
      }
      await p.getByRole('button', { name: 'Send' }).click();
    },
    rank: async (p, i) => {
      if (i === 2) await p.getByRole('button', { name: 'Move down' }).first().click();
      await p.getByRole('button', { name: 'Send' }).click();
    },
    point: async (p, i) => {
      const img = p.locator('.tap img');
      const box = await img.boundingBox();
      await p.mouse.click(box.x + box.width * [0.5, 0.55, 0.3][i], box.y + box.height * [0.5, 0.45, 0.7][i]);
    },
  };

  for (const q of questions) {
    const round = await (await api.post(`/api/sessions/${code}/rounds`,
      { data: { question_id: q.id, phase: 'pre' } })).json();
    for (let i = 0; i < students.length; i++) {
      const p = students[i];
      await expect(p.locator('.qtext')).toContainText(q.text.slice(0, 20));
      await answer[q.kind](p, i);
      await expect(p.locator('.saved'), `${q.kind}: student ${i}`).toBeVisible();
      if (SHOTS && i === 0) await p.screenshot({ path: `${SHOTS}/input-${q.kind}.png`, fullPage: true });
    }
    await api.post(`/api/sessions/${code}/rounds/${round.id}/close`);
    // The phone shows the result too.
    await expect(students[0].locator('.phase')).toContainText('Results');
    if (SHOTS) await students[0].screenshot({ path: `${SHOTS}/phone-${q.kind}.png`, fullPage: true });
  }

  await teacher.goto(`/teacher/session/${code}/report`);
  const section = (text) => teacher.locator('section.q', { hasText: text });

  await expect(section('helix').locator('.histo .col')).not.toHaveCount(0);
  await expect(section('helix')).toContainText('Answer: 18 ± 2 residues');
  await expect(section('backpropagation').locator('.bar.pre')).toHaveCount(5);
  await expect(section('hidden layer').locator('.word', { hasText: /^features$/i })).toHaveCount(1);
  await expect(section('unclear').locator('.card')).toHaveCount(3);
  await expect(section('activation').locator('.tick')).toHaveCount(2);
  await expect(section('Order by size').locator('.bar.pre')).toHaveCount(3);
  await expect(section('centre').locator('.dot')).toHaveCount(3);

  // The teacher hides one card: gone from the projector and from the phones.
  await section('unclear').locator('.card', { hasText: 'nonsense' }).getByRole('button').click();
  await expect(section('unclear').locator('.card')).toHaveCount(2);

  if (SHOTS) {
    for (const [name, text] of [['number', 'helix'], ['scale', 'backpropagation'], ['word', 'hidden layer'],
      ['text', 'unclear'], ['multi', 'activation'], ['rank', 'Order by size'], ['point', 'centre']]) {
      await section(text).screenshot({ path: `${SHOTS}/report-${name}.png` });
    }
  }
});
