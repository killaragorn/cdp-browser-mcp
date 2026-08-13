# cdp-browser-mcp

MCP server that **attaches to an already-running Chromium browser** over the Chrome DevTools Protocol (CDP). It does not launch a browser. One process can hold many sessions, so an agent can drive several profiles at once.

Works with:

- Chrome / Edge started with `--remote-debugging-port=9222`
- Fingerprint browsers (AdsPower, BitBrowser, GoLogin, Multilogin, …)
- Cloud or local CDP endpoints (`http://127.0.0.1:9222`, `ws://…`)

Uses [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (`connectOverCDP`) so the attached context is less likely to be patched by anti-bot checks than stock Playwright.

## Install

Requires **Node.js 18+**. No Chromium download is needed; you connect to a browser that is already open.

### Cursor

Add to `~/.cursor/mcp.json` (or project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "cdp-browser": {
      "command": "npx",
      "args": ["-y", "cdp-browser-mcp"]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "cdp-browser": {
      "command": "npx",
      "args": ["-y", "cdp-browser-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add cdp-browser -- npx -y cdp-browser-mcp
```

## Typical flow

1. Start a browser with CDP, for example:

```bash
chrome --remote-debugging-port=9222
```

Or copy the debug URL from AdsPower / BitBrowser (often `http://127.0.0.1:xxxx`).

2. Ask the agent to connect, then operate the page:

- `cdp_connect` → `{ "cdp_url": "http://127.0.0.1:9222" }` → `session_id`
- `cdp_navigate` / `cdp_click` / `cdp_type` / `cdp_screenshot` / …
- `cdp_close` when finished

## Tools

| Tool | Purpose |
| --- | --- |
| `cdp_connect` | Attach to a CDP HTTP or WebSocket URL; returns `session_id` |
| `cdp_navigate` | Open a URL |
| `cdp_screenshot` | PNG screenshot (image content) |
| `cdp_click` | Click a CSS selector or `(x, y)` |
| `cdp_type` | Type into a selector |
| `cdp_evaluate` | Run JavaScript in the page |
| `cdp_wait` | Wait for a selector or a timeout |
| `cdp_set_cookies` | Write cookies on the context |
| `cdp_page_info` | URL, title, frames |
| `cdp_list_sessions` | List active sessions |
| `cdp_close` | Disconnect one session |

## Why this exists

`@playwright/mcp` launches (or binds) a single browser from CLI flags. This server is the opposite shape:

- **Connect is a tool**, not a startup flag — the agent picks the CDP URL at runtime
- **Many sessions** in one MCP process (one AdsPower profile per `session_id`)
- **Patchright** instead of Playwright, aimed at already-fingerprinted browsers

## License

MIT
