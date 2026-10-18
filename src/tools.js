import { getJson, getText, topicUrl, BASE_URL, CACHE_TTL } from './discourse.js';

const DEFAULT_MAX_CHARS = 20000;

function clip(text, max = DEFAULT_MAX_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated at ${max} of ${text.length} chars — raise max_chars, narrow the post range, or page again]`;
}

function htmlToText(html) {
  let out = html;
  out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => `\n\`\`\`\n${inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')}\n\`\`\`\n`);
  out = out.replace(/<(blockquote|div|p|li|ul|ol|h[1-6]|tr|br|\/blockquote|\/div)[^>]*>/gi, '\n');
  out = out.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
    const text = label.replace(/<[^>]+>/g, '').trim();
    const resolved = href.startsWith('/') ? `${BASE_URL}${href}` : href;
    if (!text || text === resolved) return resolved;
    return `${text} <${resolved}>`;
  });
  out = out.replace(/<img[^>]*>/gi, (m) => {
    const src = /src="([^"]*)"/i.exec(m)?.[1] ?? '';
    return src ? `[image: ${src.startsWith('http') ? src : `${BASE_URL}${src}`}]` : '[image]';
  });
  out = out.replace(/<[^>]+>/g, '');
  out = decodeEntities(out);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•', trade: '™' };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

function parseRef(ref) {
  const value = String(ref ?? '').trim();
  if (!value) return null;
  return { id: /^\d+$/.test(value) ? Number(value) : null, slug: value.toLowerCase().replace(/\.json$/, '') };
}

async function userProfileFields() {
  try {
    const site = await getJson('/site.json', { ttl: CACHE_TTL.site });
    return Object.fromEntries((site.user_fields ?? []).map((f) => [String(f.id), f.name]));
  } catch {
    return {};
  }
}

async function categoryIndex() {
  const site = await getJson('/site.json', { ttl: CACHE_TTL.site });
  const raw = site.categories ?? (await getJson('/categories.json', { ttl: CACHE_TTL.site })).category_list.categories;
  const byId = new Map(raw.map((c) => [c.id, c]));
  return raw.map((c) => {
    const parent = c.parent_category_id ? byId.get(c.parent_category_id) : null;
    return {
      id: c.id,
      slug: c.slug,
      name: c.name,
      topic_count: c.topic_count ?? null,
      description: c.description ? htmlToText(c.description).slice(0, 200) : undefined,
      read_restricted: Boolean(c.read_restricted),
      parent: parent ? { id: parent.id, name: parent.name, slug: parent.slug } : undefined,
    };
  });
}

async function resolveCategory(ref) {
  const parsed = parseRef(ref);
  if (!parsed) return null;
  const all = await categoryIndex();
  const byId = parsed.id ? all.filter((c) => c.id === parsed.id) : [];
  const bySlug = all.filter((c) => c.slug === parsed.slug);
  const byName = all.filter((c) => c.name.toLowerCase() === parsed.slug);
  const hits = byId.length ? byId : bySlug.length ? bySlug : byName;
  if (!hits.length) {
    throw new Error(`No Chief Delphi category matches "${ref}". Call cd_categories to list them.`);
  }
  if (hits.length > 1) {
    throw new Error(`"${ref}" is ambiguous: ${hits.map((c) => `${c.slug} (id ${c.id})`).join(', ')}. Pass the id.`);
  }
  return hits[0];
}

function listPath({ mode, category, period, order, page }) {
  const base = category ? `/c/${category.slug}/${category.id}/l/${mode}.json` : `/${mode}.json`;
  const qs = new URLSearchParams();
  if (mode === 'top' && period) qs.set('period', period);
  if (order) qs.set('order', order);
  if (page > 0) qs.set('page', String(page));
  const query = qs.toString();
  return query ? `${base}?${query}` : base;
}

function topicRow(t) {
  const parts = [
    `#${t.id}`,
    t.title,
    `slug=${t.slug}`,
    `cat=${t.category_id}`,
    `posts=${t.posts_count}`,
    `views=${t.views ?? 0}`,
    `created=${String(t.created_at).slice(0, 10)}`,
    `last=${String(t.last_posted_at || t.created_at).slice(0, 16).replace('T', ' ')}`,
    `by=${t.last_poster_username || '?'}`,
  ];
  if (t.tags?.length) parts.push(`tags=${t.tags.join(',')}`);
  return parts.join(' | ');
}

async function fetchTopicList({ mode, category, period, order, page, ttl }) {
  const data = await getJson(listPath({ mode, category, period, order, page }), { ttl });
  return data.topic_list?.topics ?? [];
}

export async function listCategories() {
  const all = await categoryIndex();
  const top = all.filter((c) => !c.parent);
  const lines = [];
  lines.push(`Chief Delphi categories at ${BASE_URL} (${all.length} total, anonymous-readable unless marked restricted)`);
  for (const c of top) {
    lines.push(`#${c.id} ${c.name} [${c.slug}] topics=${c.topic_count ?? '?'}`);
    for (const sc of all.filter((x) => x.parent?.id === c.id)) {
      lines.push(`    #${sc.id} ${sc.name} [${sc.slug}] topics=${sc.topic_count ?? '?'}${sc.read_restricted ? ' (restricted)' : ''}`);
    }
  }
  return clip(lines.join('\n'));
}

export async function browseTopics({ mode, category, period, order, page, limit, max_chars }) {
  const cat = await resolveCategory(category);
  const topics = await fetchTopicList({ mode, category: cat, period, order, page, ttl: CACHE_TTL.list });
  const shown = topics.slice(0, limit);
  const scope = cat ? `${cat.name} [${cat.slug}]` : 'all of Chief Delphi';
  const head = [
    `${mode}${mode === 'top' ? ` (${period})` : ''}${order ? ` ordered by ${order}` : ''} topics in ${scope} — page ${page} (${shown.length} of ${topics.length} on page)`,
    cat ? `category_id=${cat.id} read_restricted=${cat.read_restricted}` : null,
    `Feed each #id to cd_topic or cd_raw. URL: ${BASE_URL}/t/<slug>/<id>`,
  ].filter(Boolean);
  const nextArgs = [`mode=${mode}`, mode === 'top' ? `period=${period}` : null, cat ? `category="${cat.slug}"` : null, `page=${page + 1}`].filter(Boolean).join(', ');
  const tail = [`Next page: cd_topics(${nextArgs})`];
  return clip([...head, ...shown.map(topicRow), ...tail].filter(Boolean).join('\n'), max_chars);
}

function tokenize(query) {
  return String(query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function countIn(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function scoreTopic(topic, tokens, phrase) {
  const fields = [
    { text: String(topic.title || '').toLowerCase(), weight: 6 },
    { text: (topic.tags || []).join(' ').toLowerCase(), weight: 4 },
    { text: `${topic.excerpt || ''} ${topic.last_post_excerpt || ''}`.toLowerCase(), weight: 1 },
  ];
  let score = 0;
  const matched = new Set();
  for (const field of fields) {
    if (phrase && field.text.includes(phrase)) score += field.weight * 3;
    for (const token of tokens) {
      const hits = countIn(field.text, token);
      if (hits) {
        score += field.weight * Math.min(hits, 3);
        matched.add(token);
      }
    }
  }
  return { score, matched };
}

function firstWindow(text, tokens, width = 180) {
  const low = text.toLowerCase();
  let best = -1;
  for (const token of tokens) {
    const at = low.indexOf(token);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  if (best === -1) return null;
  const start = Math.max(0, best - Math.floor(width / 3));
  return `…${text.slice(start, start + width).replace(/\s+/g, ' ').trim()}…`;
}

async function gatherCandidates(pools, category) {
  const cat = await resolveCategory(category);
  const seen = new Map();
  let requested = 0;
  const covered = [];
  for (const pool of pools) {
    requested += pool.pages;
    let got = 0;
    for (let page = 0; page < pool.pages; page += 1) {
      const batch = await fetchTopicList({ ...pool, category: cat, page, ttl: CACHE_TTL.list });
      if (!batch.length) break;
      got += batch.length;
      for (const t of batch) if (!seen.has(t.id)) seen.set(t.id, t);
    }
    covered.push(`${pool.mode}${pool.period ? `/${pool.period}` : ''} ${pool.pages}p→${got}`);
  }
  return { cat, topics: [...seen.values()], covered, requested };
}

function poolsFor(mode, period, pages, order) {
  if (mode !== 'auto') return [{ mode, period, order, pages }];
  const topPages = Math.max(1, Math.ceil(pages / 2));
  return [
    { mode: 'top', period, order, pages: topPages },
    { mode: 'latest', order, pages: Math.max(1, pages - topPages) },
  ];
}

// /raw separates posts with a "who | timestamp UTC | #n" header line per post.
function splitRawPosts(raw) {
  const headerRe = /^[^\n]*\|\s*\d{4}-\d{2}-\d{2}[^\n]*UTC\s*\|\s*#\d+\s*$/gm;
  const marks = [];
  let m;
  while ((m = headerRe.exec(raw)) !== null) marks.push({ index: m.index, header: m[0] });
  return marks.map((mark, i) => ({
    number: /#\d+/.exec(mark.header)?.[0] ?? '?',
    author: mark.header.split('|')[0].trim(),
    text: raw.slice(mark.index, marks[i + 1]?.index ?? raw.length),
  }));
}

export async function findTopics({ query, mode, category, period, order, pages, match, with_body, limit, max_chars }) {
  const tokens = tokenize(query);
  if (!tokens.length) throw new Error('query must contain at least one alphanumeric token');
  const phrase = tokens.length > 1 ? tokens.join(' ') : tokens[0];
  const { cat, topics, covered, requested } = await gatherCandidates(poolsFor(mode, period, pages, order), category);

  const scored = [];
  for (const topic of topics) {
    const { score, matched } = scoreTopic(topic, tokens, phrase);
    if (score <= 0) continue;
    if (match === 'all' && matched.size < tokens.length) continue;
    scored.push({ topic, score });
  }
  scored.sort((a, b) => b.score - a.score || b.topic.views - a.topic.views);

  const shortlist = scored.slice(0, with_body);
  const bodyHits = new Map();
  for (const entry of shortlist) {
    try {
      const raw = await getText(`/raw/${entry.topic.id}`, { ttl: CACHE_TTL.topic });
      const posts = splitRawPosts(raw);
      const matchedPosts = [];
      let bodyTokenHits = 0;
      for (const post of posts) {
        const low = post.text.toLowerCase();
        if (phrase && low.includes(phrase)) matchedPosts.push(`${post.number} (${post.author})`);
        else if (tokens.some((token) => low.includes(token))) matchedPosts.push(`${post.number} (${post.author})`);
      }
      bodyTokenHits = tokens.filter((token) => raw.toLowerCase().includes(token)).length;
      if (bodyTokenHits === 0) continue;
      entry.score += bodyTokenHits * 2;
      const window = firstWindow(raw, tokens);
      bodyHits.set(entry.topic.id, { posts: matchedPosts.slice(0, 8), of: posts.length, window });
    } catch (err) {
      process.stderr.write(`delphi-mcp: body scan skipped #${entry.topic.id} (${err.message})\n`);
    }
  }
  if (with_body) scored.sort((a, b) => b.score - a.score || b.topic.views - a.topic.views);

  const picked = scored.slice(0, limit);
  const scope = cat ? `${cat.name} [${cat.slug}]` : 'the whole forum';
  const lines = [
    `cd_find: "${query}" (match=${match}, pool=${mode}${mode === 'top' || mode === 'auto' ? `/${period}` : ''}) in ${scope}`,
    `Pool: ${topics.length} distinct topics from ${covered.join(', ')} (${requested} list requests). ${shortlist.length} were body-checked against /raw.`,
    `This is not a full-text index: it only covers topics inside the listing window above. No hit here does not mean the forum has no such thread — widen pages=, add category=, or try mode=latest.`,
    '',
  ];
  if (!picked.length) lines.push('No title/tag/excerpt match in that pool. Try pages=10, mode=auto, or a single broader token with match=any.');
  for (const entry of picked) {
    const t = entry.topic;
    lines.push(`#${t.id} score=${entry.score.toFixed(1)} | ${t.title}`);
    lines.push(`    slug=${t.slug} cat=${t.category_id} posts=${t.posts_count} views=${t.views ?? 0} created=${String(t.created_at).slice(0, 10)} last=${String(t.last_posted_at || t.created_at).slice(0, 10)}`);
    const hit = bodyHits.get(t.id);
    if (hit) {
      lines.push(`    body: matched in ${hit.posts.join(', ') || `none of ${hit.of} posts`}${hit.posts.length > 8 ? ' …' : ''}`);
      if (hit.window) lines.push(`    quote: ${hit.window}`);
    }
    const excerpt = firstWindow(`${t.excerpt || ''} ${t.last_post_excerpt || ''}`, tokens);
    if (excerpt) lines.push(`    list excerpt: ${excerpt}`);
    lines.push('');
  }
  lines.push(`Read a hit: cd_raw(topic=<id>) or cd_topic(topic=<id>)${picked[0] ? ` — e.g. cd_raw(topic=${picked[0].topic.id}, start_post=1, end_post=10)` : ''}`);
  return clip(lines.join('\n'), max_chars);
}

export async function readTopic({ topic, page, at_post, chunk, max_posts, format, max_chars }) {
  const first = at_post ?? 1 + (page - 1) * chunk;
  // A Discourse topic URL takes a post number, not a page. Requesting a window renders
  // chunk_size posts starting five before the anchor, so anchor = desired start + 5.
  const path = first <= 1 ? `/t/${topic}.json` : `/t/${topic}/${first + 5}.json?context=${first + 5}`;
  let data;
  try {
    data = await getJson(path, { ttl: CACHE_TTL.topic });
  } catch (err) {
    if (/HTTP 404/.test(err.message)) throw new Error(`Topic ${topic} not found (404). Check the id with cd_find or cd_topics.`);
    throw err;
  }
  const allPosts = data.post_stream?.posts ?? [];
  const stream = data.post_stream?.stream ?? [];
  const chunkSize = data.chunk_size ?? chunk;
  const posts = allPosts.slice(0, max_posts);
  const firstActual = posts[0]?.post_number ?? first;
  const lastActual = posts[posts.length - 1]?.post_number ?? firstActual;
  const render = (p) => (p.user_deleted ? '[post deleted]' : p.hidden ? '[post hidden by staff]' : htmlToText(p.cooked || ''));

  if (format === 'json') {
    const mapped = posts.map((p) => ({
      post_number: p.post_number,
      id: p.id,
      username: p.username,
      display_name: p.name,
      user_title: p.user_title || p.custom_user_title || null,
      created_at: p.created_at,
      updated_at: p.updated_at,
      reply_to_post_number: p.reply_to_post_number ?? null,
      reply_count: p.reply_count ?? 0,
      like_count: p.like_count ?? 0,
      reads: p.reads ?? null,
      wiki: Boolean(p.wiki),
      deleted: Boolean(p.user_deleted),
      hidden: Boolean(p.hidden),
      text: render(p),
    }));
    return clip(
      JSON.stringify({
        id: data.id,
        title: data.title,
        slug: data.slug,
        url: topicUrl(data.id, data.slug),
        category_id: data.category_id,
        tags: data.tags ?? [],
        created_at: data.created_at,
        last_posted_at: data.last_posted_at,
        posts_count: data.posts_count,
        views: data.views,
        like_count: data.like_count,
        window: { first_post: firstActual, last_post: lastActual, chunk_size: chunkSize, posts_returned: posts.length },
        total_posts_in_stream: stream.length,
        posts: mapped,
      }),
      max_chars
    );
  }

  const head = [
    `${data.title}`,
    `#${data.id} slug=${data.slug} cat=${data.category_id} posts=${data.posts_count} in_stream=${stream.length} views=${data.views ?? 0} likes=${data.like_count ?? 0}${data.tags?.length ? ` tags=${data.tags.join(',')}` : ''}`,
    `URL ${topicUrl(data.id, data.slug)}`,
    `window: posts ${firstActual}-${lastActual} of ${stream.length} · chunk ${chunkSize} · created ${data.created_at} · last post ${data.last_posted_at}`,
    '',
  ];
  const body = posts.map((p) => {
    const who = p.user_title ? ` (${p.user_title})` : p.name && p.name !== p.username ? ` (${p.name})` : '';
    const meta = `[#${p.post_number}] ${p.username}${who} ${String(p.created_at).slice(0, 16).replace('T', ' ')} · likes ${p.like_count ?? 0}${p.reply_to_post_number ? ` · replies #${p.reply_to_post_number}` : ''}${p.wiki ? ' · wiki' : ''} · id ${p.id}`;
    return `${meta}\n${render(p)}`;
  });
  const tail = lastActual < stream.length
    ? ['', `Stopped at post ${lastActual} of ${stream.length}. Next window: cd_topic(topic=${data.id}, at_post=${lastActual + 1})`]
    : ['', `End of thread reached (${stream.length} posts in stream).`];
  return clip([...head, ...body, ...tail].join('\n'), max_chars);
}

export async function readRaw({ topic, start_post, end_post, max_chars }) {
  let path = `/raw/${topic}`;
  if (start_post && end_post) path = `/raw/${topic}/${start_post}-${end_post}`;
  else if (start_post) path = `/raw/${topic}/${start_post}`;
  let text;
  try {
    text = await getText(path, { ttl: CACHE_TTL.topic });
  } catch (err) {
    if (/HTTP 404/.test(err.message)) throw new Error(`Topic ${topic} not found at ${path} (404). Check the id with cd_find or cd_topics.`);
    throw err;
  }
  const range = start_post ? `posts ${start_post}${end_post ? `-${end_post}` : ''}` : 'whole thread';
  return clip(`# CD topic ${topic} — ${range} (${BASE_URL}/raw/${topic})\n${text}`, max_chars);
}

export async function readUser({ username, max_chars }) {
  const name = String(username).replace(/^@/, '').trim();
  let payload;
  try {
    payload = await getJson(`/u/${encodeURIComponent(name)}.json`, { ttl: CACHE_TTL.topic });
  } catch (err) {
    if (/HTTP 404/.test(err.message)) throw new Error(`No Chief Delphi user "${name}" (404).`);
    throw err;
  }
  const data = payload.user ?? payload;
  const lines = Object.entries({
    id: data.id,
    username: data.username,
    display_name: data.name,
    title: data.title,
    trust_level: data.trust_level,
    admin: data.admin,
    moderator: data.moderator,
    joined: data.created_at,
    last_seen: data.last_seen_at,
    last_posted: data.last_posted_at,
    profile_views: data.profile_view_count,
    time_read_minutes: data.time_read,
    badges: data.badge_count,
    location: data.location,
    website: data.website,
    profile_url: `${BASE_URL}/u/${data.username}`,
  })
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${value}`);
  if (data.bio_raw) lines.push(`bio: ${String(data.bio_raw).replace(/\s+/g, ' ').slice(0, 300)}`);
  if (data.featured_topic?.title) lines.push(`featured topic: #${data.featured_topic.id ?? '?'} ${data.featured_topic.title}`);
  const fields = Object.entries(data.user_fields ?? {}).filter(([, v]) => String(v ?? '').trim());
  if (fields.length) {
    const labels = await userProfileFields();
    lines.push(`profile fields: ${fields.map(([k, v]) => `${labels[k] ?? k}=${v}`).join('; ')}`);
  }
  lines.push('');
  lines.push('cd_user returns the profile only — Chief Delphi robots.txt disallows /search, so "posts by user" has no compliant endpoint. Use cd_find or cd_topics and filter by `by=`.');
  return clip(lines.join('\n'), max_chars);
}

export const TOOL_DEFAULTS = { DEFAULT_MAX_CHARS };
