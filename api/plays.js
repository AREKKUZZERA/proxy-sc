const CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID;
const TRACK_URL = process.env.SOUNDCLOUD_TRACK_URL || "https://soundcloud.com/arekkuzzera/psycho-dreams-hardstyle-remix";
const DEBUG = process.env.DEBUG_PROXY_SC === "1";
const TIMEOUT_MS = Number(process.env.SC_TIMEOUT_MS || 8000);
const CACHE_TTL_SECONDS = Number(process.env.SC_PLAYS_CACHE_TTL_SECONDS || 60);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const cache = globalThis.__proxyScPlaysCache || (globalThis.__proxyScPlaysCache = new Map());

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (!origin || ALLOWED_ORIGINS.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    return true;
  }

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    return true;
  }

  return false;
}

function setCacheHeaders(res, ttlSeconds) {
  res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${ttlSeconds}, stale-while-revalidate=${ttlSeconds}`);
  res.setHeader("CDN-Cache-Control", `public, s-maxage=${ttlSeconds}, stale-while-revalidate=${ttlSeconds}`);
  res.setHeader("Vercel-CDN-Cache-Control", `public, s-maxage=${ttlSeconds}, stale-while-revalidate=${ttlSeconds}`);
}

function jsonError(res, status, error, extra = undefined) {
  return res.status(status).json({
    error,
    ...(DEBUG && extra ? { debug: extra } : {})
  });
}

function getTimeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Request timeout")), ms);
  if (typeof timeout.unref === "function") timeout.unref();
  return controller.signal;
}

async function fetchJsonSafe(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || getTimeoutSignal(TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = null;
  if (text && text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { response, data, text };
}

export default async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (!corsAllowed) {
    return jsonError(res, 403, "Origin is not allowed");
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return jsonError(res, 405, "Method not allowed");
  }

  if (!CLIENT_ID) {
    return jsonError(res, 500, "Misconfiguration: SOUNDCLOUD_CLIENT_ID is required");
  }

  const cacheKey = `plays:${TRACK_URL}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    setCacheHeaders(res, CACHE_TTL_SECONDS);
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cached.payload);
  }

  try {
    const url = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(TRACK_URL)}&client_id=${encodeURIComponent(CLIENT_ID)}`;
    const result = await fetchJsonSafe(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: "https://soundcloud.com",
        Referer: "https://soundcloud.com/"
      }
    });

    if (!result.response.ok) {
      return jsonError(
        res,
        result.response.status,
        result.data?.error || "SoundCloud request failed",
        result.data || result.text || null
      );
    }

    const data = result.data || {};
    const payload = {
      playback_count: Number(data.playback_count ?? 0),
      title: data.title ?? "",
      likes: Number(data.likes_count ?? 0),
      comment_count: Number(data.comment_count ?? 0),
      reposts_count: Number(data.reposts_count ?? 0),
      download_count: Number(data.download_count ?? 0),
      updatedAt: new Date().toISOString()
    };

    cache.set(cacheKey, {
      payload,
      expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000
    });

    setCacheHeaders(res, CACHE_TTL_SECONDS);
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(payload);
  } catch (error) {
    return jsonError(
      res,
      error?.name === "AbortError" ? 504 : 500,
      error?.name === "AbortError" ? "Upstream request timed out" : (error?.message || "Internal server error")
    );
  }
}
