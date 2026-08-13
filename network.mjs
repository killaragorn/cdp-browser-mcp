export const NETWORK_MAX = 400;
export const BODY_MAX = 32 * 1024;

const BODY_TYPES = new Set(["xhr", "fetch", "document", "websocket"]);

export function createNetworkState() {
  return {
    entries: [],
    byRequest: new WeakMap(),
    seq: 0,
  };
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

export function recordRequest(state, req, meta) {
  const rec = {
    id: `n${++state.seq}`,
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
    bodyTruncated: false,
    bodySize: 0,
    failed: null,
  };
  state.byRequest.set(req, rec);
  state.entries.push(rec);
  while (state.entries.length > NETWORK_MAX) state.entries.shift();
  return rec;
}

export function recordResponse(state, req, meta) {
  const rec = state.byRequest.get(req);
  if (!rec) return null;
  rec.status = meta.status;
  rec.ok = meta.status >= 200 && meta.status < 400;
  rec.responseHeaders = meta.headers || {};
  if (meta.body != null) {
    const clipped = clipBody(meta.body);
    rec.body = clipped.body;
    rec.bodyTruncated = clipped.bodyTruncated;
    rec.bodySize = clipped.bodySize;
  }
  return rec;
}

export function recordFailure(state, req, errorText) {
  const rec = state.byRequest.get(req);
  if (!rec) return null;
  rec.failed = errorText || "failed";
  return rec;
}

export function queryNetwork(entries, opts = {}) {
  let list = entries;
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
  return list.map((e) => formatEntry(e, opts));
}

function formatEntry(e, opts) {
  const out = {
    id: e.id,
    method: e.method,
    url: e.url,
    resourceType: e.resourceType,
    status: e.status,
    ok: e.ok,
    failed: e.failed,
    postData: e.postData,
    bodySize: e.bodySize || undefined,
    bodyTruncated: e.bodyTruncated || undefined,
  };
  if (opts.include_headers) {
    out.requestHeaders = e.requestHeaders;
    out.responseHeaders = e.responseHeaders;
  }
  if (opts.include_body) out.body = e.body;
  return out;
}
