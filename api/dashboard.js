const CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID;
const USER_URL = process.env.SOUNDCLOUD_USER_URL || "https://soundcloud.com/arekkuzzera";
const DEBUG = process.env.DEBUG_PROXY_SC === "1";
const TIMEOUT_MS = Number(process.env.SC_TIMEOUT_MS || 8000);
const CACHE_TTL_SECONDS = Number(process.env.SC_CACHE_TTL_SECONDS || 300);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const TRACK_PAGE_SIZE = Math.min(Number(process.env.SC_TRACK_PAGE_SIZE || 200), 200);
const MAX_TRACK_PAGES = Number(process.env.SC_MAX_TRACK_PAGES || 10);
const MAX_TRACKS_TOTAL = Number(process.env.SC_MAX_TRACKS_TOTAL || 2000);
const MAX_TRACKS_IN_RESPONSE = Number(process.env.SC_MAX_TRACKS_IN_RESPONSE || 200);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://soundcloud.com",
  Referer: "https://soundcloud.com/",
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty"
};

const YEARLY_TOTALS = [
  { label: "2016", total: 0 },
  { label: "2017", total: 0 },
  { label: "2018", total: 0 },
  { label: "2019", total: 0 },
  { label: "2020", total: 0 },
  { label: "2021", total: 0 },
  { label: "2022", total: 0 },
  { label: "2023", total: 150000 },
  { label: "2024", total: 710000 },
  { label: "2025", total: 1620000 },
  { label: "2026", total: 1735576 }
];

function cumulativeToGrowth(items) {
  return items.map((item, index) => {
    if (index === 0) return { label: item.label, plays: item.total };
    const prev = items[index - 1].total;
    return { label: item.label, plays: Math.max(item.total - prev, 0) };
  });
}

const MANUAL_ADJUSTMENTS = {
  totals: {
    playback_count: 271858,
    likes: 2759,
    comments: 36,
    reposts: 118,
    downloads: 0
  },
  history: {
    yearly: cumulativeToGrowth(YEARLY_TOTALS),
    monthly: [
      { label: "Jan", plays: 12000 },
      { label: "Feb", plays: 17000 },
      { label: "Mar", plays: 22000 },
      { label: "Apr", plays: 28000 },
      { label: "May", plays: 31000 },
      { label: "Jun", plays: 26000 },
      { label: "Jul", plays: 34000 },
      { label: "Aug", plays: 41000 },
      { label: "Sep", plays: 52000 },
      { label: "Oct", plays: 68000 },
      { label: "Nov", plays: 74000 },
      { label: "Dec", plays: 91000 }
    ],
    daily: Array.from({ length: 14 }, (_, i) => ({
      label: String(i + 1),
      plays: 2000 + i * 180
    }))
  }
};

const cache = globalThis.__proxyScDashboardCache || (globalThis.__proxyScDashboardCache = new Map());
const rateState = globalThis.__proxyScDashboardRateState || (globalThis.__proxyScDashboardRateState = new Map());

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

function getIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function rateLimit(req) {
  const ip = getIp(req);
  const now = Date.now();
  const bucket = rateState.get(ip);

  if (!bucket || now - bucket.start >= RATE_LIMIT_WINDOW_MS) {
    rateState.set(ip, { start: now, count: 1 });
    return { ok: true };
  }

  if (bucket.count >= RATE_LIMIT_MAX) {
    return { ok: false, retryAfterSeconds: Math.ceil((RATE_LIMIT_WINDOW_MS - (now - bucket.start)) / 1000) };
  }

  bucket.count += 1;
  return { ok: true };
}

async function fetchAllTracks(userId) {
  let nextUrl = `https://api-v2.soundcloud.com/users/${userId}/tracks?client_id=${encodeURIComponent(CLIENT_ID)}&limit=${TRACK_PAGE_SIZE}&linked_partitioning=1`;
  const tracks = [];
  let pages = 0;

  while (nextUrl && pages < MAX_TRACK_PAGES && tracks.length < MAX_TRACKS_TOTAL) {
    pages += 1;
    const result = await fetchJsonSafe(nextUrl, { headers: BASE_HEADERS });
    if (!result.response.ok) {
      const message = result.data?.error || `Tracks request failed: HTTP ${result.response.status}`;
      const error = new Error(message);
      error.status = result.response.status;
      error.extra = result.data || result.text || null;
      throw error;
    }

    const payload = result.data;
    const pageTracks = Array.isArray(payload?.collection)
      ? payload.collection
      : Array.isArray(payload)
        ? payload
        : [];

    for (const track of pageTracks) {
      tracks.push(track);
      if (tracks.length >= MAX_TRACKS_TOTAL) break;
    }

    nextUrl = payload?.next_href || null;
  }

  return tracks;
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

  const limitCheck = rateLimit(req);
  if (!limitCheck.ok) {
    res.setHeader("Retry-After", String(limitCheck.retryAfterSeconds));
    return jsonError(res, 429, "Too many requests");
  }

  const cacheKey = `dashboard:${USER_URL}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    setCacheHeaders(res, CACHE_TTL_SECONDS);
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cached.payload);
  }

  try {
    const resolved = await fetchJsonSafe(
      `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(USER_URL)}&client_id=${encodeURIComponent(CLIENT_ID)}`,
      { headers: BASE_HEADERS }
    );

    if (!resolved.response.ok) {
      return jsonError(
        res,
        resolved.response.status,
        resolved.data?.error || `Resolve failed: HTTP ${resolved.response.status}`,
        resolved.data || resolved.text || null
      );
    }

    const user = resolved.data;
    const userId = user?.id;
    if (!userId) {
      return jsonError(res, 502, "User ID not found in resolve response", user || null);
    }

    const tracks = await fetchAllTracks(userId);

    const totals = tracks.reduce(
      (acc, track) => {
        acc.playback_count += Number(track?.playback_count || 0);
        acc.likes += Number(track?.likes_count || 0);
        acc.comments += Number(track?.comment_count || 0);
        acc.reposts += Number(track?.reposts_count || 0);
        acc.downloads += Number(track?.download_count || 0);
        return acc;
      },
      { playback_count: 0, likes: 0, comments: 0, reposts: 0, downloads: 0 }
    );

    const finalTotals = {
      playback_count: totals.playback_count + MANUAL_ADJUSTMENTS.totals.playback_count,
      likes: totals.likes + MANUAL_ADJUSTMENTS.totals.likes,
      comments: totals.comments + MANUAL_ADJUSTMENTS.totals.comments,
      reposts: totals.reposts + MANUAL_ADJUSTMENTS.totals.reposts,
      downloads: totals.downloads + MANUAL_ADJUSTMENTS.totals.downloads
    };

    const sortedTracks = tracks
      .map((track) => ({
        title: track?.title || "Untitled",
        playback_count: Number(track?.playback_count || 0),
        likes_count: Number(track?.likes_count || 0),
        comment_count: Number(track?.comment_count || 0),
        reposts_count: Number(track?.reposts_count || 0),
        download_count: Number(track?.download_count || 0),
        permalink_url: track?.permalink_url || null,
        artwork_url: track?.artwork_url || null
      }))
      .sort((a, b) => b.playback_count - a.playback_count)
      .slice(0, MAX_TRACKS_IN_RESPONSE);

    const payload = {
      artist: user?.username || "AREKKUZZERA",
      trackCount: tracks.length,
      sinceYear: 2016,
      trackTitle: `${user?.username || "Artist"} — All Tracks`,
      playback_count: finalTotals.playback_count,
      likes: finalTotals.likes,
      comments: finalTotals.comments,
      reposts: finalTotals.reposts,
      downloads: finalTotals.downloads,
      history: MANUAL_ADJUSTMENTS.history,
      tracks: sortedTracks,
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
      error?.status && Number.isInteger(error.status) ? error.status : 500,
      error?.name === "AbortError" ? "Upstream request timed out" : (error?.message || "Internal server error"),
      error?.extra || null
    );
  }
}
