import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onOpenPlan, openListingKey, openStreamBase, profileStreamAddons } from './openStreams.ts';

const MAIN = 'https://aio.example/stremio/full';
const OPEN = 'https://aio.example/stremio/browse';

test('the open addon is used only beside a different playback addon', () => {
  assert.equal(openStreamBase(MAIN, OPEN), OPEN);
  assert.equal(openStreamBase(MAIN, null), null);
  assert.equal(openStreamBase(null, OPEN), null);
  assert.equal(openStreamBase(MAIN, MAIN), null);
});

test('a title asked for its versions, or already listed, gets them attached', () => {
  assert.equal(onOpenPlan({ asked: true, known: null, on: false, openBase: OPEN }), 'attach');
  assert.equal(onOpenPlan({ asked: false, known: 'cached', on: false, openBase: OPEN }), 'attach');
  assert.equal(onOpenPlan({ asked: false, known: 'fetching', on: true, openBase: OPEN }), 'attach');
});

test('opening a title lists through the open addon when one is set', () => {
  assert.equal(onOpenPlan({ asked: false, known: null, on: true, openBase: OPEN }), 'list-open');
});

test('opening a title lists through the playback addon when no open addon is set', () => {
  assert.equal(onOpenPlan({ asked: false, known: null, on: true, openBase: null }), 'list-full');
});

test('nothing is listed when resolve-on-open is off', () => {
  assert.equal(onOpenPlan({ asked: false, known: null, on: false, openBase: OPEN }), 'none');
  assert.equal(onOpenPlan({ asked: false, known: 'fetching', on: false, openBase: OPEN }), 'none');
});

test('an open listing is cached apart from the full list', () => {
  const full = 'uuid:main:movie:tt0816692:';
  assert.notEqual(openListingKey(full), full);
  assert.equal(openListingKey(full), openListingKey(full));
});

test('a profile with its own playback addon drops the open addon', () => {
  assert.deepEqual(profileStreamAddons('https://other.example/manifest.json'), {
    jellyfinStreamUrl: 'https://other.example/manifest.json',
    jellyfinOpenStreamUrl: undefined,
  });
  assert.deepEqual(profileStreamAddons(undefined), {});
  assert.deepEqual(profileStreamAddons(''), {});
});
