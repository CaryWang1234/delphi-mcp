#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as tools from './tools.js';

const MODES = ['latest', 'new', 'top'];
const PERIODS = ['daily', 'weekly', 'monthly', 'yearly', 'all'];
const ORDERS = ['default', 'created', 'top', 'likes', 'views', 'activity', 'posters'];

const maxChars = z
  .number()
  .int()
  .min(2000)
  .max(120000)
  .optional()
  .describe(`Cap the reply at this many characters (default ${tools.TOOL_DEFAULTS.DEFAULT_MAX_CHARS}).`);

const server = new McpServer({ name: 'chief-delphi', version: '0.1.0' });

function register(name, description, shape, handler) {
  server.registerTool(name, { title: name, description, inputSchema: shape, annotations: { readOnlyHint: true, openWorldHint: true } }, async (args) => {
    try {
      return { content: [{ type: 'text', text: await handler(args ?? {}) }] };
    } catch (err) {
      const text = err?.message ?? String(err);
      return { content: [{ type: 'text', text: `ERROR ${err?.name ?? 'Error'}: ${text}` }], isError: true };
    }
  });
}

register(
  'cd_categories',
  'List every Chief Delphi (chiefdelphi.com) category and subcategory with its numeric id and slug. ' +
    'Call this first when you need to scope a search or browse to a forum area such as Technical, Competition or Announcements. ' +
    'Read-only, no login. Returns ids usable in cd_topics/cd_find `category=`.',
  {},
  () => tools.listCategories()
);

register(
  'cd_topics',
  'Browse a page of Chief Delphi topic listings: newest (mode=latest), newly created (mode=new), or most-engaged (mode=top with a period). ' +
    'Optionally scope to one category. Use this to survey what is being discussed rather than to look for a specific phrase (use cd_find for that). ' +
    'Each row carries the topic id, slug, category id, post count, view count and last activity; feed ids to cd_raw or cd_topic.',
  {
    mode: z.enum(MODES).optional().describe('Listing feed to read. Default "latest".'),
    category: z.string().optional().describe('Category id, slug or exact name (see cd_categories). Omit for the whole forum.'),
    period: z.enum(PERIODS).optional().describe('For mode=top only. Default "monthly".'),
    order: z.enum(ORDERS).optional().describe('Sort order for the listing. Defaults to the feed order.'),
    page: z.number().int().min(0).max(500).optional().describe('Zero-based page; each page is ~30 topics. Default 0.'),
    limit: z.number().int().min(1).max(100).optional().describe('Rows to print from the page. Default 30.'),
    max_chars: maxChars,
  },
  ({ mode = 'latest', category, period = 'monthly', order, page = 0, limit = 30, max_chars }) =>
    tools.browseTopics({ mode, category, period, order, page, limit, max_chars })
);

register(
  'cd_find',
  'Find Chief Delphi topics matching keywords. Chief Delphi robots.txt disallows /search, so this does NOT call the forum search API: ' +
    'it pulls topic listings (mode/period/category/page window), matches tokens against titles, tags and excerpts, ranks the hits, ' +
    'then fetches /raw for the top `with_body` candidates to confirm the phrase inside the thread and report which posts matched. ' +
    'Coverage is the listing window you ask for, so the default mode=auto pools both most-engaged (top) and most-recent (latest) topics. ' +
    'An empty result means "not in this window", not "the forum has no such thread" — widen pages= or change mode. ' +
    'Good targets: game rumor/prediction threads, rule clarifications, strategy and build threads, event discussion.',
  {
    query: z.string().min(2).describe('Keywords, e.g. "canopy game announcement" or "hub latency".'),
    mode: z.enum(['auto', ...MODES]).optional().describe('Listing pool to search. Default "auto" (top + latest merged).'),
    period: z.enum(PERIODS).optional().describe('Period for the top part of the pool. Default "yearly"; use "all" for oldest-and-largest, "monthly" for this month.'),
    category: z.string().optional().describe('Restrict to one category id/slug (see cd_categories).'),
    order: z.enum(ORDERS).optional().describe('Sort order for the listing pool when mode is latest/new.'),
    pages: z.number().int().min(1).max(40).optional().describe('Listing pages pooled (30 topics each). Default 4 (2 top + 2 latest); 40 ≈ 1200 topics and ~15s.'),
    match: z.enum(['all', 'any']).optional().describe('Require every token (all, default) or at least one (any).'),
    with_body: z.number().int().min(0).max(25).optional().describe('Fetch /raw and confirm the match inside the thread for this many top candidates. Default 8; 0 skips body checks.'),
    limit: z.number().int().min(1).max(50).optional().describe('Results to print. Default 12.'),
    max_chars: maxChars,
  },
  ({ query, mode = 'auto', period = 'yearly', category, order, pages = 4, match = 'all', with_body = 8, limit = 12, max_chars }) =>
    tools.findTopics({ query, mode, category, period, order, pages, match, with_body, limit, max_chars })
);

register(
  'cd_topic',
  'Read a Chief Delphi thread with per-post metadata: author, user title, timestamp, like count, which post is replied to, post id, deleted/hidden flags. ' +
    'Threads render in ~20-post windows; jump with at_post=<post number> (exact, gap-safe) or page=<n> (page 2 starts at post 21). ' +
    'Discourse pads a window to ~20 live posts, so a thread containing deleted posts can repeat one boundary post between consecutive pages — prefer at_post for exact continuation. ' +
    'Use format="json" to reason over structured fields, format="text" (default) to read the discussion. ' +
    'For a cheap bulk read of a long thread use cd_raw instead.',
  {
    topic: z.number().int().positive().describe('Numeric topic id from cd_find / cd_topics.'),
    at_post: z.number().int().min(1).optional().describe('Start the window at this post number. Overrides page.'),
    page: z.number().int().min(1).max(500).optional().describe('One-based 20-post page within the thread. Default 1.'),
    chunk: z.number().int().min(1).max(100).optional().describe('Posts per window used to compute page (default 20; ignored when at_post is set).'),
    max_posts: z.number().int().min(1).max(100).optional().describe('Posts to render from this window. Default 20.'),
    format: z.enum(['text', 'json']).optional().describe('Output shape. Default "text".'),
    max_chars: maxChars,
  },
  ({ topic, at_post, page = 1, chunk = 20, max_posts = 20, format = 'text', max_chars }) =>
    tools.readTopic({ topic, at_post, page, chunk, max_posts, format, max_chars })
);

register(
  'cd_raw',
  'Fetch a Chief Delphi thread as plain Discourse markdown (the /raw endpoint) — the cheapest way to read a whole discussion, ' +
    'with author and timestamp headers per post and image references left as upload:// tokens. ' +
    'Read only part of a long thread with start_post/end_post to keep the reply small.',
  {
    topic: z.number().int().positive().describe('Numeric topic id.'),
    start_post: z.number().int().min(1).optional().describe('First post number to include.'),
    end_post: z.number().int().min(1).optional().describe('Last post number to include (needs start_post).'),
    max_chars: maxChars,
  },
  ({ topic, start_post, end_post, max_chars }) => tools.readRaw({ topic, start_post, end_post, max_chars })
);

register(
  'cd_user',
  'Look up a Chief Delphi account profile: trust level, titles, join date, last seen, last posted, profile views, time read, badge count, location, website, ' +
    'bio and profile fields (FRC/FTC team number, rookie year, roles). Useful for judging how much weight to give a forum claim. ' +
    'Anonymous Discourse does not expose post counts or likes received, and it does not list that user posts — see the note in the output for why.',
  {
    username: z.string().min(1).describe('Account name exactly as it appears at the end of a profile URL (/u/<this>), with no leading @.'),
    max_chars: maxChars,
  },
  ({ username, max_chars }) => tools.readUser({ username, max_chars })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('delphi-mcp: chief-delphi server ready on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`delphi-mcp: fatal ${err?.stack ?? err}\n`);
  process.exit(1);
});
