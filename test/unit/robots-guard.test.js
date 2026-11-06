import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed, matchesAgent, uaTokenOf } from '../../src/discourse.js';

// Synthetic robots.txt with the same shape Chief Delphi publishes (multiple named-bot
// groups that each Disallow /, then a catch-all group). No scraped content here.
const ROBOTS = `
User-agent: mauibot
Disallow: /

User-agent: semrushbot
Disallow: /

User-agent: *
Disallow: /admin/
Disallow: /auth/
Disallow: /email/
Disallow: /session
Disallow: /user-api-key
Disallow: /*?api_key*
Disallow: /badges
Disallow: /my
Disallow: /search
Disallow: /tag/*/l
Disallow: /c/*.rss
Disallow: /t/*/*.rss

User-agent: *
Allow: /c/technical/9.json
Disallow: /c/
`;

const UA_TOKEN = uaTokenOf('delphi-mcp/0.1 (+read-only Discourse client)');

test('other bots’ blanket Disallow: / does not leak onto our group', () => {
  const rules = parseRobots(ROBOTS);
  // This is the exact aliasing bug an earlier version shipped: rules stored the agents
  // array by reference, so mauibot's "Disallow: /" ended up tagged with '*' too.
  assert.equal(isAllowed(rules, '/latest.json', UA_TOKEN).allowed, true);
  assert.equal(isAllowed(rules, '/site.json', UA_TOKEN).allowed, true);
});

test('disallowed prefixes are refused', () => {
  const rules = parseRobots(ROBOTS);
  for (const path of ['/search.json?q=swerve', '/admin/logs.json', '/session/burst', '/my/activity', '/email/replies', '/badges', '/user-api-key/new']) {
    assert.equal(isAllowed(rules, path, UA_TOKEN).allowed, false, path);
  }
});

test('* wildcard in a robots path matches any sequence', () => {
  const rules = parseRobots(ROBOTS);
  assert.equal(isAllowed(rules, '/c/technical/9.rss', UA_TOKEN).allowed, false);
  assert.equal(isAllowed(rules, '/t/some-slug/123456.rss', UA_TOKEN).allowed, false);
  assert.equal(isAllowed(rules, '/tag/canopy/l/none.json', UA_TOKEN).allowed, false);
  // The JSON equivalents of the same resources stay open — that is the whole point.
  assert.equal(isAllowed(rules, '/c/technical/9.json', UA_TOKEN).allowed, true);
  assert.equal(isAllowed(rules, '/t/123456.json', UA_TOKEN).allowed, true);
});

test('query-string rules match only when the query is present', () => {
  const rules = parseRobots(ROBOTS);
  assert.equal(isAllowed(rules, '/latest.json?api_key=secret', UA_TOKEN).allowed, false);
  assert.equal(isAllowed(rules, '/latest.json', UA_TOKEN).allowed, true);
});

test('longest matching rule wins, and Allow outweighs Disallow at equal specificity', () => {
  const rules = parseRobots(ROBOTS);
  // Second '*' group: /c/ is disallowed but /c/technical/9.json is explicitly allowed.
  assert.equal(isAllowed(rules, '/c/technical/9.json', UA_TOKEN).allowed, true);
  assert.equal(isAllowed(rules, '/c/technical/9/l/top.json', UA_TOKEN).allowed, false);
});

test('consecutive user-agent lines share one group', () => {
  const rules = parseRobots('User-agent: delphi-mcp\nUser-agent: curl\nDisallow: /private');
  assert.equal(isAllowed(rules, '/private/x', 'delphi-mcp/0.1').allowed, false);
  assert.equal(isAllowed(rules, '/private/x', 'curl/8').allowed, false);
  assert.equal(isAllowed(rules, '/public/x', 'delphi-mcp/0.1').allowed, true);
});

test('a group with no rules does not block anything', () => {
  const rules = parseRobots('User-agent: *\nAllow: /');
  assert.equal(isAllowed(rules, '/anything/at/all', UA_TOKEN).allowed, true);
  assert.equal(rules.length, 1);
});

test('agent matching is token-prefix based', () => {
  const rules = parseRobots('User-agent: delphi-mcp\nDisallow: /nope');
  assert.equal(matchesAgent(rules[0], 'delphi-mcp/0.1'), true);
  assert.equal(matchesAgent(rules[0], 'other-bot'), false);
  assert.equal(isAllowed(rules, '/nope/1', 'delphi-mcp/0.1').allowed, false);
});
