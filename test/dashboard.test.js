import test from "node:test";
import assert from "node:assert/strict";

import dashboardHandler from "../api/dashboard.js";
import { createJsonResponse, createMockReq, createMockRes } from "./helpers.js";

test("dashboard aggregates all paginated tracks and keeps response shape", async () => {
  const responses = [
    createJsonResponse({ id: 42, kind: "user", username: "AREKKUZZERA" }),
    createJsonResponse({
      collection: [
        {
          id: 1,
          title: "Track B",
          playback_count: 200,
          likes_count: 10,
          comment_count: 2,
          reposts_count: 1,
          download_count: 0,
          permalink_url: "https://soundcloud.com/example/track-b",
          artwork_url: "https://img.example/b.jpg"
        },
        {
          id: 2,
          title: "Track A",
          playback_count: 500,
          likes_count: 20,
          comment_count: 3,
          reposts_count: 2,
          download_count: 1,
          permalink_url: "https://soundcloud.com/example/track-a",
          artwork_url: "https://img.example/a.jpg"
        }
      ],
      next_href: "https://api-v2.soundcloud.com/users/42/tracks?cursor=next"
    }),
    createJsonResponse({
      collection: [
        {
          id: 3,
          title: "Track C",
          playback_count: 100,
          likes_count: 5,
          comment_count: 1,
          reposts_count: 0,
          download_count: 0,
          permalink_url: "https://soundcloud.com/example/track-c",
          artwork_url: "https://img.example/c.jpg"
        }
      ]
    })
  ];

  const originalFetch = global.fetch;
  global.fetch = async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected fetch call");
    }
    return response;
  };

  try {
    const req = createMockReq();
    const res = createMockRes();

    await dashboardHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.artist, "AREKKUZZERA");
    assert.equal(res.body.trackCount, 3);
    assert.equal(res.body.tracks[0].title, "Track A");
    assert.equal(res.body.playback_count, 800 + 271858); // live total + manual adjustment
    assert.equal(res.body.likes, 35 + 2759);
    assert.equal(res.getHeader("cache-control"), "public, max-age=0, s-maxage=300, stale-while-revalidate=86400");
    assert.equal(res.body.meta.manualAdjustmentsApplied, true);
    assert.equal(res.body.meta.authMode, "legacy_client_id_fallback");
  } finally {
    global.fetch = originalFetch;
  }
});

test("dashboard rejects unsupported methods", async () => {
  const req = createMockReq({ method: "POST" });
  const res = createMockRes();

  await dashboardHandler(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.code, "method_not_allowed");
});

test("dashboard validates custom url query parameter", async () => {
  const req = createMockReq({ query: { url: "https://example.com/not-soundcloud" } });
  const res = createMockRes();

  await dashboardHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "invalid_soundcloud_url");
});
