import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getJson } from '../src/discourse.js';

const client = new Client({ name: 'smoke', version: '0.0.1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/index.js'],
  cwd: process.cwd(),
  stderr: 'pipe',
});
await client.connect(transport);

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.map((c) => c.text ?? '').join('') ?? '';
  return { isError: Boolean(res.isError), text };
}

const listed = await client.listTools();
check('tools/list', listed.tools.length === 6, `${listed.tools.length} tools: ${listed.tools.map((t) => t.name).join(', ')}`);

const cats = await call('cd_categories', {});
check('cd_categories', !cats.isError && /announcements/i.test(cats.text), `${cats.text.length} chars`);

const latest = await call('cd_topics', { mode: 'latest', limit: 5 });
check('cd_topics latest', !latest.isError && /#\d+/.test(latest.text), `${latest.text.length} chars`);

const topCat = await call('cd_topics', { mode: 'top', category: 'technical', period: 'monthly', limit: 5 });
check('cd_topics top+category', !topCat.isError && topCat.text.includes('Technical [technical]'), `${topCat.text.length} chars · ${topCat.text.split('\n')[0]}`);

const badCat = await call('cd_topics', { category: 'not-a-real-category' });
check('cd_topics rejects unknown category', badCat.isError && /matches/.test(badCat.text), badCat.text.slice(0, 90));

const found = await call('cd_find', { query: 'game prediction', pages: 4, with_body: 3, limit: 5 });
check('cd_find auto-pool finds the 2027 prediction thread', !found.isError && found.text.includes('#519808'), `pool line: ${/Pool: .*/.exec(found.text)?.[0] ?? 'none'}`);
check('cd_find body check reports post numbers', /body: matched in #\d+ \(/.test(found.text), found.text.split('\n').find((l) => l.includes('body: matched'))?.slice(0, 120) ?? 'no body line');

const noHit = await call('cd_find', { query: 'zzqxv-never-a-forum-word', pages: 1, with_body: 0 });
check('cd_find reports empty pool honestly', !noHit.isError && /No title\/tag\/excerpt match/.test(noHit.text), noHit.text.slice(-90));

const badTopic = await call('cd_topic', { topic: 99999999 });
check('cd_topic handles missing topic', badTopic.isError && /not found/.test(badTopic.text), badTopic.text.slice(0, 110));

const w1 = JSON.parse((await call('cd_topic', { topic: 519808, page: 1, format: "json", max_chars: 120000 })).text);
const w2 = JSON.parse((await call('cd_topic', { topic: 519808, page: 2, format: "json", max_chars: 120000 })).text);
const w3 = JSON.parse((await call('cd_topic', { topic: 519808, at_post: 41, format: "json", max_chars: 120000 })).text);
check(
  'cd_topic windows start exactly where asked',
  w1.window.first_post === 1 && w2.window.first_post === 21 && w3.window.first_post === 41,
  `p1 ${w1.window.first_post}-${w1.window.last_post} · p2 ${w2.window.first_post}-${w2.window.last_post} · at_post=41 ${w3.window.first_post}-${w3.window.last_post} of ${w3.total_posts_in_stream}`
);
check(
  'cd_topic windows strictly increase and stay bounded',
  [w1, w2, w3].every((w) => w.posts.every((p, i, a) => i === 0 || p.post_number > a[i - 1].post_number) && w.window.last_post - w.window.first_post <= 21),
  'no duplicate or out-of-order post numbers in any window'
);
check('cd_topic exposes reply threads and flags', w1.posts.every((p) => 'reply_to_post_number' in p && 'deleted' in p && 'hidden' in p), `${w1.posts.length} posts, authors ${new Set(w1.posts.map((p) => p.username)).size}`);

const raw = await call('cd_raw', { topic: 519808, start_post: 1, end_post: 2 });
check('cd_raw post range', !raw.isError && /CD topic 519808/.test(raw.text), `${raw.text.length} chars`);

const big = await call('cd_raw', { topic: 519808, max_chars: 2000 });
check('cd_raw honours max_chars', !big.isError && big.text.length < 2600 && /truncated/.test(big.text), `${big.text.length} chars`);

const user = await call('cd_user', { username: '@CARY_WANG' });
check('cd_user', !user.isError && /username: Cary_Wang/i.test(user.text) && /FRC Team Number/.test(user.text), `${user.text.length} chars · ${user.text.split('\n').filter((l) => /trust_level|profile fields/.test(l)).join(' || ')}`);

const badUser = await call('cd_user', { username: 'no-such-user-88817' });
check('cd_user rejects unknown account', badUser.isError && /404/.test(badUser.text), badUser.text.slice(0, 90));

// The robots.txt guard is the load-bearing compliance claim, so prove it bites.
let guardBlocked = null;
try {
  await getJson('/search.json?q=swerve');
} catch (err) {
  guardBlocked = err?.name;
}
check('robots guard blocks /search.json', guardBlocked === 'RobotsBlockedError', String(guardBlocked));

let adminBlocked = null;
try {
  await getJson('/admin/logs.json');
} catch (err) {
  adminBlocked = err?.name;
}
check('robots guard blocks /admin/', adminBlocked === 'RobotsBlockedError', String(adminBlocked));

const control = await getJson('/latest.json', { ttl: 0 });
check('control: allowed path still passes through guard', Array.isArray(control?.topic_list?.topics), `${control?.topic_list?.topics?.length ?? 0} topics`);

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
// Let Node drain the stdio pipes on its own; process.exit() here races the transport
// teardown and trips a libuv assertion on Windows.
process.exitCode = failures ? 1 : 0;
