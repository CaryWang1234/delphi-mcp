import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRawPosts, topicWindowPath } from '../../src/tools.js';

// Hand-written /raw-shaped text (Discourse prints "author | timestamp UTC | #n" per post).
const RAW = [
  'team_member_1 | 2026-01-05 10:00:00 UTC | #1',
  '',
  'Opening post body with a pipe | and a stray #456 that must not look like a header.',
  '',
  '-------------------------',
  '',
  'other_user | 2026-01-05 11:30:00 UTC | #2',
  '',
  'Second body.',
  '',
  'Display Name | 2026-02-01 09:00:00 UTC | #14',
  '',
  'Fourteenth body.',
].join('\n');

test('raw post splitting finds every header', () => {
  const posts = splitRawPosts(RAW);
  assert.equal(posts.length, 3);
  assert.deepEqual(posts.map((p) => p.number), ['#1', '#2', '#14']);
  assert.deepEqual(posts.map((p) => p.author), ['team_member_1', 'other_user', 'Display Name']);
});

test('each slice holds its own body and not the next header', () => {
  const posts = splitRawPosts(RAW);
  assert.match(posts[0].text, /Opening post body/);
  assert.doesNotMatch(posts[0].text, /Second body/);
  assert.doesNotMatch(posts[0].text, /2026-01-05 11:30/, 'the next header must start the next slice');
  assert.match(posts[2].text, /Fourteenth body/);
});

test('a pipe and a hash inside a body line are not a header', () => {
  const posts = splitRawPosts(RAW);
  assert.equal(posts.filter((p) => p.text.includes('stray #456')).length, 1);
  assert.equal(posts[0].number, '#1', 'the decoy line must not split the first post');
});

test('text before the first header is ignored rather than inventing a post', () => {
  const posts = splitRawPosts(`preamble without headers\n${RAW}`);
  assert.equal(posts.length, 3);
  assert.equal(posts[0].number, '#1');
});

test('topic windows anchor five posts before the desired start', () => {
  // Upstream fact: /t/<id>/<n>.json takes a post number and its window begins at n-5,
  // so asking for start 21 must request 26.
  assert.equal(topicWindowPath(519808, 1), '/t/519808.json');
  assert.equal(topicWindowPath(519808, 21), '/t/519808/26.json?context=26');
  assert.equal(topicWindowPath(519808, 41), '/t/519808/46.json?context=46');
  assert.equal(topicWindowPath(519808, 0), '/t/519808.json');
});
