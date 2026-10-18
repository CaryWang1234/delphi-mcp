# delphi-mcp

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent read
[Chief Delphi](https://www.chiefdelphi.com) — the discussion forum of the FIRST Robotics Competition,
running on Discourse.

No account, no API key, no write access. The server speaks the anonymous read endpoints a browser already
uses, and it enforces the site's `robots.txt` in code rather than in a comment.

```
cd_categories  →  cd_find / cd_topics  →  cd_raw / cd_topic  →  cd_user
   scope it          find the thread        read the thread      vet the claim
```

## Why this exists

Chief Delphi is where FRC teams post game rumors, strategy, code and CAD releases, and event discussion.
An agent asked to research one of those needs a way into the forum, and the obvious answer — the Discourse
`/search.json` endpoint — is explicitly disallowed for crawlers by Chief Delphi's `robots.txt`. This server
is the attempt at getting useful recall *without* that endpoint. See
[Compliance](#compliance-is-structural-not-advisory).

## Requirements

- Node.js 18 or newer (global `fetch`; developed and tested on Node 24)
- No build step — plain ESM JavaScript

## Install

```bash
git clone https://github.com/CaryWang1234/delphi-mcp.git
cd delphi-mcp
npm install
```

## Connect it to your MCP client

All clients take the same stdio entry; only the config file differs. Point `args` at the absolute path of
`src/index.js`.

```json
{
  "mcpServers": {
    "chief-delphi": {
      "command": "node",
      "args": ["/absolute/path/to/delphi-mcp/src/index.js"]
    }
  }
}
```

| Client | File |
| --- | --- |
| Claude Desktop | `claude_desktop_config.json` |
| Cursor | `.cursor/mcp.json` |
| Qoder | `settings.json` in the app data dir (`%USERPROFILE%\.qoder-cn\` on Windows, `~/.qoder-cn/` elsewhere) |
| Any other stdio client | its own `mcpServers` / `servers` map |

Some hosts cache the tool list after the first handshake. If you change a tool description in
`src/index.js` and the client still shows the old one, reload MCP servers (`/mcp reload` in Qoder) or
restart the host. On Windows, prefer an absolute `command` path such as
`C:\\Program Files\\nodejs\\node.exe` — hosts do not always inherit your shell's `PATH`.

## Tools

Every tool accepts `max_chars` (default `20000`, ceiling `120000`). When a reply would exceed it, the
output is cut and the last line says so and tells you how to continue — one call cannot flood the model's
context.

| Tool | What it does | Arguments (defaults) |
| --- | --- | --- |
| `cd_categories` | Every category and subcategory with numeric id, slug, topic count and restricted flag. Call first to scope anything else. | — |
| `cd_topics` | One page of a topic listing: `latest`, `new`, or `top` over a `period`; optionally within one category. | `mode=latest` `category` `period=monthly` `order` `page=0` `limit=30` |
| `cd_find` | Keyword lookup without `/search.json`: pool listings, match titles/tags/excerpts, rank, then read `/raw` of the best candidates to confirm the match inside the thread and report which posts matched. | `query` `mode=auto` `period=yearly` `category` `pages=4` `match=all` `with_body=8` `limit=12` |
| `cd_topic` | A thread window with per-post metadata: author, user title, timestamp, likes, which post is replied to, post id, deleted/hidden flags. | `topic` `at_post` `page=1` `chunk=20` `max_posts=20` `format=text` |
| `cd_raw` | A thread as plain Discourse markdown — the cheapest full read. | `topic` `start_post` `end_post` |
| `cd_user` | An account profile: trust level, titles, join/last-seen/last-posted, profile views, time read, badges, location, website, bio, and profile fields such as team number. | `username` |

Listing rows and search hits carry the topic id, which is what `cd_topic` and `cd_raw` take. URLs are
`${DELPHI_BASE_URL}/t/<slug>/<id>`.

## Compliance is structural, not advisory

`src/discourse.js` fetches `robots.txt`, parses it per the RFC 9309 grouping rules, and checks every
outgoing request against the longest matching rule for this client. A disallowed path throws
`RobotsBlockedError` and never leaves the process. On Chief Delphi that currently blocks `/search*`,
`/admin*`, `/session*`, `/my*`, `/email*`, `/badges`, `/g`, `/tag/*/l`, `/c/*.rss` and `/t/*/*.rss`,
plus anything else the site adds later.

Consequences worth knowing before you file a "search is broken" issue:

- **`cd_find` is not a full-text index.** It ranks topics inside a listing window. A miss means *"not in
  this window"*, not *"the forum has no such thread"*, and the tool output says exactly that in its header.
  Widen with `pages=` (each page is ~30 topics, 40 max), narrow with `category=`, or switch `mode=`.
  `mode=auto` — the default — merges a `top` pool (most engaged) with a `latest` pool (most recent),
  because pooling only `top` systematically misses last week's thread and pooling only `latest`
  systematically misses the decade-old classic.
- **`cd_user` cannot list a user's posts.** That needs `/search?q=user:...`, which is disallowed. It also
  cannot report post counts or likes: the anonymous `/u/<name>.json` payload does not carry them.
- **RSS is not a shortcut around this.** The feeds that would actually help are disallowed:
  `/t/<slug>/<id>.rss` and `/c/<slug>/<id>.rss` both throw `RobotsBlockedError`. The global `/latest.rss`
  and `/top.rss` are *not* forbidden by `robots.txt`, but they are strictly worse than the `/latest.json`
  and `/top.json` pages the server already uses — one anonymous feed page is ~113 KB of XML for the same 30
  topics, so nothing here reaches for them.

Being polite to the host is the other half of the same section: all requests are serialized through one
queue with a 350 ms floor (`DELPHI_MIN_INTERVAL_MS`) because Chief Delphi sits behind Cloudflare and
parallel or rapid-fire requests get challenged, and every response is cached on disk so a repeat call costs
nothing.

| Cache | Default TTL |
| --- | --- |
| topic listings (`latest` / `new` / `top`) | 10 min |
| thread bodies (`/t/`, `/raw/`) and profiles | 3 h |
| `robots.txt` | 24 h |
| category and field metadata (`/site.json`) | 6 h |

Changing this stance — adding `/search.json`, dropping the throttle, deleting the guard — is a code change
to `src/discourse.js`, not a config flag. If that is what you want, that is your call to make, but it is
made against the site's stated policy, so this project would rather not ship it.

## Using it against another Discourse forum

The server is not Chief Delphi-specific: set `DELPHI_BASE_URL` to any Discourse forum and the same six
tools read it. Check that forum's `robots.txt` first — the guard will adapt automatically and may simply
refuse the endpoints you wanted.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `DELPHI_BASE_URL` | `https://www.chiefdelphi.com` | Any Discourse forum |
| `DELPHI_MIN_INTERVAL_MS` | `350` | Raise it if you see 403 / 429 / 503 |
| `DELPHI_REQUEST_TIMEOUT_MS` | `20000` | Per request |
| `DELPHI_USER_AGENT` | `delphi-mcp/0.1 (+read-only Discourse client)` | The token `robots.txt` rules are matched against |
| `DELPHI_CACHE_DIR` | `<repo>/.cache` | Delete the directory to force a refetch; there is no cache-off switch |

## Tests

```bash
npm test
```

`test/smoke.js` spawns the real server, speaks stdio to it over the official client, and runs 20
assertions against the live forum: every tool, the pagination contract, unknown-category / unknown-topic /
unknown-user error paths, the `max_chars` budget, and four assertions dedicated to the guard —
`/search.json` blocked, `/admin/logs.json` blocked, `/c/technical/9.rss` blocked, and a **control** proving
`/latest.json` still passes. An assertion that only shows blocking works is not evidence; the guard has to
be shown not to block everything. Cold run ~21 s, warm run ~3.5 s.

## Upstream facts worth knowing before you patch this

Verified against the live site, and the reason several first drafts of these tools were wrong:

- In a Discourse topic URL, `/t/<id>/<n>.json`, **`<n>` is a post number, not a page**. The returned window
  starts five posts *before* the anchor, so `cd_topic` asks for `at_post + 5` to land where you meant.
- `?page=` on `/t/<id>/posts.json` does nothing for anonymous requests.
- A window is padded to `chunk_size` *live* posts, so in a thread containing deleted posts consecutive
  `page=` requests can repeat one boundary post. `at_post` is the gap-safe way to continue, and that is what
  the "next window" hint in the output emits.
- `/u/<name>.json` wraps the profile in a `user` key, and numbered `user_fields` only become human-readable
  ("FRC Team Number") via `user_fields` in `/site.json`.
- `/c/<slug>.json` 301s; the canonical path is `/c/<slug>/<id>.json`, and category-scoped feeds live under
  `/c/<slug>/<id>/l/<feed>.json`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `ERROR RobotsBlockedError` | You asked for a path the site disallows. Not a bug to fix by editing the guard — pick an allowed endpoint. |
| `HTTP 403` / `503` from Cloudflare | Too fast. Raise `DELPHI_MIN_INTERVAL_MS`, or wait; results are cached so a retry is cheap. |
| `cd_find` finds nothing | The window is too small. `pages=`, `category=`, `mode=latest`. |
| Tools missing in the client | Host has not loaded the connector: `/mcp reload` or restart. |
| Stale tool description after an edit | Same — hosts cache `tools/list`. |
| Client reports a stdio initialization timeout | This server does no network I/O at startup, so check the `command` path resolves; on Windows use an absolute one. |

## Disclaimer

Not affiliated with FIRST or Chief Delphi. Forum posts are user-generated content owned by their authors;
this server retrieves it for you and does not redistribute it. Whatever you build on top of it — summaries,
published research, scraped corpora — is yours to keep within Chief Delphi's terms and that content's
rights.

## License

MIT — see [LICENSE](LICENSE).
