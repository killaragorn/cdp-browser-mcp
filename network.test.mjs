import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BODY_MAX,
  clipBody,
  createNetworkState,
  disableCapture,
  enableCapture,
  entryFilename,
  persistEntry,
  querySaved,
  recordFailure,
  recordRequest,
  recordResponse,
  shouldCaptureBody,
} from "./network.mjs";

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cdp-cap-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("capture is off until enableCapture gets a dir", () => {
  const state = createNetworkState();
  const rec = recordRequest(state, {}, {
    method: "GET",
    url: "https://example.com/",
    resourceType: "document",
  });
  assert.equal(rec, null);
  assert.throws(() => enableCapture(state, {}), /dir/);
});

test("disabled capture writes no files", async () => {
  await withDir(async (dir) => {
    const state = createNetworkState();
    const rec = recordRequest(state, {}, {
      method: "GET",
      url: "https://example.com/",
      resourceType: "xhr",
    });
    assert.equal(rec, null);
    const files = await readdir(dir);
    assert.deepEqual(files, []);
  });
});

test("matching requests persist full JSON to dir with no count cap", async () => {
  await withDir(async (dir) => {
    const state = createNetworkState();
    enableCapture(state, { dir });
    const n = 50;
    for (let i = 0; i < n; i++) {
      const req = { i };
      const rec = recordRequest(state, req, {
        method: "GET",
        url: `https://api.example.com/item/${i}`,
        resourceType: "xhr",
        headers: { a: "1" },
      });
      recordResponse(state, req, {
        status: 200,
        headers: { "content-type": "application/json" },
        body: `{"i":${i}}`,
      });
      await persistEntry(state, rec);
    }
    assert.equal(state.saved, n);
    assert.equal(state.entries, undefined);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, n);
    const first = JSON.parse(await readFile(join(dir, files.sort()[0]), "utf8"));
    assert.equal(first.method, "GET");
    assert.equal(first.body, '{"i":0}');
    assert.equal(first.requestHeaders.a, "1");
  });
});

test("url_contains filter skips other requests", async () => {
  await withDir(async (dir) => {
    const state = createNetworkState();
    enableCapture(state, { dir, url_contains: "api.example.com" });
    const skip = recordRequest(state, {}, {
      method: "GET",
      url: "https://cdn.example.com/app.js",
      resourceType: "script",
    });
    const keepReq = {};
    const keep = recordRequest(state, keepReq, {
      method: "POST",
      url: "https://api.example.com/login",
      resourceType: "fetch",
    });
    recordResponse(state, keepReq, { status: 200, headers: {}, body: "ok" });
    await persistEntry(state, keep);
    assert.equal(skip, null);
    assert.equal(state.skipped, 1);
    assert.equal(state.saved, 1);
  });
});

test("disk body is not truncated; clipBody is only for MCP replies", async () => {
  await withDir(async (dir) => {
    const state = createNetworkState();
    enableCapture(state, { dir });
    const req = {};
    const big = "x".repeat(BODY_MAX + 100);
    const rec = recordRequest(state, req, {
      method: "POST",
      url: "https://api.example.com/big",
      resourceType: "fetch",
    });
    recordResponse(state, req, {
      status: 200,
      headers: { "content-type": "application/json" },
      body: big,
    });
    await persistEntry(state, rec);
    const saved = JSON.parse(await readFile(join(dir, rec.file), "utf8"));
    assert.equal(saved.body.length, big.length);
    assert.equal(clipBody(big).body.length, BODY_MAX);
  });
});

test("failed requests are still saved", async () => {
  await withDir(async (dir) => {
    const state = createNetworkState();
    enableCapture(state, { dir });
    const req = {};
    const rec = recordRequest(state, req, {
      method: "GET",
      url: "https://example.com/x",
      resourceType: "xhr",
    });
    recordFailure(state, req, "net::ERR_FAILED");
    await persistEntry(state, rec);
    const saved = JSON.parse(await readFile(join(dir, rec.file), "utf8"));
    assert.equal(saved.failed, "net::ERR_FAILED");
  });
});

test("entryFilename is stable and filesystem-safe", () => {
  const name = entryFilename({
    seq: 7,
    method: "POST",
    url: "https://api.example.com/v1/login?x=1",
  });
  assert.match(name, /^000007_POST_api\.example\.com-v1-login\.json$/);
});

test("querySaved reads the jsonl index and can load bodies from files", async () => {
  await withDir(async (dir) => {
    const state = createNetworkState();
    enableCapture(state, { dir });
    for (const [i, status] of [[0, 200], [1, 401], [2, 200]]) {
      const req = { i };
      const rec = recordRequest(state, req, {
        method: i === 1 ? "POST" : "GET",
        url: `https://api.example.com/${i}`,
        resourceType: "xhr",
        headers: { h: "1" },
      });
      recordResponse(state, req, {
        status,
        headers: { "content-type": "application/json" },
        body: `{"n":${i}}`,
      });
      await persistEntry(state, rec);
    }
    const listed = await querySaved(dir, { url_contains: "api.example.com" });
    assert.equal(listed.length, 3);
    assert.equal(listed[0].body, undefined);
    const withBody = await querySaved(dir, { method: "POST", include_body: true, include_headers: true });
    assert.equal(withBody.length, 1);
    assert.equal(withBody[0].body, '{"n":1}');
    assert.equal(withBody[0].requestHeaders.h, "1");
    const last = await querySaved(dir, { limit: 1 });
    assert.equal(last.length, 1);
    assert.equal(last[0].url, "https://api.example.com/2");
  });
});

test("disableCapture stops further saves", async () => {
  await withDir(async (dir) => {
    const state = createNetworkState();
    enableCapture(state, { dir });
    disableCapture(state);
    const rec = recordRequest(state, {}, {
      method: "GET",
      url: "https://example.com/",
      resourceType: "xhr",
    });
    assert.equal(rec, null);
  });
});

test("shouldCaptureBody keeps xhr/fetch/document and json", () => {
  assert.equal(shouldCaptureBody("xhr", "text/plain"), true);
  assert.equal(shouldCaptureBody("image", "image/png"), false);
  assert.equal(shouldCaptureBody("script", "application/json"), true);
});
