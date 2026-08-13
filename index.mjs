#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "patchright";
import {
  beginCapture,
  clipBody,
  createNetworkState,
  disableCapture,
  persistEntry,
  querySaved,
  recordFailure,
  recordRequest,
  recordResponse,
  shouldCaptureBody,
} from "./network.mjs";

const NAME = "cdp-browser-mcp";
const VERSION = "1.2.0";

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

const sessions = new Map();
let seq = 0;

function getSession(id) {
  const s = sessions.get(id);
  if (!s) throw new Error(`session "${id}" not found`);
  return s;
}

function attachNetwork(page, net) {
  page.on("request", (request) => {
    recordRequest(net, request, {
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      headers: request.headers(),
      postData: request.postData(),
    });
  });
  page.on("response", (response) => {
    const request = response.request();
    const headers = response.headers();
    const rec = recordResponse(net, request, {
      status: response.status(),
      headers,
    });
    if (!rec) return;
    const finish = async () => {
      const contentType = headers["content-type"] || headers["Content-Type"] || "";
      if (shouldCaptureBody(request.resourceType(), contentType)) {
        try {
          rec.body = await response.text();
          rec.bodySize = rec.body.length;
        } catch {}
      }
      await persistEntry(net, rec);
    };
    finish().catch(() => {});
  });
  page.on("requestfailed", (request) => {
    const rec = recordFailure(net, request, request.failure()?.errorText);
    if (rec) persistEntry(net, rec).catch(() => {});
  });
}

const sessionId = {
  type: "string",
  description: "Session id returned by cdp_connect",
};

const TOOLS = [
  {
    name: "cdp_connect",
    description:
      "Attach to an already-running Chromium browser via CDP (does not launch a browser). Accepts HTTP (http://127.0.0.1:9222) or WebSocket URLs. Pass capture_dir to start saving every matching request as JSON into that folder (no count limit). Returns session_id for later tools.",
    inputSchema: {
      type: "object",
      properties: {
        cdp_url: {
          type: "string",
          description:
            'CDP WebSocket or HTTP URL, e.g. "ws://127.0.0.1:9222" or "http://127.0.0.1:9222"',
        },
        capture_dir: {
          type: "string",
          description:
            "If set, start network capture and write each request to this directory as JSON. Omit to leave capture off.",
        },
        capture_url_contains: {
          type: "string",
          description: "Only save requests whose URL contains this string",
        },
        capture_method: { type: "string", description: "Only save this HTTP method, e.g. POST" },
        capture_resource_type: {
          type: "string",
          description: "Only save this Playwright resource type, e.g. xhr, fetch, document",
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
        session_id: sessionId,
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
    name: "cdp_reload",
    description: "Reload the current page.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        wait_until: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle", "commit"],
          default: "domcontentloaded",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_go_back",
    description: "Go back in history.",
    inputSchema: {
      type: "object",
      properties: { session_id: sessionId },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_screenshot",
    description: "Capture the current page as a PNG screenshot (returned as image content).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        full_page: { type: "boolean", default: false },
      },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_click",
    description:
      "Click an element by CSS selector, or click at page coordinates (x, y). Supports right/middle click, double-click, and modifier keys.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        click_count: { type: "number", default: 1, description: "2 for double-click" },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
        },
        force: { type: "boolean", default: false },
      },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_hover",
    description: "Hover the mouse over an element matched by CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        selector: { type: "string" },
      },
      required: ["session_id", "selector"],
    },
  },
  {
    name: "cdp_mouse_move",
    description: "Move the mouse to page coordinates without clicking.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["session_id", "x", "y"],
    },
  },
  {
    name: "cdp_type",
    description:
      "Input text. With selector: fill the element (or type key-by-key). Without selector: type into the focused element. Modes: fill (replace value), type (real key events), insert (paste-like, no key events).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        text: { type: "string" },
        selector: { type: "string" },
        mode: {
          type: "string",
          enum: ["fill", "type", "insert"],
          default: "fill",
          description:
            "fill=set value; type=keydown/keypress; insert=insertText (IME/paste style)",
        },
        delay: {
          type: "number",
          default: 0,
          description: "Delay in ms between keystrokes when mode=type",
        },
        clear: {
          type: "boolean",
          description: "Deprecated. false is the same as mode=type",
        },
        press_enter: {
          type: "boolean",
          default: false,
          description: "Press Enter after typing",
        },
      },
      required: ["session_id", "text"],
    },
  },
  {
    name: "cdp_press",
    description:
      'Press a key or shortcut, e.g. "Enter", "Tab", "Escape", "Control+A", "Meta+V". Optional selector focuses that element first.',
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        key: { type: "string" },
        selector: { type: "string" },
      },
      required: ["session_id", "key"],
    },
  },
  {
    name: "cdp_select",
    description: "Choose option(s) on a <select> element by value, label, or index.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        selector: { type: "string" },
        value: { type: "string" },
        values: { type: "array", items: { type: "string" } },
        label: { type: "string" },
        index: { type: "number" },
      },
      required: ["session_id", "selector"],
    },
  },
  {
    name: "cdp_check",
    description: "Check or uncheck a checkbox / radio.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        selector: { type: "string" },
        checked: { type: "boolean", default: true },
      },
      required: ["session_id", "selector"],
    },
  },
  {
    name: "cdp_upload",
    description:
      "Set files on an <input type=file>. Paths must exist on the machine running this MCP server.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        selector: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["session_id", "selector", "files"],
    },
  },
  {
    name: "cdp_scroll",
    description:
      "Scroll an element into view, wheel by delta, or jump to page coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        selector: { type: "string" },
        delta_x: { type: "number" },
        delta_y: { type: "number" },
        x: { type: "number", description: "window.scrollTo x" },
        y: { type: "number", description: "window.scrollTo y" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_evaluate",
    description: "Run a JavaScript expression in the page and return the JSON-serializable result.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        expression: { type: "string" },
      },
      required: ["session_id", "expression"],
    },
  },
  {
    name: "cdp_content",
    description:
      "Get page HTML, or innerHTML of a selector. Large documents are truncated.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        selector: { type: "string" },
        max_chars: { type: "number", default: 200000 },
      },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_page_info",
    description: "Return the current page URL, title, and frame URLs.",
    inputSchema: {
      type: "object",
      properties: { session_id: sessionId },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_wait",
    description:
      "Wait until a CSS selector appears, or wait a fixed timeout in milliseconds if no selector is given.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        selector: { type: "string" },
        timeout: { type: "number", default: 30000 },
      },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_network_start",
    description:
      "Start network capture for this session. Every matching request is written as a JSON file into dir (plus requests.jsonl). No count limit. Call before navigating if you need the first document request.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        dir: { type: "string", description: "Directory to save captured requests" },
        url_contains: { type: "string" },
        method: { type: "string" },
        resource_type: { type: "string" },
      },
      required: ["session_id", "dir"],
    },
  },
  {
    name: "cdp_network_stop",
    description: "Stop capturing. Files already written to dir are kept.",
    inputSchema: {
      type: "object",
      properties: { session_id: sessionId },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_network_log",
    description:
      "List requests already saved on disk. Default last 50 summaries. Use include_body / include_headers to read the JSON files. Capture must have a dir (from cdp_connect capture_dir or cdp_network_start).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        url_contains: { type: "string" },
        method: { type: "string" },
        resource_type: { type: "string" },
        status: { type: "number" },
        limit: { type: "number", default: 50 },
        include_headers: { type: "boolean", default: false },
        include_body: { type: "boolean", default: false },
      },
      required: ["session_id"],
    },
  },
  {
    name: "cdp_wait_response",
    description:
      "Wait until a response whose URL contains url_contains (optional method/status). Returns status, headers, and a truncated body.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        url_contains: { type: "string" },
        method: { type: "string" },
        status: { type: "number" },
        timeout: { type: "number", default: 30000 },
      },
      required: ["session_id", "url_contains"],
    },
  },
  {
    name: "cdp_get_cookies",
    description: "Read cookies from the browser context. Optional url limits the set.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        url: { type: "string" },
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
        session_id: sessionId,
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
    name: "cdp_list_sessions",
    description: "List all active CDP sessions in this MCP process.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cdp_close",
    description: "Disconnect this session from the browser and drop it from the session list.",
    inputSchema: {
      type: "object",
      properties: { session_id: sessionId },
      required: ["session_id"],
    },
  },
];

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
      const net = createNetworkState();
      attachNetwork(page, net);
      const id = `s${++seq}`;
      sessions.set(id, { browser, context, page, cdp: args.cdp_url, net });
      const out = {
        session_id: id,
        url: page.url(),
        title: await page.title(),
        pages: pages.length,
        capture: null,
      };
      if (args.capture_dir) {
        out.capture = await beginCapture(net, {
          dir: args.capture_dir,
          url_contains: args.capture_url_contains,
          method: args.capture_method,
          resource_type: args.capture_resource_type,
        });
      }
      return out;
    }

    case "cdp_navigate": {
      const s = getSession(args.session_id);
      const waitUntil = args.wait_until || "domcontentloaded";
      await s.page.goto(args.url, { waitUntil, timeout: 60000 });
      return { url: s.page.url(), title: await s.page.title() };
    }

    case "cdp_reload": {
      const s = getSession(args.session_id);
      await s.page.reload({
        waitUntil: args.wait_until || "domcontentloaded",
        timeout: 60000,
      });
      return { url: s.page.url(), title: await s.page.title() };
    }

    case "cdp_go_back": {
      const s = getSession(args.session_id);
      await s.page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
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

    case "cdp_click": {
      const s = getSession(args.session_id);
      const opts = { timeout: 10000 };
      if (args.button) opts.button = args.button;
      if (args.click_count) opts.clickCount = args.click_count;
      if (args.modifiers) opts.modifiers = args.modifiers;
      if (args.force) opts.force = true;
      if (args.selector) {
        await s.page.click(args.selector, opts);
      } else if (args.x != null && args.y != null) {
        await s.page.mouse.click(args.x, args.y, {
          button: args.button || "left",
          clickCount: args.click_count || 1,
        });
      } else {
        throw new Error("provide selector or (x, y)");
      }
      return { clicked: args.selector || `(${args.x},${args.y})` };
    }

    case "cdp_hover": {
      const s = getSession(args.session_id);
      await s.page.hover(args.selector, { timeout: 10000 });
      return { hovered: args.selector };
    }

    case "cdp_mouse_move": {
      const s = getSession(args.session_id);
      await s.page.mouse.move(args.x, args.y);
      return { x: args.x, y: args.y };
    }

    case "cdp_type": {
      const s = getSession(args.session_id);
      const delay = args.delay || 0;
      let mode = args.mode;
      if (!mode) {
        if (args.clear === false) mode = "type";
        else mode = args.selector ? "fill" : "type";
      }
      if (mode === "insert") {
        if (args.selector) await s.page.click(args.selector, { timeout: 10000 });
        await s.page.keyboard.insertText(args.text);
      } else if (mode === "type") {
        if (args.selector) {
          const loc = s.page.locator(args.selector);
          await loc.click({ timeout: 10000 });
          await loc.pressSequentially(args.text, { delay });
        } else {
          await s.page.keyboard.type(args.text, { delay });
        }
      } else {
        if (!args.selector) {
          throw new Error("mode=fill requires selector; use mode=type or insert without one");
        }
        if (delay) {
          const loc = s.page.locator(args.selector);
          await loc.fill("", { timeout: 10000 });
          await loc.pressSequentially(args.text, { delay });
        } else {
          await s.page.fill(args.selector, args.text, { timeout: 10000 });
        }
      }
      if (args.press_enter) await s.page.keyboard.press("Enter");
      return { typed: args.text.length, mode };
    }

    case "cdp_press": {
      const s = getSession(args.session_id);
      if (args.selector) {
        await s.page.locator(args.selector).press(args.key, { timeout: 10000 });
      } else {
        await s.page.keyboard.press(args.key);
      }
      return { pressed: args.key };
    }

    case "cdp_select": {
      const s = getSession(args.session_id);
      let option;
      if (args.values) option = args.values;
      else if (args.value != null) option = args.value;
      else if (args.label != null) option = { label: args.label };
      else if (args.index != null) option = { index: args.index };
      else throw new Error("provide value, values, label, or index");
      const selected = await s.page.selectOption(args.selector, option, { timeout: 10000 });
      return { selected };
    }

    case "cdp_check": {
      const s = getSession(args.session_id);
      if (args.checked === false) {
        await s.page.uncheck(args.selector, { timeout: 10000 });
      } else {
        await s.page.check(args.selector, { timeout: 10000 });
      }
      return { checked: args.checked !== false };
    }

    case "cdp_upload": {
      const s = getSession(args.session_id);
      await s.page.setInputFiles(args.selector, args.files, { timeout: 10000 });
      return { files: args.files.length };
    }

    case "cdp_scroll": {
      const s = getSession(args.session_id);
      if (args.selector) {
        await s.page.locator(args.selector).scrollIntoViewIfNeeded();
        return { scrolled: args.selector };
      }
      if (args.delta_x != null || args.delta_y != null) {
        const dx = args.delta_x || 0;
        const dy = args.delta_y || 0;
        await s.page.mouse.wheel(dx, dy);
        return { wheel: { x: dx, y: dy } };
      }
      if (args.x != null || args.y != null) {
        await s.page.evaluate(
          ([x, y]) => window.scrollTo(x ?? window.scrollX, y ?? window.scrollY),
          [args.x ?? null, args.y ?? null]
        );
        return { to: { x: args.x, y: args.y } };
      }
      throw new Error("provide selector, (delta_x, delta_y), or (x, y)");
    }

    case "cdp_evaluate": {
      const s = getSession(args.session_id);
      const result = await s.page.evaluate(args.expression);
      return { result };
    }

    case "cdp_content": {
      const s = getSession(args.session_id);
      const max = args.max_chars || 200000;
      const html = args.selector
        ? await s.page.locator(args.selector).innerHTML({ timeout: 10000 })
        : await s.page.content();
      if (html.length <= max) return { html, truncated: false };
      return { html: html.slice(0, max), truncated: true, length: html.length };
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

    case "cdp_network_start": {
      const s = getSession(args.session_id);
      const capture = await beginCapture(s.net, {
        dir: args.dir,
        url_contains: args.url_contains,
        method: args.method,
        resource_type: args.resource_type,
      });
      return { started: true, ...capture };
    }

    case "cdp_network_stop": {
      const s = getSession(args.session_id);
      disableCapture(s.net);
      return { stopped: true, dir: s.net.dir, saved: s.net.saved, skipped: s.net.skipped };
    }

    case "cdp_network_log": {
      const s = getSession(args.session_id);
      if (!s.net.dir) {
        throw new Error("capture is off; pass capture_dir to cdp_connect or call cdp_network_start");
      }
      const entries = await querySaved(s.net.dir, args);
      return {
        dir: s.net.dir,
        enabled: s.net.enabled,
        saved: s.net.saved,
        skipped: s.net.skipped,
        count: entries.length,
        entries,
      };
    }

    case "cdp_wait_response": {
      const s = getSession(args.session_id);
      const timeout = args.timeout || 30000;
      const method = args.method ? String(args.method).toUpperCase() : null;
      const resp = await s.page.waitForResponse(
        (r) => {
          if (!r.url().includes(args.url_contains)) return false;
          if (method && r.request().method() !== method) return false;
          if (args.status != null && r.status() !== args.status) return false;
          return true;
        },
        { timeout }
      );
      let body = null;
      let bodyTruncated = false;
      try {
        const clipped = clipBody(await resp.text());
        body = clipped.body;
        bodyTruncated = clipped.bodyTruncated;
      } catch {}
      return {
        url: resp.url(),
        status: resp.status(),
        ok: resp.ok(),
        headers: resp.headers(),
        body,
        bodyTruncated,
      };
    }

    case "cdp_get_cookies": {
      const s = getSession(args.session_id);
      const cookies = args.url
        ? await s.context.cookies(args.url)
        : await s.context.cookies();
      return { cookies };
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
