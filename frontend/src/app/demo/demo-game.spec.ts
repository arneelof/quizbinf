import { BOTS, botAnswers, buildBoard, demoQuestions, points, seeded } from './demo-game';

describe('the competition demo game', () => {
  it('scores like the server: 1000 at once, 500 at the buzzer, 0 if wrong', () => {
    expect(points(true, 0, 15000)).toBe(1000);
    expect(points(true, 15000, 15000)).toBe(500);
    expect(points(true, 7500, 15000)).toBe(750);
    expect(points(false, 0, 15000)).toBe(0);
  });

  it('has one right answer per question, and every bot answers inside the clock', () => {
    const rng = seeded(7);
    for (const q of demoQuestions(rng)) {
      expect(q.choices.filter((c) => c.is_correct).length).toBe(1);
      const answers = botAnswers(q, 15000, rng);
      expect(answers.length).toBe(BOTS.length);
      for (const a of answers) {
        expect(a.afterMs).toBeGreaterThan(0);
        expect(a.afterMs).toBeLessThan(15000);
        expect(q.choices.some((c) => c.id === a.choiceId)).toBeTrue();
      }
    }
  });

  it('repeats a game exactly from the same seed', () => {
    const a = demoQuestions(seeded(42)).map((q) => q.choices.map((c) => c.id));
    const b = demoQuestions(seeded(42)).map((q) => q.choices.map((c) => c.id));
    expect(a).toEqual(b);
  });

  it('ranks like the server: ties share a place, and remembers the last round', () => {
    const board = buildBoard(
      ['Ann', 'Ben', 'Cy'],
      [
        { Ann: { choiceId: 1, points: 900, correct: true }, Ben: { choiceId: 1, points: 900, correct: true } },
        { Cy: { choiceId: 1, points: 1000, correct: true }, Ann: { choiceId: 2, points: 0, correct: false } },
      ],
      4,
    );
    expect(board.entries.map((e) => [e.nickname, e.score, e.rank])).toEqual([
      ['Cy', 1000, 1],
      ['Ann', 900, 2],
      ['Ben', 900, 2],
    ]);
    const cy = board.entries[0];
    expect(cy.gained).toBe(1000);
    expect(cy.previous_rank).toBe(3);
    expect(board.entries[1].last_correct).toBeFalse();
    expect(board.entries[2].last_correct).toBeNull();
  });
});
