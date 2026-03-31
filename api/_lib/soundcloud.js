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

const tokenCache = {
  accessToken: null,
  expiresAt: 0,
  inFlight: null
};

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toPositiveInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
    }
  };
}

function toBasicAuthHeader(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

async function parseResponse(response) {
  const text = await response.text();
  let data = null;

  if (text && text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  return { response, text, data };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const { signal, cleanup } = createTimeoutSignal(timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError("SoundCloud request timed out", {
        status: 504,
        code: "soundcloud_timeout"
      });
    }

    throw new AppError("Failed to reach SoundCloud", {
      status: 502,
      code: "soundcloud_unreachable",
      details: { cause: error?.message || String(error) }
    });
  } finally {
    cleanup();
  }
}

async function exchangeClientCredentialsToken(clientId, clientSecret) {
  const response = await fetchWithTimeout(
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: toBasicAuthHeader(clientId, clientSecret)
      },
      body: new URLSearchParams({ grant_type: "client_credentials" })
    },
    REQUEST_TIMEOUT_MS
  );

  const parsed = await parseResponse(response);

  if (!parsed.response.ok) {
    throw new AppError("SoundCloud token request failed", {
      status: 502,
      code: "soundcloud_auth_failed",
      details: parsed.data || parsed.text || null
    });
  }

  const accessToken = parsed.data?.access_token;
  const expiresIn = toPositiveInteger(parsed.data?.expires_in, 3600);

  if (!isNonEmptyString(accessToken)) {
    throw new AppError("SoundCloud token response did not contain an access token", {
      status: 502,
      code: "soundcloud_auth_invalid_response",
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
      .finally(() => {
        tokenCache.inFlight = null;
      });
  }

  return tokenCache.inFlight;
}

export async function getSoundCloudAuth() {
  const manualAccessToken = process.env.SOUNDCLOUD_ACCESS_TOKEN?.trim();
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID?.trim();
  const clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET?.trim();

  if (isNonEmptyString(manualAccessToken)) {
    return {
      mode: "access_token",
      headers: { Authorization: `Bearer ${manualAccessToken}` },
      query: {}
    };
  }

  if (isNonEmptyString(clientId) && isNonEmptyString(clientSecret)) {
    const accessToken = await getAccessTokenFromCredentials(clientId, clientSecret);

    return {
      mode: "client_credentials",
      headers: { Authorization: `Bearer ${accessToken}` },
      query: {}
    };
  }

  const fallbackClientId = clientId || LEGACY_FALLBACK_CLIENT_ID;

  if (!isNonEmptyString(fallbackClientId)) {
    throw new AppError("SoundCloud credentials are not configured", {
      status: 500,
      code: "configuration_error"
    });
  }

  return {
    mode: clientId ? "client_id" : "legacy_client_id_fallback",
    headers: {},
    query: { client_id: fallbackClientId }
  };
}

function buildRequestUrl(pathOrUrl, extraQuery = {}) {
  const url = pathOrUrl.startsWith("http")
    ? new URL(pathOrUrl)
    : new URL(pathOrUrl, `${API_BASE_URL}/`);

  for (const [key, value] of Object.entries(extraQuery)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function createUpstreamError(message, parsed) {
  return new AppError(message, {
    status: parsed.response.status || 502,
    code: "soundcloud_upstream_error",
    details: parsed.data || parsed.text || null
  });
}

export async function soundCloudFetchJson(pathOrUrl, { query = {}, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const auth = await getSoundCloudAuth();
  const url = buildRequestUrl(pathOrUrl, { ...query, ...auth.query });

  const response = await fetchWithTimeout(
    url.toString(),
    {
      headers: {
        ...auth.headers,
        ...headers
      }
    },
    timeoutMs
  );

  const parsed = await parseResponse(response);
  return { ...parsed, authMode: auth.mode, url: url.toString() };
}

export async function resolveResource(resourceUrl, { expectedKinds = [] } = {}) {
  const parsed = await soundCloudFetchJson("/resolve", {
    query: { url: resourceUrl }
  });

  if (!parsed.response.ok) {
    throw createUpstreamError("Failed to resolve SoundCloud URL", parsed);
  }

  const kind = String(parsed.data?.kind || "").toLowerCase();

  if (expectedKinds.length > 0 && kind && !expectedKinds.map((item) => item.toLowerCase()).includes(kind)) {
    throw new AppError(`Unexpected SoundCloud resource type: ${kind || "unknown"}`, {
      status: 422,
      code: "unexpected_soundcloud_resource",
      details: { expectedKinds, receivedKind: kind || null }
    });
  }

  return { data: parsed.data, authMode: parsed.authMode };
}

export async function fetchCollection(pathOrUrl) {
  const items = [];
  let nextUrl = pathOrUrl;
  let authMode = null;

  for (let page = 0; page < MAX_COLLECTION_PAGES; page += 1) {
    const parsed = await soundCloudFetchJson(nextUrl, {
      query: {
        linked_partitioning: true,
        ...(page === 0 ? { limit: PAGE_LIMIT } : {})
      }
    });

    authMode ||= parsed.authMode;

    if (!parsed.response.ok) {
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
  }

  throw new AppError(`SoundCloud pagination exceeded the configured maximum of ${MAX_COLLECTION_PAGES} pages`, {
    status: 502,
    code: "soundcloud_pagination_limit"
  });
}

export function normalizeTrack(track) {
  return {
    id: track?.id ?? track?.urn ?? null,
    title: isNonEmptyString(track?.title) ? track.title.trim() : "Untitled",
    playback_count: toPositiveInteger(track?.playback_count),
    likes_count: toPositiveInteger(track?.likes_count ?? track?.favoritings_count),
    comment_count: toPositiveInteger(track?.comment_count),
    reposts_count: toPositiveInteger(track?.reposts_count),
    download_count: toPositiveInteger(track?.download_count),
    permalink_url: isNonEmptyString(track?.permalink_url) ? track.permalink_url : null,
    artwork_url: isNonEmptyString(track?.artwork_url)
      ? track.artwork_url
      : (isNonEmptyString(track?.user?.avatar_url) ? track.user.avatar_url : null),
    created_at: isNonEmptyString(track?.created_at) ? track.created_at : null
  };
}

export function sumTrackTotals(tracks) {
  return tracks.reduce(
    (accumulator, track) => {
      accumulator.playback_count += toPositiveInteger(track?.playback_count);
      accumulator.likes += toPositiveInteger(track?.likes_count);
      accumulator.comments += toPositiveInteger(track?.comment_count);
      accumulator.reposts += toPositiveInteger(track?.reposts_count);
      accumulator.downloads += toPositiveInteger(track?.download_count);
      return accumulator;
    },
    {
      playback_count: 0,
      likes: 0,
      comments: 0,
      reposts: 0,
      downloads: 0
    }
  );
}

export function getApiBaseUrl() {
  return API_BASE_URL;
}
