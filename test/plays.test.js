import test from "node:test";
import assert from "node:assert/strict";

import playsHandler from "../api/plays.js";
import { createJsonResponse, createMockReq, createMockRes } from "./helpers.js";

test("plays resolves a track and returns normalized counters", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => createJsonResponse({
    kind: "track",
    title: "Psycho Dreams",
    playback_count: 999,
    likes_count: 77,
    comment_count: 6,
    reposts_count: 4,
    download_count: 3,
    permalink_url: "https://soundcloud.com/example/psycho-dreams",
    artwork_url: "https://img.example/cover.jpg"
  });

  try {
    const req = createMockReq();
    const res = createMockRes();

    await playsHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.title, "Psycho Dreams");
    assert.equal(res.body.playback_count, 999);
    assert.equal(res.body.likes, 77);
    assert.equal(res.body.meta.authMode, "legacy_client_id_fallback");
    assert.equal(res.getHeader("cache-control"), "public, max-age=0, s-maxage=60, stale-while-revalidate=300");
  } finally {
    global.fetch = originalFetch;
  }
});

test("plays returns 422 if resolved resource is not a track", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => createJsonResponse({ kind: "user", username: "not a track" });

  try {
    const req = createMockReq();
    const res = createMockRes();

    await playsHandler(req, res);

    assert.equal(res.statusCode, 422);
    assert.equal(res.body.code, "unexpected_soundcloud_resource");
  } finally {
    global.fetch = originalFetch;
  }
});
