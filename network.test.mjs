import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BODY_MAX,
  NETWORK_MAX,
  clipBody,
  createNetworkState,
  queryNetwork,
  recordFailure,
  recordRequest,
  recordResponse,
  shouldCaptureBody,
} from "./network.mjs";

test("recordRequest assigns ids and keeps a ring buffer", () => {
  const state = createNetworkState();
  for (let i = 0; i < NETWORK_MAX + 5; i++) {
    recordRequest(state, { i }, {
      method: "GET",
      url: `https://example.com/${i}`,
      resourceType: "xhr",
    });
  }
  assert.equal(state.entries.length, NETWORK_MAX);
  assert.equal(state.entries[0].url, "https://example.com/5");
  assert.equal(state.entries.at(-1).id, `n${NETWORK_MAX + 5}`);
});

test("recordResponse and recordFailure attach to the same request object", () => {
  const state = createNetworkState();
  const req = {};
  recordRequest(state, req, {
    method: "POST",
    url: "https://api.example.com/login",
    resourceType: "fetch",
    headers: { "content-type": "application/json" },
    postData: '{"u":"a"}',
  });
  recordResponse(state, req, {
    status: 200,
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
  });
  assert.equal(state.entries[0].status, 200);
  assert.equal(state.entries[0].body, '{"ok":true}');

  const failed = {};
  recordRequest(state, failed, {
    method: "GET",
    url: "https://example.com/x",
    resourceType: "xhr",
  });
  recordFailure(state, failed, "net::ERR_FAILED");
  assert.equal(state.entries[1].failed, "net::ERR_FAILED");
});

test("shouldCaptureBody keeps xhr/fetch/document and json", () => {
  assert.equal(shouldCaptureBody("xhr", "text/plain"), true);
  assert.equal(shouldCaptureBody("fetch", ""), true);
  assert.equal(shouldCaptureBody("document", "text/html"), true);
  assert.equal(shouldCaptureBody("image", "image/png"), false);
  assert.equal(shouldCaptureBody("stylesheet", "text/css"), false);
  assert.equal(shouldCaptureBody("script", "application/json"), true);
});

test("clipBody truncates and reports size", () => {
  const big = "a".repeat(BODY_MAX + 10);
  const clipped = clipBody(big);
  assert.equal(clipped.body.length, BODY_MAX);
  assert.equal(clipped.bodyTruncated, true);
  assert.equal(clipped.bodySize, BODY_MAX + 10);
  assert.deepEqual(clipBody("short"), {
    body: "short",
    bodyTruncated: false,
    bodySize: 5,
  });
});

test("queryNetwork filters and omits body/headers by default", () => {
  const state = createNetworkState();
  for (const [method, url, type, status] of [
    ["GET", "https://cdn.example.com/app.js", "script", 200],
    ["POST", "https://api.example.com/login", "fetch", 200],
    ["GET", "https://api.example.com/me", "xhr", 401],
  ]) {
    const req = {};
    recordRequest(state, req, { method, url, resourceType: type, headers: { a: "1" } });
    recordResponse(state, req, {
      status,
      headers: { "content-type": "application/json" },
      body: '{"x":1}',
    });
  }

  const listed = queryNetwork(state.entries, { url_contains: "api.example.com" });
  assert.equal(listed.length, 2);
  assert.equal(listed[0].body, undefined);
  assert.equal(listed[0].requestHeaders, undefined);
  assert.equal(listed[0].responseHeaders, undefined);

  const withBody = queryNetwork(state.entries, {
    method: "POST",
    include_body: true,
    include_headers: true,
  });
  assert.equal(withBody.length, 1);
  assert.equal(withBody[0].body, '{"x":1}');
  assert.equal(withBody[0].requestHeaders.a, "1");

  const unauthorized = queryNetwork(state.entries, { status: 401 });
  assert.equal(unauthorized.length, 1);
  assert.equal(unauthorized[0].url, "https://api.example.com/me");
});

test("queryNetwork limit returns the most recent matches", () => {
  const state = createNetworkState();
  for (let i = 0; i < 10; i++) {
    recordRequest(state, { i }, {
      method: "GET",
      url: `https://example.com/${i}`,
      resourceType: "xhr",
    });
  }
  const last = queryNetwork(state.entries, { limit: 3 });
  assert.deepEqual(last.map((e) => e.url), [
    "https://example.com/7",
    "https://example.com/8",
    "https://example.com/9",
  ]);
});
