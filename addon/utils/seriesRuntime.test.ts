import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typicalEpisodeRuntime } from './seriesRuntime.ts';

const season = (season_number: number, runtimes: Array<number | null>) =>
  runtimes.map((runtime) => ({ season_number, runtime }));

test('a long finale does not become the series runtime', () => {
  // The Office: ~22-minute episodes, a 45-minute finale (what last_episode_to_air reports).
  const episodes = [...season(1, [24, 22, 23, 22, 23, 23]), ...season(9, [22, 22, 21, 45])];
  // Sorted: 21 22 22 22 22 | 23 23 23 24 45, so the median is 22.5, rounded to 23.
  assert.equal(typicalEpisodeRuntime(episodes), 23);
});

test('specials (season 0) are left out', () => {
  const episodes = [...season(0, [120, 95, 3]), ...season(1, [58, 48, 48])];
  assert.equal(typicalEpisodeRuntime(episodes), 48);
});

test('missing and zero runtimes are skipped', () => {
  const episodes = [...season(1, [null, 0, 41, 39]), { season_number: 2 }];
  assert.equal(typicalEpisodeRuntime(episodes), 40);
});

test('an even count takes the rounded middle of the two', () => {
  assert.equal(typicalEpisodeRuntime(season(1, [50, 53])), 52);
});

test('nothing usable gives null, so the caller keeps its fallback', () => {
  assert.equal(typicalEpisodeRuntime([]), null);
  assert.equal(typicalEpisodeRuntime(undefined), null);
  assert.equal(typicalEpisodeRuntime(season(0, [30])), null);
  assert.equal(typicalEpisodeRuntime(season(1, [null, null])), null);
});
