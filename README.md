# delphi-mcp

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent read
[Chief Delphi](https://www.chiefdelphi.com) — the discussion forum of the FIRST Robotics Competition,
running on Discourse.

No account, no API key, no write access. The server speaks the anonymous read endpoints a browser already
uses, and it enforces the site's `robots.txt` in code rather than in a comment.

```
cd_categories  →  cd_find / cd_topics  →  cd_raw / cd_topic  →  cd_user
   scope it          find the thread        read the thread      vet the claim

cd_watch  →  what changed in a listing since you last looked
```

The npm package name is **`chief-delphi-mcp`**. `delphi-mcp` was already taken on npm by an unrelated
project (a multi-model consensus tool), so the repository keeps the short name while the package does not.

## Why this exists

Chief Delphi is where FRC teams post game rumors, strategy, code and CAD releases, and event discussion.
An agent asked to research one of those needs a way into the forum, and the obvious answer — the Discourse
`/search.json` endpoint — is explicitly disallowed for crawlers by Chief Delphi's `robots.txt`. This server
is the attempt at getting useful recall *without* that endpoint. See
[Compliance](#compliance-is-structural-not-advisory).

## Requirements

- Node.js 18 or newer to run the server (global `fetch`; developed and tested on Node 24)
- Node.js 21 or newer for `npm test`, which passes a glob to `node --test`
- No build step — plain ESM JavaScript

## Install

From npm:

```bash
npm install -g chief-delphi-mcp
```

From the repository:

```bash
git clone https://github.com/CaryWang1234/delphi-mcp.git
cd delphi-mcp
npm install
```

## Connect it to your MCP client

All clients take the same stdio entry; only the config file differs.

If you installed globally, the package provides a `chief-delphi-mcp` command:

```json
{
  "mcpServers": {
    "chief-delphi": { "command": "chief-delphi-mcp" }
  }
}
```

Otherwise point `args` at the absolute path of `src/index.js`:

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
| `cd_watch` | What changed in one listing since the previous `cd_watch` on the same scope: new topics, plus per-topic `+N posts (from→to)` and view deltas. First call only records a baseline. | `mode=latest` `category` `period=daily` `limit=25` `reset` |

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
nothing. The one exception is `cd_watch`, which reads the listing uncached on purpose — a stale snapshot
would defeat the tool — so each watch call is exactly one request, and repeated watching is what the
throttle is there to keep cheap.

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

The server is not Chief Delphi-specific: set `DELPHI_BASE_URL` to any Discourse forum and the same seven
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

| `DELPHI_CACHE_DIR` | `<repo>/.cache` | Delete the directory to force a refetch; there is no cache-off switch |
| `DELPHI_STATE_DIR` | `<repo>/.state` | `cd_watch` baselines. Kept out of the cache on purpose: clearing a cache should not silently erase what you are watching |

## Tests

```bash
npm test          # 52 offline assertions, no network
npm run test:live # 27 assertions against the live forum
npm run test:all  # both
```

**`npm test` is the offline one and belongs in CI.** `test/unit/*.test.js` covers the logic that can be
proven without touching chiefdelphi.com — `robots.txt` group parsing and longest-match decisions, listing URL
construction, the post-window anchor arithmetic, `/raw` post splitting, HTML-to-text, ranking weights, the
`max_chars` budget, and the watch diff. Fixtures are hand-written synthetic payloads: this repo does not
commit scraped forum text or user data, and it never should, since posts belong to the people who wrote them.

**`npm run test:live` is deliberately not wired into CI.** It spawns the server over stdio and hits the real
site, and a scheduled job doing that turns this project into a periodic crawler against a third-party forum —
plus it goes red on any network blip. Run it by hand after touching the request layer. It checks every tool,
error paths, the `max_chars` budget, and the guard: `/search.json`, `/admin/logs.json` and
`/c/technical/9.rss` blocked, with a **control** proving `/latest.json` still passes. Blocking alone is not
evidence; the guard has to be shown not to block everything.

Two habits worth copying if you extend the suite:

- **Assert mechanism, not forum state.** An earlier version asserted that a specific game-prediction thread
  would appear in `cd_find`'s default pool. It passed in October and went red once that thread left the
  yearly-top window — the test was measuring the forum, not the code. It now asserts that the auto pool
  really merged `top` and `latest`, that hits come back in descending score order, and that the output
  carries its own coverage disclaimer.
- **Create the condition instead of waiting for it.** The watch delta is proven by rewriting the stored
  baseline to claim fewer posts, then checking the reported `from→to` pair against it. That works whether or
  not anybody posted in the meantime.

Cold live run ~40 s; warm ~4 s.

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

## Publishing

Only maintainers need this. `files` in `package.json` limits the tarball to `src`, `README.md` and `LICENSE`,
so neither fixtures nor cached forum data can ship by accident.

```bash
npm pack --dry-run          # confirm what lands in the tarball
npm publish                 # 2FA is enforced for publish
npm view chief-delphi-mcp version dist-tags.latest
```

Two things worth knowing before your first release, both learned the hard way:

- **A brand-new package goes through staged publishing.** npm now queues the first release of a name that
  does not exist yet: the publish call lands a public placeholder version `0.0.0-stage` (`"stub": true`,
  "Temporary package placeholder for staged publishing") and holds the real version for maintainer approval.
  Approve it on npmjs.com under **Staged Packages**, or from the CLI with `npm stage list` / `npm stage view`
  / `npm stage approve` — which needs npm ≥ 11.15.0 and Node ≥ 22.14; approval always asks for 2FA even if
  staging did not. Until you approve, `latest` points at the stub and `npm install` hands people an inert
  two-file placeholder, so verify `dist-tags.latest` after approving rather than assuming success. Rejecting
  the staged version leaves that stub published, so clear it instead of leaving it dangling.
- **Plain `npm publish` fails with 403 on a 2FA account** (`Two-factor authentication or granular access
  token with bypass 2fa enabled is required`). Either pass a one-time code — `npm publish --otp=123456` — or
  use a granular access token scoped to this package with 2FA bypass, injected as `npm_config_token` for the
  single command. Never commit a token, and prefer the one-time code when publishing by hand.

The release is only real once the *published artifact* runs. Install it somewhere clean and speak MCP to it,
because this proves the tarball is self-contained in a way a working local checkout cannot:

```bash
mkdir /tmp/verify && npm install chief-delphi-mcp --prefix /tmp/verify --no-save
node /tmp/verify/node_modules/chief-delphi-mcp/src/index.js   # should wait on stdio, not crash on import
```

`publishConfig.access` is already `public`, so the publish command does not need the flag. If your npm
account has two-factor auth, publish needs an automation or a one-time password from your authenticator.

## Disclaimer

Not affiliated with FIRST or Chief Delphi. Forum posts are user-generated content owned by their authors;
this server retrieves it for you and does not redistribute it. Whatever you build on top of it — summaries,
published research, scraped corpora — is yours to keep within Chief Delphi's terms and that content's
rights.

## License

MIT — see [LICENSE](LICENSE).
