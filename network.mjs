import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const BODY_MAX = 32 * 1024;

const BODY_TYPES = new Set(["xhr", "fetch", "document", "websocket"]);

export function createNetworkState() {
  return {
    enabled: false,
    dir: null,
    filters: {},
    byRequest: new WeakMap(),
    seq: 0,
    saved: 0,
    skipped: 0,
  };
}

export function enableCapture(state, opts = {}) {
  const dir = opts.dir;
  if (!dir) throw new Error("dir is required to start capture");
  state.enabled = true;
  state.dir = dir;
  state.filters = {
    url_contains: opts.url_contains || null,
    method: opts.method ? String(opts.method).toUpperCase() : null,
    resource_type: opts.resource_type || null,
  };
  return state;
}

export function disableCapture(state) {
  state.enabled = false;
  return state;
}

export async function beginCapture(state, opts) {
  enableCapture(state, opts);
  await mkdir(state.dir, { recursive: true });
  await writeFile(
    join(state.dir, "capture.json"),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        dir: state.dir,
        filters: state.filters,
      },
      null,
      2
    ),
    "utf8"
  );
  return { dir: state.dir, filters: state.filters };
}

export function matchesFilter(meta, filters = {}) {
  if (filters.url_contains && !meta.url.includes(filters.url_contains)) return false;
  if (filters.method && meta.method !== filters.method) return false;
  if (filters.resource_type && meta.resourceType !== filters.resource_type) return false;
  return true;
}

export function shouldCaptureBody(resourceType, contentType = "") {
  if (BODY_TYPES.has(resourceType)) return true;
  return String(contentType).toLowerCase().includes("json");
}

export function clipBody(text, max = BODY_MAX) {
  const str = text == null ? "" : String(text);
  if (str.length <= max) {
    return { body: str, bodyTruncated: false, bodySize: str.length };
  }
  return { body: str.slice(0, max), bodyTruncated: true, bodySize: str.length };
}

export function entryFilename(rec) {
  const seq = String(rec.seq).padStart(6, "0");
  const method = rec.method || "GET";
  let path = rec.url || "unknown";
  try {
    const u = new URL(rec.url);
    path = `${u.hostname}${u.pathname}`;
  } catch {}
  const safe = path.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${seq}_${method}_${safe || "request"}.json`;
}

export function recordRequest(state, req, meta) {
  if (!state.enabled) return null;
  if (!matchesFilter(meta, state.filters)) {
    state.skipped++;
    return null;
  }
  const rec = {
    seq: ++state.seq,
    id: `n${state.seq}`,
    method: meta.method,
    url: meta.url,
    resourceType: meta.resourceType,
    requestHeaders: meta.headers || {},
    postData: meta.postData ?? null,
    startedAt: Date.now(),
    status: null,
    ok: null,
    responseHeaders: null,
    body: null,
    bodySize: 0,
    failed: null,
    file: null,
  };
  state.byRequest.set(req, rec);
  return rec;
}

export function recordResponse(state, req, meta) {
  const rec = state.byRequest.get(req);
  if (!rec) return null;
  rec.status = meta.status;
  rec.ok = meta.status >= 200 && meta.status < 400;
  rec.responseHeaders = meta.headers || {};
  if (meta.body != null) {
    rec.body = String(meta.body);
    rec.bodySize = rec.body.length;
  }
  rec.finishedAt = Date.now();
  return rec;
}

export function recordFailure(state, req, errorText) {
  const rec = state.byRequest.get(req);
  if (!rec) return null;
  rec.failed = errorText || "failed";
  rec.finishedAt = Date.now();
  return rec;
}

export async function persistEntry(state, rec) {
  if (!rec || !state.dir || rec.persisted || rec.persisting) return null;
  rec.persisting = true;
  await mkdir(state.dir, { recursive: true });
  const name = entryFilename(rec);
  const file = join(state.dir, name);
  const payload = { ...rec, file: name, persisted: true };
  await writeJson(file, payload);
  await appendFile(join(state.dir, "requests.jsonl"), `${JSON.stringify(summarize(payload))}\n`, "utf8");
  rec.file = name;
  rec.persisted = true;
  state.saved++;
  return file;
}

function summarize(rec) {
  return {
    seq: rec.seq,
    id: rec.id,
    file: rec.file,
    method: rec.method,
    url: rec.url,
    resourceType: rec.resourceType,
    status: rec.status,
    ok: rec.ok,
    failed: rec.failed,
    bodySize: rec.bodySize || 0,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
  };
}

async function writeJson(file, data) {
  await writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

export async function querySaved(dir, opts = {}) {
  if (!dir) return [];
  let lines;
  try {
    lines = (await readFile(join(dir, "requests.jsonl"), "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
  let list = lines.map((line) => JSON.parse(line));
  if (opts.url_contains) {
    const needle = String(opts.url_contains);
    list = list.filter((e) => e.url.includes(needle));
  }
  if (opts.method) {
    const method = String(opts.method).toUpperCase();
    list = list.filter((e) => e.method === method);
  }
  if (opts.resource_type) {
    list = list.filter((e) => e.resourceType === opts.resource_type);
  }
  if (opts.status != null) {
    list = list.filter((e) => e.status === opts.status);
  }
  const limit = opts.limit ?? 50;
  list = list.slice(-limit);
  const out = [];
  for (const e of list) {
    const row = { ...e };
    if (opts.include_headers || opts.include_body) {
      try {
        const full = JSON.parse(await readFile(join(dir, e.file), "utf8"));
        if (opts.include_headers) {
          row.requestHeaders = full.requestHeaders;
          row.responseHeaders = full.responseHeaders;
          row.postData = full.postData;
        }
        if (opts.include_body) {
          row.body = full.body;
          row.postData = full.postData;
        }
      } catch {}
    }
    out.push(row);
  }
  return out;
}
