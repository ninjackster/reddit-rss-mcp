# reddit-rss-mcp

A tiny, **dependency-free** [MCP](https://modelcontextprotocol.io) server that reads Reddit through its still-open **RSS feeds**. No API key, no OAuth, no scraping service.

## Why this exists

As of 2025–2026, Reddit blocks anonymous access to its JSON API at the network-security layer. A plain request to `www.reddit.com/r/.../hot.json` returns a **403 "blocked by network security"** page — and this happens from residential IPs, VPNs, and even commercial residential-proxy scrapers. Self-service API key creation also ended (Responsible Builder Policy, pre-approval now required).

But Reddit's **RSS feeds and search RSS still return 200**. This server uses only those, so it works with zero credentials, even from a blocked IP.

## Tools

| Tool | What it does |
|------|--------------|
| `search_reddit` | Search posts (globally or within one subreddit). |
| `browse_subreddit` | Fetch a subreddit's posts (hot/new/top/rising/controversial). |
| `get_post_comments` | Read the user comments on a post (flat list). |

Each returns clean JSON: title, author, link, subreddit, date, and a text excerpt.

## Install

Requires Node.js 18+ (uses the built-in `fetch`). No `npm install` needed.

### Claude Desktop / Claude Code

Add to your MCP config (`claude_desktop_config.json`, or `~/.claude/settings.json` for Claude Code).

Run directly from GitHub (no install step):

```json
{
  "mcpServers": {
    "reddit-rss": {
      "command": "npx",
      "args": ["-y", "github:ninjackster/reddit-rss-mcp"]
    }
  }
}
```

Or run from a local clone:

```json
{
  "mcpServers": {
    "reddit-rss": {
      "command": "node",
      "args": ["/absolute/path/to/reddit-rss-mcp/server.js"]
    }
  }
}
```

Restart the app (quit fully, then relaunch) to load the server.

## Usage examples

> Search r/technology for "local LLM" sorted by new.

> Show me the hot posts in r/selfhosted.

> Read the comments on this post: https://www.reddit.com/r/technology/comments/abc123/title/

## Limitations (RSS, not the API)

- **Comments are flat** — no parent/child threading.
- **No scores** — RSS carries no upvote/downvote counts.
- **~25 results per call** — RSS feed cap.

For nested comment trees, scores, and unlimited depth you need Reddit's authenticated API (an approved OAuth app). This server is the no-credentials option that covers search, browse, and comment reading.

## How it works

It maps tool calls to Reddit RSS endpoints:

- Browse: `https://www.reddit.com/r/<sub>/<sort>.rss`
- Search: `https://www.reddit.com/search.rss?q=<q>` (add `restrict_sr=1` for a single subreddit via `/r/<sub>/search.rss`)
- Comments: `<post-permalink>.rss`

It parses the Atom XML with no external dependencies and speaks MCP over stdio (JSON-RPC 2.0).

## License

MIT
