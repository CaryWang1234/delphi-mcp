import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotTopics, diffWatch } from '../../src/tools.js';

const listed = (over) => ({ id: 1, title: 'T', posts_count: 10, views: 100, created_at: '2026-01-01T00:00:00Z', last_posted_at: '2026-01-02T00:00:00Z', last_poster_username: 'a', ...over });

test('snapshot keeps only the fields a delta needs', () => {
  const snap = snapshotTopics([listed({ id: 7 })]);
  assert.deepEqual(Object.keys(snap), ['7']);
  assert.deepEqual(snap['7'], { title: 'T', posts: 10, views: 100, last: '2026-01-02T00:00:00Z', by: 'a' });
});

test('snapshot falls back to created_at when a topic has no replies', () => {
  const snap = snapshotTopics([listed({ last_posted_at: null })]);
  assert.equal(snap['1'].last, '2026-01-01T00:00:00Z');
});

test('a topic that was not in the baseline is reported as new', () => {
  const prev = snapshotTopics([listed({ id: 1 })]);
  const { news, updated } = diffWatch(prev, [listed({ id: 1 }), listed({ id: 2 })]);
  assert.deepEqual(news.map((t) => t.id), [2]);
  assert.equal(updated.length, 0);
});

test('new posts are reported with an exact delta', () => {
  const prev = snapshotTopics([listed({ id: 1, posts_count: 10, views: 100, last_posted_at: '2026-01-02T00:00:00Z' })]);
  const current = [listed({ id: 1, posts_count: 14, views: 133, last_posted_at: '2026-01-03T00:00:00Z' })];
  const { news, updated } = diffWatch(prev, current);
  assert.equal(news.length, 0);
  assert.deepEqual([updated[0].postDelta, updated[0].viewDelta], [4, 33]);
});

test('views alone do not count as activity', () => {
  const prev = snapshotTopics([listed({ id: 1 })]);
  const { updated } = diffWatch(prev, [listed({ id: 1, views: 99999 })]);
  assert.equal(updated.length, 0, 'a view bump with no new post is noise for a watcher');
});

test('a new last-post timestamp counts even if the count did not move', () => {
  const prev = snapshotTopics([listed({ id: 1, posts_count: 10 })]);
  const current = [listed({ id: 1, posts_count: 10, last_posted_at: '2026-02-01T00:00:00Z' })];
  const { updated } = diffWatch(prev, current);
  assert.equal(updated.length, 1, 'edits and deletions shift the tip without raising the count');
});

test('a shrinking post count is not reported as new activity', () => {
  const prev = snapshotTopics([listed({ id: 1, posts_count: 10 })]);
  const current = [listed({ id: 1, posts_count: 8, last_posted_at: '2026-01-02T00:00:00Z' })];
  assert.equal(diffWatch(prev, current).updated.length, 0);
});

test('topics that fell out of the listing window are reported separately', () => {
  const prev = snapshotTopics([listed({ id: 1 }), listed({ id: 2 }), listed({ id: 3 })]);
  const { dropped } = diffWatch(prev, [listed({ id: 1 }), listed({ id: 2 })]);
  assert.deepEqual(dropped, ['3']);
});

test('an empty baseline is tolerated so the first delta call cannot crash', () => {
  const { news, updated, dropped } = diffWatch(undefined, [listed({ id: 1 })]);
  assert.equal(news.length, 1);
  assert.equal(updated.length, 0);
  assert.equal(dropped.length, 0);
});

test('an emptied listing reports everything as dropped, not as deleted', () => {
  const prev = snapshotTopics([listed({ id: 1 }), listed({ id: 2 })]);
  assert.deepEqual(diffWatch(prev, []).dropped, ['1', '2']);
});
