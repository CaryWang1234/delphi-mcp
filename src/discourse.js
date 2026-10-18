import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BASE_URL = (process.env.DELPHI_BASE_URL || 'https://www.chiefdelphi.com').replace(/\/+$/, '');
const USER_AGENT = process.env.DELPHI_USER_AGENT || 'delphi-mcp/0.1 (+read-only Discourse client)';
const MIN_INTERVAL_MS = Number(process.env.DELPHI_MIN_INTERVAL_MS ?? 350);
const REQUEST_TIMEOUT_MS = Number(process.env.DELPHI_REQUEST_TIMEOUT_MS ?? 20000);
const CACHE_DIR = process.env.DELPHI_CACHE_DIR || path.join(ROOT, '.cache');

const TTL = {
  robots: 24 * 3600,
  site: 6 * 3600,
  list: 10 * 60,
  topic: 3 * 3600,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Chief Delphi sits behind Cloudflare. Serialize every request with a floor interval
// so a paged crawl cannot turn into a parallel burst.
let lane = Promise.resolve();
function enqueue(task) {
  const result = lane.then(task, task);
  lane = result.then(
    () => sleep(MIN_INTERVAL_MS),
    () => sleep(MIN_INTERVAL_MS)
  );
  return result;
}

function cachePath(key) {
  return path.join(CACHE_DIR, `${createHash('sha1').update(key).digest('hex')}.json`);
}

async function readCache(key, ttl) {
  if (ttl <= 0) return null;
  try {
    const entry = JSON.parse(await readFile(cachePath(key), 'utf8'));
    if (Date.now() - entry.fetchedAt > ttl * 1000) return null;
    return entry.body;
  } catch {
    return null;
  }
}

async function writeCache(key, body) {
  const entry = { key, fetchedAt: Date.now(), body };
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath(key), JSON.stringify(entry), 'utf8');
  } catch (err) {
    process.stderr.write(`delphi-mcp: cache write failed (${err.message})\n`);
  }
}

function parseRobots(text) {
  const rules = [];
  let agents = [];
  let groupOpen = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === 'user-agent') {
      // A user-agent line after any rule line opens a new group; consecutive ones share it.
      if (!groupOpen) {
        agents = [];
        groupOpen = true;
      }
      agents.push(value.toLowerCase());
      continue;
    }
    groupOpen = false;
    if (!value && field === 'disallow') continue;
    if (field !== 'allow' && field !== 'disallow') continue;
    rules.push({ agents: [...agents], allow: field === 'allow', path: value });
  }
  return rules;
}

function matchesAgent(rule, uaToken) {
  return rule.agents.some((agent) => agent === '*' || (agent.length > 0 && uaToken.startsWith(agent)));
}

function toPattern(robotsPath) {
  const escaped = robotsPath.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '\u0000').replace(/\?/g, '\\?');
  const body = escaped.replace(/\u0000/g, '.*');
  const anchored = body.startsWith('/') ? `^${body}` : `^.*${body}`;
  return new RegExp(robotsPath.endsWith('$') ? `${anchored}$` : anchored);
}

let robotsPromise = null;
async function loadRobots() {
  if (!robotsPromise) {
    robotsPromise = (async () => {
      const cached = await readCache('/robots.txt', TTL.robots);
      const body = cached ?? (await fetchRaw('/robots.txt', { accept: 'text/plain', as: 'text' }));
      if (!cached) await writeCache('/robots.txt', body);
      return parseRobots(body);
    })().catch((err) => {
      process.stderr.write(`delphi-mcp: robots.txt unavailable (${err.message}); continuing without it\n`);
      return null;
    });
  }
  return robotsPromise;
}

async function assertAllowed(pathWithQuery) {
  const rules = await loadRobots();
  if (!rules) return;
  const uaToken = USER_AGENT.split(/[\s(/]/)[0].toLowerCase();
  let best = null;
  for (const rule of rules) {
    if (!matchesAgent(rule, uaToken)) continue;
    if (!toPattern(rule.path).test(pathWithQuery)) continue;
    if (best === null || rule.path.length > best.path.length) best = rule;
  }
  if (best && !best.allow) {
    throw new RobotsBlockedError(pathWithQuery, best.path);
  }
}

export class RobotsBlockedError extends Error {
  constructor(requestPath, rule) {
    super(`Chief Delphi robots.txt disallows "${rule}" for this client, so "${requestPath}" was not fetched.`);
    this.name = 'RobotsBlockedError';
  }
}

async function fetchRaw(pathWithQuery, { accept, as }) {
  const url = `${BASE_URL}${pathWithQuery}`;
  return enqueue(async () => {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) {
      const hint =
        res.status === 404 ? ' (no such topic/post/category)'
        : res.status === 403 || res.status === 503 ? ' (Cloudflare blocked the request; raise DELPHI_MIN_INTERVAL_MS and retry later)'
        : res.status === 429 ? ' (rate limited; raise DELPHI_MIN_INTERVAL_MS)'
        : '';
      throw new Error(`HTTP ${res.status} ${pathWithQuery}${hint}`);
    }
    return as === 'text' ? res.text() : res.json();
  });
}

async function request(pathWithQuery, { accept, as, ttl }) {
  await assertAllowed(pathWithQuery);
  const cached = await readCache(pathWithQuery, ttl);
  if (cached !== null) return cached;
  const body = await fetchRaw(pathWithQuery, { accept, as });
  await writeCache(pathWithQuery, body);
  return body;
}

export function getJson(pathWithQuery, { ttl = TTL.list } = {}) {
  return request(pathWithQuery, { accept: 'application/json', as: 'json', ttl });
}

export function getText(pathWithQuery, { ttl = TTL.topic } = {}) {
  return request(pathWithQuery, { accept: 'text/plain', as: 'text', ttl });
}

export function topicUrl(id, slug) {
  return slug ? `${BASE_URL}/t/${slug}/${id}` : `${BASE_URL}/t/${id}`;
}

export const CACHE_TTL = TTL;
