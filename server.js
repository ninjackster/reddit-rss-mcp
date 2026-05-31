#!/usr/bin/env node
/*
 * reddit-rss-mcp — a tiny, dependency-free MCP server that reads Reddit's
 * still-open RSS feeds (search + subreddit browse).
 *
 * Why this exists: as of mid-2026 Reddit blocks anonymous access to its JSON
 * API at the network-security layer (403 from residential IPs, VPNs, and even
 * commercial residential-proxy scrapers). RSS feeds (.rss) remain open and
 * return 200. This server uses ONLY those feeds — no Reddit credentials, no
 * API key, works from a blocked IP.
 *
 * Tradeoffs vs. the JSON API: no nested comment trees, no upvote scores, no
 * user-karma analysis, ~25 results/call. Covers search + browse, which is the
 * primary use case.
 *
 * Protocol: minimal JSON-RPC 2.0 over stdio (initialize / tools/list /
 * tools/call). No SDK dependency.
 */

'use strict';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const SERVER_INFO = { name: 'reddit-rss', version: '1.0.0' };

// ---------- helpers ----------

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(
    decodeEntities(html || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function tag(block, name) {
  // matches <name ...>inner</name> (first occurrence)
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function attr(block, name, a) {
  const re = new RegExp(`<${name}[^>]*\\b${a}="([^"]*)"`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function parseAtom(xml, limit) {
  const entries = [];
  const re = /<entry\b[\s\S]*?<\/entry>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const e = m[0];
    const contentHtml = tag(e, 'content');
    const item = {
      title: decodeEntities(stripTags(tag(e, 'title'))),
      author: decodeEntities(stripTags(tag(e, 'author') ? tag(tag(e, 'author'), 'name') : '')),
      link: attr(e, 'link', 'href'),
      published: stripTags(tag(e, 'published') || tag(e, 'updated')),
      id: stripTags(tag(e, 'id')),
      subreddit: decodeEntities(stripTags(tag(e, 'category') ? attr(e, 'category', 'label') : '')),
      excerpt: stripTags(contentHtml).slice(0, 500),
    };
    entries.push(item);
    if (entries.length >= limit) break;
  }
  return entries;
}

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/atom+xml, application/xml, text/xml' },
  });
  if (!res.ok) {
    throw new Error(`Reddit RSS returned HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

function clampLimit(n) {
  n = parseInt(n, 10);
  if (!Number.isFinite(n) || n < 1) return 25;
  return Math.min(n, 25); // RSS caps around 25
}

function sanitizeSub(s) {
  return String(s || '').replace(/^\/?r\//i, '').replace(/[^A-Za-z0-9_+]/g, '');
}

// ---------- tools ----------

async function browseSubreddit(args) {
  const sub = sanitizeSub(args.subreddit);
  if (!sub) throw new Error('subreddit is required');
  const sort = ['hot', 'new', 'top', 'rising', 'controversial'].includes(args.sort) ? args.sort : 'hot';
  const limit = clampLimit(args.limit);
  const params = new URLSearchParams({ limit: String(limit) });
  if ((sort === 'top' || sort === 'controversial') && args.time) params.set('t', args.time);
  const url = `https://www.reddit.com/r/${sub}/${sort}.rss?${params}`;
  const items = parseAtom(await fetchFeed(url), limit);
  return { source: url, count: items.length, posts: items };
}

async function searchReddit(args) {
  const q = String(args.query || '').trim();
  if (!q) throw new Error('query is required');
  const sort = ['relevance', 'hot', 'top', 'new', 'comments'].includes(args.sort) ? args.sort : 'relevance';
  const limit = clampLimit(args.limit);
  const sub = sanitizeSub(args.subreddit);
  const params = new URLSearchParams({ q, sort, limit: String(limit) });
  if (args.time) params.set('t', args.time);
  let url;
  if (sub) {
    params.set('restrict_sr', '1');
    url = `https://www.reddit.com/r/${sub}/search.rss?${params}`;
  } else {
    url = `https://www.reddit.com/search.rss?${params}`;
  }
  const items = parseAtom(await fetchFeed(url), limit);
  return { source: url, query: q, count: items.length, posts: items };
}

function normalizePostUrl(u) {
  u = String(u || '').trim();
  if (!u) throw new Error('url is required (a Reddit post permalink)');
  if (!/^https?:\/\//i.test(u)) {
    u = 'https://www.reddit.com' + (u.startsWith('/') ? '' : '/') + u;
  }
  u = u.split('#')[0].split('?')[0];
  if (u.endsWith('.rss')) return u;
  if (!u.endsWith('/')) u += '/';
  return u + '.rss';
}

async function getPostComments(args) {
  const url = normalizePostUrl(args.url);
  const limit = clampLimit(args.limit);
  const entries = parseAtom(await fetchFeed(url), limit + 1);
  let post = null;
  const comments = [];
  for (const e of entries) {
    const isPost = /submitted by/i.test(e.excerpt) && /\[link\]/i.test(e.excerpt);
    if (isPost && !post) {
      post = { title: e.title, author: e.author, link: e.link, published: e.published };
      continue;
    }
    comments.push({ author: e.author, text: e.excerpt, link: e.link, published: e.published });
  }
  return {
    source: url,
    post,
    count: comments.length,
    comments: comments.slice(0, limit),
    note: 'RSS comments: flat list (not threaded), no scores, ~25 max. Use the full API (OAuth) for nested trees + scores.',
  };
}

const TOOLS = [
  {
    name: 'search_reddit',
    description:
      'Search Reddit posts via RSS (no API key). Optionally restrict to one subreddit. ' +
      'Returns title, author, link, subreddit, date, and a text excerpt. ~25 results max. ' +
      'No comment trees or scores (RSS limitation).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        subreddit: { type: 'string', description: 'Optional: restrict search to this subreddit (without r/)' },
        sort: { type: 'string', enum: ['relevance', 'hot', 'top', 'new', 'comments'], default: 'relevance' },
        time: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year', 'all'], description: 'Time window (for top/relevance)' },
        limit: { type: 'number', description: 'Max results (1-25, default 25)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browse_subreddit',
    description:
      'Fetch posts from a subreddit via RSS (no API key). Returns title, author, link, date, excerpt. ' +
      '~25 results max. No scores or comment trees (RSS limitation). Use "all" or "popular" for cross-Reddit feeds.',
    inputSchema: {
      type: 'object',
      properties: {
        subreddit: { type: 'string', description: 'Subreddit name without r/ (e.g. "technology", "all")' },
        sort: { type: 'string', enum: ['hot', 'new', 'top', 'rising', 'controversial'], default: 'hot' },
        time: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year', 'all'], description: 'Time window (for top/controversial)' },
        limit: { type: 'number', description: 'Max results (1-25, default 25)' },
      },
      required: ['subreddit'],
    },
  },
  {
    name: 'get_post_comments',
    description:
      'Read the user comments on a Reddit post via RSS (no API key). Pass the post URL/permalink. ' +
      'Returns the post plus a FLAT list of comments (author + text). Limitations: not threaded ' +
      '(no parent/child nesting), no upvote scores, ~25 comments max. For full nested trees + scores, use OAuth.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Reddit post URL or permalink (e.g. https://www.reddit.com/r/technology/comments/abc123/title/)' },
        limit: { type: 'number', description: 'Max comments (1-25, default 25)' },
      },
      required: ['url'],
    },
  },
];

async function dispatch(name, args) {
  if (name === 'search_reddit') return searchReddit(args || {});
  if (name === 'browse_subreddit') return browseSubreddit(args || {});
  if (name === 'get_post_comments') return getPostComments(args || {});
  throw new Error(`Unknown tool: ${name}`);
}

// ---------- JSON-RPC over stdio ----------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyErr(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === 'notifications/initialized' || (method && method.startsWith('notifications/'))) {
    return; // no response to notifications
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const data = await dispatch(name, args);
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      });
    } catch (err) {
      reply(id, {
        isError: true,
        content: [{ type: 'text', text: `Error: ${err.message}` }],
      });
    }
    return;
  }
  if (id !== undefined && id !== null) {
    replyErr(id, -32601, `Method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg).catch((e) => process.stderr.write(`handler error: ${e}\n`));
  }
});
process.stdin.on('end', () => process.exit(0));

process.stderr.write(`reddit-rss MCP server started (${SERVER_INFO.version})\n`);
