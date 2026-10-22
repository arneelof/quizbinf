import { TestBed } from '@angular/core/testing';

import { Leaderboard, LeaderboardEntry, SessionState, msLeft } from '../models';
import { GameLeaderboardComponent } from './game-leaderboard.component';

function entry(nickname: string, score: number, gained: number, rank: number): LeaderboardEntry {
  return {
    participant_id: nickname.charCodeAt(0),
    nickname,
    score,
    gained,
    rank,
    previous_rank: null,
    last_correct: gained > 0,
  };
}

function board(entries: LeaderboardEntry[]): Leaderboard {
  return { players: entries.length, rounds_played: 2, questions: 5, last_question_id: 1, entries };
}

describe('GameLeaderboardComponent', () => {
  function make(b: Leaderboard): GameLeaderboardComponent {
    TestBed.configureTestingModule({ imports: [GameLeaderboardComponent] });
    const c = TestBed.createComponent(GameLeaderboardComponent).componentInstance;
    c.data = b;
    return c;
  }

  it('starts each row where it stood before the last question', () => {
    // Before: Ann 1000, Ben 900, Cy 0. Cy's 1950 takes the lead.
    const c = make(board([entry('Cy', 1950, 1950, 1), entry('Ann', 1000, 0, 2), entry('Ben', 900, 0, 3)]));
    const rows = c.rows().map((r) => [r.entry.nickname, r.from, r.index]);
    expect(rows).toEqual([
      ['Cy', 2, 0],
      ['Ann', 0, 1],
      ['Ben', 1, 2],
    ]);
  });

  it('brings a climber in from just below the top five', () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map((n, i) => entry(n, 1000 - i * 100, 0, i + 2));
    const c = make(board([entry('Z', 2000, 2000, 1), ...five]));
    expect(c.rows().length).toBe(5);
    expect(c.rows()[0].from).toBe(5);
  });

  it('counts the score up from where it was', () => {
    const c = make(board([entry('Ann', 1800, 800, 1)]));
    expect(c.shownScore(c.rows()[0].entry)).toBe(1000);
  });
});

describe('msLeft', () => {
  const state = {
    round_deadline: '2026-10-22T10:00:20Z',
    server_time: '2026-10-22T10:00:05Z',
  } as SessionState;

  it('carries the server’s time left forward on this device’s clock', () => {
    // A phone whose clock is an hour out still counts the same 15 seconds.
    const received = Date.parse('2026-10-22T11:00:00Z');
    expect(msLeft(state, received, received)).toBe(15000);
    expect(msLeft(state, received, received + 4000)).toBe(11000);
    expect(msLeft(state, received, received + 60000)).toBe(0);
  });

  it('is zero without a clock', () => {
    expect(msLeft({} as SessionState, 0, 0)).toBe(0);
  });
});
