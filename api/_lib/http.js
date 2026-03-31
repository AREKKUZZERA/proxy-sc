export class AppError extends Error {
  constructor(message, { status = 500, code = "internal_error", details = null, expose = true } = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
  }
}

const DEFAULT_ALLOWED_METHODS = ["GET", "OPTIONS"];

function appendVary(existing, value) {
  const values = new Set(
    String(existing || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );

  values.add(value);
  return Array.from(values).join(", ");
}

function parseAllowedOrigins() {
  const raw = process.env.CORS_ALLOW_ORIGIN?.trim();

  if (!raw) {
    return ["*"];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function applyCors(req, res) {
  const allowedOrigins = parseAllowedOrigins();
  const origin = req?.headers?.origin;

  if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", appendVary(res.getHeader?.("Vary"), "Origin"));
  }

  res.setHeader("Access-Control-Allow-Methods", DEFAULT_ALLOWED_METHODS.join(", "));
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export function handlePreflight(req, res) {
  applyCors(req, res);

  if (req?.method === "OPTIONS") {
    return res.status(204).end();
  }

  return null;
}

export function enforceMethod(req, res, allowedMethods = ["GET"]) {
  const methods = [...new Set([...allowedMethods, "OPTIONS"])]
    .map((method) => method.toUpperCase());
  const requestMethod = String(req?.method || "GET").toUpperCase();

  if (!methods.includes(requestMethod)) {
    res.setHeader("Allow", methods.join(", "));
    applyCors(req, res);
    sendJson(res, 405, {
      error: `Method ${requestMethod} not allowed`,
      code: "method_not_allowed"
    });
    return false;
  }

  return true;
}

export function setCacheHeaders(
  res,
  { browserMaxAge = 0, sMaxAge = 300, staleWhileRevalidate = 86400 } = {}
) {
  res.setHeader(
    "Cache-Control",
    `public, max-age=${browserMaxAge}, s-maxage=${sMaxAge}, stale-while-revalidate=${staleWhileRevalidate}`
  );
}

export function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

export function getQueryValue(req, ...keys) {
  const query = req?.query ?? {};

  for (const key of keys) {
    const value = query?.[key];

    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === "string" && item.trim());
      if (first) {
        return first.trim();
      }
    }

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

export function isAllowedSoundCloudUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    if (!["https:", "http:"].includes(url.protocol)) {
      return false;
    }

    return host === "soundcloud.com" || host.endsWith(".soundcloud.com");
  } catch {
    return false;
  }
}

export function resolveSoundCloudUrl(input, fallbackValue) {
  const candidate = input?.trim() || fallbackValue;

  if (!candidate) {
    throw new AppError("SoundCloud URL is not configured", {
      status: 500,
      code: "configuration_error"
    });
  }

  if (!isAllowedSoundCloudUrl(candidate)) {
    throw new AppError("Only SoundCloud URLs are allowed", {
      status: 400,
      code: "invalid_soundcloud_url",
      details: { received: candidate }
    });
  }

  const url = new URL(candidate);
  url.hash = "";
  url.protocol = "https:";

  return url.toString();
}

export function logError(context, error) {
  const payload = {
    context,
    message: error?.message,
    status: error?.status,
    code: error?.code,
    details: error?.details,
    stack: error?.stack
  };

  console.error(JSON.stringify(payload, null, 2));
}

export function toErrorResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = error?.expose === false
    ? "Internal server error"
    : error?.message || "Internal server error";

  const response = {
    error: message,
    code: error?.code || "internal_error"
  };

  if (process.env.NODE_ENV !== "production" && error?.details) {
    response.details = error.details;
  }

  return { status, payload: response };
}
