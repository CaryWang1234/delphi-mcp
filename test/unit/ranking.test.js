import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, countIn, scoreTopic, firstWindow } from '../../src/tools.js';

const topic = (over) => ({ title: '', tags: [], excerpt: '', last_post_excerpt: '', ...over });

test('tokenization drops punctuation and case', () => {
  assert.deepEqual(tokenize('Hub  latency?!'), ['hub', 'latency']);
  assert.deepEqual(tokenize('2026 REBUILT'), ['2026', 'rebuilt']);
  assert.deepEqual(tokenize('---'), []);
});

test('countIn counts non-overlapping occurrences', () => {
  assert.equal(countIn('a bb bb b', 'bb'), 2);
  assert.equal(countIn('aaa', 'aa'), 1);
  assert.equal(countIn('nothing here', 'zzz'), 0);
});

test('title matches outweigh excerpt matches', () => {
  const inTitle = scoreTopic(topic({ title: 'Swerve drive questions' }), ['swerve'], 'swerve').score;
  const inExcerpt = scoreTopic(topic({ title: 'General chat', excerpt: '...swerve...' }), ['swerve'], 'swerve').score;
  assert.ok(inTitle > inExcerpt * 2, `${inTitle} vs ${inExcerpt}`);
});

test('tags are weighted below titles but above excerpts', () => {
  const title = scoreTopic(topic({ title: 'canopy stuff' }), ['canopy'], 'canopy').score;
  const tag = scoreTopic(topic({ title: 'stuff', tags: ['canopy'] }), ['canopy'], 'canopy').score;
  const excerpt = scoreTopic(topic({ title: 'stuff', excerpt: 'canopy' }), ['canopy'], 'canopy').score;
  assert.ok(title > tag && tag > excerpt, `${title} > ${tag} > ${excerpt}`);
});

test('matching reports which tokens were found, so AND filters can act on it', () => {
  const { matched } = scoreTopic(topic({ title: 'game predictions only' }), ['game', 'zzz'], 'game zzz');
  assert.deepEqual([...matched], ['game']);
});

test('repeated tokens are capped at three hits per field', () => {
  const two = scoreTopic(topic({ title: 'hub hub' }), ['hub'], 'hub').score;
  const three = scoreTopic(topic({ title: 'hub hub hub' }), ['hub'], 'hub').score;
  const eight = scoreTopic(topic({ title: 'hub hub hub hub hub hub hub hub' }), ['hub'], 'hub').score;
  assert.equal(three, eight, 'past the cap, more repetition must not buy more rank');
  assert.ok(two < three, 'up to the cap, repetition must still count');
});

test('a full phrase match earns a bonus on top of its tokens', () => {
  const together = scoreTopic(topic({ title: 'game predictions thread' }), ['game', 'predictions'], 'game predictions');
  const apart = scoreTopic(topic({ title: 'predictions about the game' }), ['game', 'predictions'], 'game predictions');
  assert.ok(together.score > apart.score, `${together.score} vs ${apart.score}`);
});

test('firstWindow centers on the earliest token hit', () => {
  const window = firstWindow('prefix text that is fairly long\nthe keyword appears right here\nmore trailing words follow after', ['keyword']);
  assert.match(window, /keyword appears/);
  assert.ok(window.length <= 200, window.length);
});

test('firstWindow returns null when nothing matches', () => {
  assert.equal(firstWindow('plain text', ['absent']), null);
});

test('firstWindow collapses newlines so a snippet stays one line', () => {
  const window = firstWindow('line one\nline two target\nline three', ['target']);
  assert.doesNotMatch(window, /\n/);
});
