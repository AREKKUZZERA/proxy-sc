import { AppError } from "./http.js";

const API_BASE_URL = process.env.SOUNDCLOUD_API_BASE_URL?.trim() || "https://api-v2.soundcloud.com";
const TOKEN_URL = process.env.SOUNDCLOUD_TOKEN_URL?.trim() || "https://secure.soundcloud.com/oauth/token";
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.SOUNDCLOUD_REQUEST_TIMEOUT_MS || "10000", 10);
const MAX_COLLECTION_PAGES = Number.parseInt(process.env.SOUNDCLOUD_MAX_COLLECTION_PAGES || "20", 10);
const PAGE_LIMIT = Math.min(
  Number.parseInt(process.env.SOUNDCLOUD_PAGE_LIMIT || "200", 10) || 200,
  200
);
const LEGACY_FALLBACK_CLIENT_ID = "WU4bVxk5Df0g5JC8ULzW77Ry7OM10Lyj";

// ─── Retry / rate-limit config ────────────────────────────────────────────────
const RETRY_MAX_ATTEMPTS   = Number.parseInt(process.env.SOUNDCLOUD_RETRY_MAX || "4",    10);
const RETRY_BASE_DELAY_MS  = Number.parseInt(process.env.SOUNDCLOUD_RETRY_BASE_MS || "500", 10);
const RETRY_MAX_DELAY_MS   = Number.parseInt(process.env.SOUNDCLOUD_RETRY_MAX_MS || "15000", 10);
// Min gap between requests to the same origin (milliseconds)
const MIN_REQUEST_GAP_MS   = Number.parseInt(process.env.SOUNDCLOUD_MIN_GAP_MS || "250",  10);

// ─── Token cache ──────────────────────────────────────────────────────────────
const tokenCache = {
  accessToken: null,
  expiresAt: 0,
  inFlight: null
};

// ─── Rate-limit state ─────────────────────────────────────────────────────────
const rateLimitState = {
  lastRequestAt: 0,
  // Per-status backoff: if we receive 429/503 we park until this timestamp
  blockedUntil: 0
};

// ─── Browser fingerprint pool ─────────────────────────────────────────────────
// Each entry represents a distinct browser/platform combination. We rotate
// through them per-request so the server never sees a long run of identical UA.
const BROWSER_PROFILES = [
  {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"'
  },
  {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"'
  },
  {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "sec-ch-ua": undefined,          // Firefox does not send sec-ch-ua
    "sec-ch-ua-mobile": undefined,
    "sec-ch-ua-platform": undefined
  },
  {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
    "sec-ch-ua": undefined,
    "sec-ch-ua-mobile": undefined,
    "sec-ch-ua-platform": undefined
  }
];

// Light rotation state — advances on every collection-page fetch
let _profileIndex = 0;

function pickBrowserProfile() {
  const profile = BROWSER_PROFILES[_profileIndex % BROWSER_PROFILES.length];
  _profileIndex += 1;
  return profile;
}

/**
 * Build the anti-bot header set for a given profile, stripping undefined keys
 * so they are never sent as the literal string "undefined".
 */
function buildAntibotHeaders(profile = pickBrowserProfile()) {
  const headers = {
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Origin":          "https://soundcloud.com",
    "Referer":         "https://soundcloud.com/",
    "Sec-Fetch-Site":  "same-site",
    "Sec-Fetch-Mode":  "cors",
    "Sec-Fetch-Dest":  "empty",
    "Connection":      "keep-alive",
    "User-Agent":      profile["User-Agent"]
  };

  if (profile["sec-ch-ua"])          headers["sec-ch-ua"]          = profile["sec-ch-ua"];
  if (profile["sec-ch-ua-mobile"])   headers["sec-ch-ua-mobile"]   = profile["sec-ch-ua-mobile"];
  if (profile["sec-ch-ua-platform"]) headers["sec-ch-ua-platform"] = profile["sec-ch-ua-platform"];

  return headers;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toPositiveInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

/** Sleep for `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Add random jitter (±factor of base) to avoid thundering-herd retries when
 * multiple parallel requests all back off at exactly the same interval.
 */
function withJitter(ms, factor = 0.25) {
  const range = ms * factor;
  return ms + (Math.random() * range * 2 - range);
}

/**
 * Compute exponential backoff delay for attempt N (0-indexed).
 * Caps at RETRY_MAX_DELAY_MS and always adds jitter.
 */
function backoffDelay(attempt) {
  const base = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(withJitter(base), RETRY_MAX_DELAY_MS);
}

/**
 * Return true for HTTP status codes that are transient and worth retrying.
 * 429 = Too Many Requests, 5xx = server-side errors.
 * 403 / captcha blocks are NOT retried — they need a different strategy.
 */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status !== 501);
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cleanup() { clearTimeout(timeout); } };
}

function toBasicAuthHeader(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

async function parseResponse(response) {
  const text = await response.text();
  let data = null;
  if (text && text.trim()) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { response, text, data };
}

// ─── Core fetch (single attempt, no retry logic here) ────────────────────────

async function fetchOnce(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const { signal, cleanup } = createTimeoutSignal(timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal,
      headers: { Accept: "application/json", ...(options.headers || {}) }
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError("SoundCloud request timed out", {
        status: 504, code: "soundcloud_timeout"
      });
    }
    throw new AppError("Failed to reach SoundCloud", {
      status: 502, code: "soundcloud_unreachable",
      details: { cause: error?.message || String(error) }
    });
  } finally {
    cleanup();
  }
}

/**
 * Rate-aware fetch with exponential-backoff retry.
 *
 * Behaviour:
 *  1. Enforces a minimum gap between outgoing requests (MIN_REQUEST_GAP_MS).
 *  2. If a 429/503 is received, reads Retry-After (seconds or HTTP-date) and
 *     parks until that time before retrying.
 *  3. On each retryable failure, waits backoffDelay(attempt) + jitter.
 *  4. Non-retryable responses (200, 403, 404 …) are returned immediately.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    // ── 1. Respect global rate-limit parking ──────────────────────────────
    const now = Date.now();
    if (rateLimitState.blockedUntil > now) {
      await sleep(rateLimitState.blockedUntil - now);
    }

    // ── 2. Enforce minimum inter-request gap ──────────────────────────────
    const sinceLastRequest = Date.now() - rateLimitState.lastRequestAt;
    if (sinceLastRequest < MIN_REQUEST_GAP_MS) {
      await sleep(withJitter(MIN_REQUEST_GAP_MS - sinceLastRequest));
    }

    rateLimitState.lastRequestAt = Date.now();

    const response = await fetchOnce(url, options, timeoutMs);

    // ── 3. Rate-limited? Parse Retry-After and park ───────────────────────
    if (response.status === 429 || response.status === 503) {
      const retryAfterHeader = response.headers?.get("Retry-After");
      let parkMs = backoffDelay(attempt);

      if (isNonEmptyString(retryAfterHeader)) {
        const retrySeconds = Number(retryAfterHeader);
        if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
          parkMs = Math.min(retrySeconds * 1000, RETRY_MAX_DELAY_MS);
        } else {
          // HTTP-date format
          const retryDate = Date.parse(retryAfterHeader);
          if (!Number.isNaN(retryDate)) {
            parkMs = Math.min(Math.max(retryDate - Date.now(), 0), RETRY_MAX_DELAY_MS);
          }
        }
      }

      // Last attempt — propagate error rather than sleeping pointlessly
      if (attempt >= RETRY_MAX_ATTEMPTS - 1) break;

      rateLimitState.blockedUntil = Date.now() + parkMs;
      await sleep(parkMs);
      continue;
    }

    // ── 4. Other retryable server error ───────────────────────────────────
    if (isRetryableStatus(response.status) && attempt < RETRY_MAX_ATTEMPTS - 1) {
      await sleep(backoffDelay(attempt));
      continue;
    }

    // ── 5. Success or non-retryable ───────────────────────────────────────
    return response;
  }

  // All attempts exhausted — return whatever the last response was so the
  // caller can inspect status codes and build a proper error.
  return fetchOnce(url, options, timeoutMs);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function exchangeClientCredentialsToken(clientId, clientSecret) {
  const response = await fetchOnce(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: toBasicAuthHeader(clientId, clientSecret)
    },
    body: new URLSearchParams({ grant_type: "client_credentials" })
  }, REQUEST_TIMEOUT_MS);

  const parsed = await parseResponse(response);

  if (!parsed.response.ok) {
    throw new AppError("SoundCloud token request failed", {
      status: 502, code: "soundcloud_auth_failed",
      details: parsed.data || parsed.text || null
    });
  }

  const accessToken = parsed.data?.access_token;
  const expiresIn = toPositiveInteger(parsed.data?.expires_in, 3600);

  if (!isNonEmptyString(accessToken)) {
    throw new AppError("SoundCloud token response did not contain an access token", {
      status: 502, code: "soundcloud_auth_invalid_response",
      details: parsed.data || null
    });
  }

  tokenCache.accessToken = accessToken;
  tokenCache.expiresAt = Date.now() + Math.max(expiresIn - 60, 1) * 1000;
  return accessToken;
}

async function getAccessTokenFromCredentials(clientId, clientSecret) {
  if (isNonEmptyString(tokenCache.accessToken) && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken;
  }
  if (!tokenCache.inFlight) {
    tokenCache.inFlight = exchangeClientCredentialsToken(clientId, clientSecret)
      .finally(() => { tokenCache.inFlight = null; });
  }
  return tokenCache.inFlight;
}

export async function getSoundCloudAuth() {
  const manualAccessToken = process.env.SOUNDCLOUD_ACCESS_TOKEN?.trim();
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID?.trim();
  const clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET?.trim();

  if (isNonEmptyString(manualAccessToken)) {
    return { mode: "access_token", headers: { Authorization: `Bearer ${manualAccessToken}` }, query: {} };
  }

  if (isNonEmptyString(clientId) && isNonEmptyString(clientSecret)) {
    const accessToken = await getAccessTokenFromCredentials(clientId, clientSecret);
    return { mode: "client_credentials", headers: { Authorization: `Bearer ${accessToken}` }, query: {} };
  }

  const fallbackClientId = clientId || LEGACY_FALLBACK_CLIENT_ID;
  if (!isNonEmptyString(fallbackClientId)) {
    throw new AppError("SoundCloud credentials are not configured", {
      status: 500, code: "configuration_error"
    });
  }

  return {
    mode: clientId ? "client_id" : "legacy_client_id_fallback",
    headers: {},
    query: { client_id: fallbackClientId }
  };
}

// ─── URL builder ──────────────────────────────────────────────────────────────

function buildRequestUrl(pathOrUrl, extraQuery = {}) {
  const url = pathOrUrl.startsWith("http")
    ? new URL(pathOrUrl)
    : new URL(pathOrUrl, `${API_BASE_URL}/`);

  for (const [key, value] of Object.entries(extraQuery)) {
    if (value !== undefined && value !== null && value !== "") {
      if (!url.searchParams.has(key) || url.searchParams.get(key) !== String(value)) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url;
}

// ─── Error factories ──────────────────────────────────────────────────────────

/**
 * Detect captcha / geo-block patterns beyond just the URL check:
 *  - datadome / imperva challenge pages return 403 with a specific body
 *  - Some proxies return 200 with an HTML challenge page
 */
function isCaptchaResponse(parsed) {
  if (parsed?.data?.url && typeof parsed.data.url === "string" &&
      parsed.data.url.includes("geo.captcha-delivery.com")) return true;

  // HTML challenge page masquerading as success
  const raw = parsed?.text || "";
  if (parsed?.response?.status === 200 && raw.trim().startsWith("<!DOCTYPE")) return true;

  // DataDome / Imperva header
  if (parsed?.response?.headers?.get("x-datadome-cid")) return true;

  return false;
}

function createUpstreamError(message, parsed) {
  if (isCaptchaResponse(parsed)) {
    return new AppError("SoundCloud blocked the request with captcha", {
      status: parsed.response.status || 502,
      code: "soundcloud_captcha_blocked",
      details: {
        upstreamStatus: parsed.response.status || null,
        upstreamUrl: parsed.url || null,
        upstreamBody: parsed.data || parsed.text || null
      }
    });
  }

  return new AppError(message, {
    status: parsed.response.status || 502,
    code: "soundcloud_upstream_error",
    details: {
      upstreamStatus: parsed.response.status || null,
      upstreamUrl: parsed.url || null,
      upstreamBody: parsed.data || parsed.text || null
    }
  });
}

// ─── Public API fetch ─────────────────────────────────────────────────────────

export async function soundCloudFetchJson(
  pathOrUrl,
  { query = {}, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}
) {
  const auth = await getSoundCloudAuth();
  const url  = buildRequestUrl(pathOrUrl, { ...query, ...auth.query });

  const response = await fetchWithTimeout(
    url.toString(),
    { headers: { ...auth.headers, ...headers } },
    timeoutMs
  );

  const parsed = await parseResponse(response);
  return { ...parsed, authMode: auth.mode, url: url.toString() };
}

export async function resolveResource(resourceUrl, { expectedKinds = [] } = {}) {
  const parsed = await soundCloudFetchJson("/resolve", { query: { url: resourceUrl } });

  if (!parsed.response.ok) {
    throw createUpstreamError("Failed to resolve SoundCloud URL", parsed);
  }

  const kind = String(parsed.data?.kind || "").toLowerCase();
  if (expectedKinds.length > 0 && kind && !expectedKinds.map((k) => k.toLowerCase()).includes(kind)) {
    throw new AppError(`Unexpected SoundCloud resource type: ${kind || "unknown"}`, {
      status: 422, code: "unexpected_soundcloud_resource",
      details: { expectedKinds, receivedKind: kind || null }
    });
  }

  return { data: parsed.data, authMode: parsed.authMode };
}

// ─── Collection paginator ─────────────────────────────────────────────────────

export async function fetchCollection(pathOrUrl) {
  const items = [];
  let nextUrl  = pathOrUrl;
  let authMode = null;

  for (let page = 0; page < MAX_COLLECTION_PAGES; page += 1) {
    // Pick a fresh browser profile every page to vary the fingerprint
    const profile = pickBrowserProfile();

    const parsed = await soundCloudFetchJson(nextUrl, {
      query: {
        linked_partitioning: true,
        ...(page === 0 ? { limit: PAGE_LIMIT } : {})
      },
      headers: buildAntibotHeaders(profile)
    });

    authMode ||= parsed.authMode;

    if (!parsed.response.ok) {
      // Captcha: surface immediately — no point retrying with same identity
      if (isCaptchaResponse(parsed)) {
        throw createUpstreamError("Failed to fetch SoundCloud collection", parsed);
      }
      throw createUpstreamError("Failed to fetch SoundCloud collection", parsed);
    }

    const pageItems = Array.isArray(parsed.data?.collection)
      ? parsed.data.collection
      : Array.isArray(parsed.data)
        ? parsed.data
        : [];

    items.push(...pageItems);

    if (!isNonEmptyString(parsed.data?.next_href)) {
      return { items, authMode };
    }

    nextUrl = parsed.data.next_href;

    // Inter-page delay with jitter to mimic human browsing rhythm
    if (page < MAX_COLLECTION_PAGES - 1) {
      await sleep(withJitter(MIN_REQUEST_GAP_MS * 2));
    }
  }

  throw new AppError(
    `SoundCloud pagination exceeded the configured maximum of ${MAX_COLLECTION_PAGES} pages`,
    { status: 502, code: "soundcloud_pagination_limit" }
  );
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

export function normalizeTrack(track) {
  return {
    id: track?.id ?? track?.urn ?? null,
    title: isNonEmptyString(track?.title) ? track.title.trim() : "Untitled",
    playback_count: toPositiveInteger(track?.playback_count),
    likes_count:    toPositiveInteger(track?.likes_count ?? track?.favoritings_count),
    comment_count:  toPositiveInteger(track?.comment_count),
    reposts_count:  toPositiveInteger(track?.reposts_count),
    download_count: toPositiveInteger(track?.download_count),
    permalink_url:  isNonEmptyString(track?.permalink_url) ? track.permalink_url : null,
    artwork_url:    isNonEmptyString(track?.artwork_url)
      ? track.artwork_url
      : (isNonEmptyString(track?.user?.avatar_url) ? track.user.avatar_url : null),
    created_at: isNonEmptyString(track?.created_at) ? track.created_at : null
  };
}

export function sumTrackTotals(tracks) {
  return tracks.reduce(
    (acc, track) => {
      acc.playback_count += toPositiveInteger(track?.playback_count);
      acc.likes          += toPositiveInteger(track?.likes_count);
      acc.comments       += toPositiveInteger(track?.comment_count);
      acc.reposts        += toPositiveInteger(track?.reposts_count);
      acc.downloads      += toPositiveInteger(track?.download_count);
      return acc;
    },
    { playback_count: 0, likes: 0, comments: 0, reposts: 0, downloads: 0 }
  );
}

export function getApiBaseUrl() {
  return API_BASE_URL;
}
