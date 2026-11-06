import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listPath, poolsFor, parseRef } from '../../src/tools.js';

const cat = { id: 9, slug: 'technical', name: 'Technical' };

test('global listings use the bare feed path', () => {
  assert.equal(listPath({ mode: 'latest', category: null, page: 0 }), '/latest.json');
  assert.equal(listPath({ mode: 'new', category: null, page: 0 }), '/new.json');
  assert.equal(listPath({ mode: 'top', category: null, period: 'monthly', page: 0 }), '/top.json?period=monthly');
});

test('category listings need the numeric id in the path, not just the slug', () => {
  // /c/<slug>.json 301s upstream; the canonical anonymous form is /c/<slug>/<id>/l/<feed>.json
  assert.equal(
    listPath({ mode: 'top', category: cat, period: 'yearly', page: 0 }),
    '/c/technical/9/l/top.json?period=yearly'
  );
  assert.equal(listPath({ mode: 'latest', category: cat, page: 2 }), '/c/technical/9/l/latest.json?page=2');
});

test('ordering and paging parameters compose', () => {
  assert.equal(
    listPath({ mode: 'latest', category: cat, order: 'created', page: 3 }),
    '/c/technical/9/l/latest.json?order=created&page=3'
  );
  assert.equal(listPath({ mode: 'top', category: null, period: 'all', page: 0 }), '/top.json?period=all');
});

test('auto pools split the budget between top and latest', () => {
  const pools = poolsFor('auto', 'yearly', 4);
  assert.equal(pools.length, 2);
  assert.deepEqual(pools.map((p) => [p.mode, p.pages]), [['top', 2], ['latest', 2]]);
  assert.equal(pools[0].period, 'yearly');
});

test('auto pools with an odd budget keep both halves non-empty', () => {
  const pools = poolsFor('auto', 'monthly', 3);
  assert.deepEqual(pools.map((p) => [p.mode, p.pages]), [['top', 2], ['latest', 1]]);
  assert.equal(poolsFor('auto', 'monthly', 1)[1].pages, 1);
});

test('an explicit mode uses one pool with the whole budget', () => {
  const pools = poolsFor('top', 'all', 6);
  assert.equal(pools.length, 1);
  assert.deepEqual([pools[0].mode, pools[0].pages, pools[0].period], ['top', 6, 'all']);
});

test('category references accept id, slug, or exact name', () => {
  assert.deepEqual(parseRef('9'), { id: 9, slug: '9' });
  assert.deepEqual(parseRef('Technical'), { id: null, slug: 'technical' });
  assert.deepEqual(parseRef('/c/technical/9'), { id: null, slug: '/c/technical/9' });
  assert.equal(parseRef(undefined), null);
  assert.equal(parseRef('  '), null);
});
