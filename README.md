# cdp-browser-mcp

MCP server that **attaches to an already-running Chromium browser** over the Chrome DevTools Protocol (CDP). It does not launch a browser. One process can hold many sessions, so an agent can drive several profiles at once.

Works with:

- Chrome / Edge started with `--remote-debugging-port=9222`
- Fingerprint browsers (AdsPower, BitBrowser, GoLogin, Multilogin, …)
- Cloud or local CDP endpoints (`http://127.0.0.1:9222`, `ws://…`)

Uses [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (`connectOverCDP`) so the attached context is less likely to be patched by anti-bot checks than stock Playwright.

Install from GitHub (no npm publish). Requires **Node.js 18+**. No Chromium download is needed.

```text
npx -y github:killaragorn/cdp-browser-mcp
```

## Cursor

Add to `~/.cursor/mcp.json` (or project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "cdp-browser-mcp": {
      "command": "npx",
      "args": ["-y", "github:killaragorn/cdp-browser-mcp"]
    }
  }
}
```

## Claude Desktop

Add to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "cdp-browser-mcp": {
      "command": "npx",
      "args": ["-y", "github:killaragorn/cdp-browser-mcp"]
    }
  }
}
```

## Claude Code

```bash
claude mcp add --scope user cdp-browser-mcp -- npx -y github:killaragorn/cdp-browser-mcp
```

Or commit `.mcp.json` in a project so teammates get the same server:

```json
{
  "mcpServers": {
    "cdp-browser-mcp": {
      "command": "npx",
      "args": ["-y", "github:killaragorn/cdp-browser-mcp"]
    }
  }
}
```

## Codex

```bash
codex mcp add cdp-browser-mcp -- npx -y github:killaragorn/cdp-browser-mcp
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.cdp-browser-mcp]
command = "npx"
args = ["-y", "github:killaragorn/cdp-browser-mcp"]
```

## Local clone

```bash
git clone https://github.com/killaragorn/cdp-browser-mcp.git
cd cdp-browser-mcp
npm install
```

Then point the client at `node /absolute/path/to/cdp-browser-mcp/index.mjs`.

## Typical flow

1. Start a browser with CDP, for example:

```bash
chrome --remote-debugging-port=9222
```

Or copy the debug URL from AdsPower / BitBrowser (often `http://127.0.0.1:xxxx`).

2. Ask the agent to connect, then operate the page:

- `cdp_connect` → `{ "cdp_url": "http://127.0.0.1:9222" }` → `session_id`
- `cdp_type` with `mode=fill|type|insert`, or `cdp_press` for `Enter` / `Control+A`
- `cdp_network_log` / `cdp_wait_response` for captured traffic
- `cdp_close` when finished

## Tools

Connect first with `cdp_connect` (network capture starts automatically), then pass `session_id` to the rest.

**Session / navigation**

| Tool | Purpose |
| --- | --- |
| `cdp_connect` | Attach to a CDP HTTP or WebSocket URL; returns `session_id` |
| `cdp_navigate` | Open a URL |
| `cdp_reload` | Reload |
| `cdp_go_back` | History back |
| `cdp_page_info` | URL, title, frames |
| `cdp_content` | Page HTML or a selector's innerHTML |
| `cdp_screenshot` | PNG screenshot |
| `cdp_list_sessions` | List active sessions |
| `cdp_close` | Disconnect one session |

**Input**

| Tool | Purpose |
| --- | --- |
| `cdp_click` | Click selector or `(x, y)`; `button`, `click_count`, `modifiers` |
| `cdp_hover` | Hover a selector |
| `cdp_mouse_move` | Move mouse to coordinates |
| `cdp_type` | Input text: `mode=fill` / `type` (key events) / `insert` (paste-like); optional `press_enter` |
| `cdp_press` | Key or shortcut: `Enter`, `Tab`, `Control+A` |
| `cdp_select` | `<select>` by value / label / index |
| `cdp_check` | Check or uncheck |
| `cdp_upload` | File input (`files` are local paths on the MCP host) |
| `cdp_scroll` | Into view, mouse wheel, or `scrollTo` |
| `cdp_evaluate` | Run JavaScript |
| `cdp_wait` | Wait for a selector or a timeout |

**Network**

| Tool | Purpose |
| --- | --- |
| `cdp_network_log` | List captured requests; filter with `url_contains` / `method` / `status`; `include_body` for xhr/fetch/JSON |
| `cdp_network_clear` | Clear the buffer (last 400 requests kept) |
| `cdp_wait_response` | Wait for a response whose URL contains a string |

**Cookies**

| Tool | Purpose |
| --- | --- |
| `cdp_get_cookies` | Read cookies |
| `cdp_set_cookies` | Write cookies |

## Why this exists

`@playwright/mcp` launches (or binds) a single browser from CLI flags. This server is the opposite shape:

- **Connect is a tool**, not a startup flag — the agent picks the CDP URL at runtime
- **Many sessions** in one MCP process (one AdsPower profile per `session_id`)
- **Patchright** instead of Playwright, aimed at already-fingerprinted browsers

## License

MIT
