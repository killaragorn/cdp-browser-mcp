#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "patchright";

const NAME = "cdp-browser-mcp";
const VERSION = "1.0.0";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    `${NAME} ${VERSION}\n` +
      "MCP stdio server — attach to existing Chromium browsers over CDP.\n" +
      "Configure with: npx -y github:killaragorn/cdp-browser-mcp\n"
  );
  process.exit(0);
}

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// ── session store ──────────────────────────────────────────────
const sessions = new Map();
let seq = 0;

function getSession(id) {
  const s = sessions.get(id);
  if (!s) throw new Error(`session "${id}" not found`);
  return s;
}

// ── tool definitions ───────────────────────────────────────────
const TOOLS = [
  {
    name: "cdp_connect",
    description:
      "Attach to an already-running Chromium browser via CDP (does not launch a browser). Accepts HTTP (http://127.0.0.1:9222) or WebSocket URLs. Works with Chrome/Edge --remote-debugging-port, AdsPower, BitBrowser, GoLogin, and cloud CDP endpoints. Returns session_id for later tools.",
    inputSchema: {
      type: "object",
      properties: {
        cdp_url: {
          type: "string",
          description:
            'CDP WebSocket or HTTP URL, e.g. "ws://127.0.0.1:9222" or "http://127.0.0.1:9222"',
        },
      },
      required: ["cdp_url"],
    },
  },
  {
    name: "cdp_navigate",
    description: "Navigate the session's current page to a URL.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        url: { type: "string" },
        wait_until: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle", "commit"],
          default: "domcontentloaded",
        },
      },
      required: ["session_id", "url"],
    },
  },
  {
    name: "cdp_screenshot",
    description: "Capture the current page as a PNG screenshot (returned as image content).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        full_page: { type: "boolean", default: false },
      },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_set_cookies",
    description: "Write cookies onto the browser context of this session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        cookies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: "string" },
              domain: { type: "string" },
              path: { type: "string", default: "/" },
              httpOnly: { type: "boolean" },
              secure: { type: "boolean" },
            },
            required: ["name", "value", "domain"],
          },
        },
      },
      required: ["session_id", "cookies"],
    },
  },
  {
    name: "cdp_click",
    description: "Click an element by CSS selector, or click at page coordinates (x, y).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_type",
    description: "Type text into the element matched by CSS selector. Clears the field first unless clear=false.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        clear: {
          type: "boolean",
          default: true,
          description: "Clear existing value before typing",
        },
      },
      required: ["session_id", "selector", "text"],
    },
  },
  {
    name: "cdp_evaluate",
    description: "Run a JavaScript expression in the page and return the JSON-serializable result.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        expression: { type: "string" },
      },
      required: ["session_id", "expression"],
    },
  },
  {
    name: "cdp_page_info",
    description: "Return the current page URL, title, and frame URLs.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_wait",
    description: "Wait until a CSS selector appears, or wait a fixed timeout in milliseconds if no selector is given.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        selector: { type: "string" },
        timeout: { type: "number", default: 30000 },
      },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_list_sessions",
    description: "List all active CDP sessions in this MCP process.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cdp_close",
    description: "Disconnect this session from the browser and drop it from the session list.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
];

// ── tool handlers ──────────────────────────────────────────────
async function handleTool(name, args) {
  switch (name) {
    case "cdp_connect": {
      let url = args.cdp_url;
      if (url.startsWith("http://") || url.startsWith("https://")) {
        const resp = await fetch(`${url}/json/version`);
        const info = await resp.json();
        url = info.webSocketDebuggerUrl;
      }
      const browser = await chromium.connectOverCDP(url);
      const contexts = browser.contexts();
      const context = contexts[0] || (await browser.newContext());
      const pages = context.pages();
      const page = pages[0] || (await context.newPage());
      const id = `s${++seq}`;
      sessions.set(id, { browser, context, page, cdp: args.cdp_url });
      return {
        session_id: id,
        url: page.url(),
        title: await page.title(),
        pages: pages.length,
      };
    }

    case "cdp_navigate": {
      const s = getSession(args.session_id);
      const waitUntil = args.wait_until || "domcontentloaded";
      await s.page.goto(args.url, { waitUntil, timeout: 60000 });
      return { url: s.page.url(), title: await s.page.title() };
    }

    case "cdp_screenshot": {
      const s = getSession(args.session_id);
      const buf = await s.page.screenshot({
        fullPage: args.full_page || false,
        timeout: 15000,
      });
      return {
        _image: true,
        base64: buf.toString("base64"),
        mimeType: "image/png",
      };
    }

    case "cdp_set_cookies": {
      const s = getSession(args.session_id);
      const cookies = args.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? true,
      }));
      await s.context.addCookies(cookies);
      return { set: cookies.length };
    }

    case "cdp_click": {
      const s = getSession(args.session_id);
      if (args.selector) {
        await s.page.click(args.selector, { timeout: 10000 });
      } else if (args.x != null && args.y != null) {
        await s.page.mouse.click(args.x, args.y);
      } else {
        throw new Error("provide selector or (x, y)");
      }
      return { clicked: args.selector || `(${args.x},${args.y})` };
    }

    case "cdp_type": {
      const s = getSession(args.session_id);
      if (args.clear !== false) {
        await s.page.fill(args.selector, args.text, { timeout: 10000 });
      } else {
        await s.page.locator(args.selector).pressSequentially(args.text);
      }
      return { typed: args.text.length };
    }

    case "cdp_evaluate": {
      const s = getSession(args.session_id);
      const result = await s.page.evaluate(args.expression);
      return { result };
    }

    case "cdp_page_info": {
      const s = getSession(args.session_id);
      const frames = s.page.frames().map((f) => f.url());
      return { url: s.page.url(), title: await s.page.title(), frames };
    }

    case "cdp_wait": {
      const s = getSession(args.session_id);
      const timeout = args.timeout || 30000;
      if (args.selector) {
        await s.page.waitForSelector(args.selector, { timeout });
        return { found: args.selector };
      }
      await s.page.waitForTimeout(timeout);
      return { waited: timeout };
    }

    case "cdp_list_sessions": {
      const list = [];
      for (const [id, s] of sessions) {
        list.push({ session_id: id, cdp: s.cdp, url: s.page.url() });
      }
      return { sessions: list };
    }

    case "cdp_close": {
      const s = getSession(args.session_id);
      try {
        await s.browser.close();
      } catch {}
      sessions.delete(args.session_id);
      return { closed: args.session_id };
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── MCP server ─────────────────────────────────────────────────
const server = new Server(
  { name: NAME, version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await handleTool(name, args || {});
    if (result._image) {
      return {
        content: [
          {
            type: "image",
            data: result.base64,
            mimeType: result.mimeType,
          },
        ],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `ERROR: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
