import {
  applyCors,
  enforceMethod,
  getQueryValue,
  handlePreflight,
  logError,
  resolveSoundCloudUrl,
  sendJson,
  setCacheHeaders,
  toErrorResponse
} from "./_lib/http.js";
import { normalizeTrack, resolveResource } from "./_lib/soundcloud.js";

const DEFAULT_TRACK_URL = process.env.SOUNDCLOUD_TRACK_URL?.trim() || "https://soundcloud.com/arekkuzzera/psycho-dreams-hardstyle-remix";

export default async function handler(req, res) {
  applyCors(req, res);

  const preflightResult = handlePreflight(req, res);
  if (preflightResult) {
    return preflightResult;
  }

  if (!enforceMethod(req, res, ["GET"])) {
    return null;
  }

  try {
    const requestedUrl = getQueryValue(req, "url", "track_url", "trackUrl");
    const trackUrl = resolveSoundCloudUrl(requestedUrl, DEFAULT_TRACK_URL);
    const { data: track, authMode } = await resolveResource(trackUrl, { expectedKinds: ["track"] });
    const normalizedTrack = normalizeTrack(track);

    setCacheHeaders(res, {
      browserMaxAge: 0,
      sMaxAge: 60,
      staleWhileRevalidate: 300
    });

    return sendJson(res, 200, {
      playback_count: normalizedTrack.playback_count,
      title: normalizedTrack.title,
      likes: normalizedTrack.likes_count,
      comment_count: normalizedTrack.comment_count,
      reposts_count: normalizedTrack.reposts_count,
      download_count: normalizedTrack.download_count,
      permalink_url: normalizedTrack.permalink_url,
      artwork_url: normalizedTrack.artwork_url,
      updatedAt: new Date().toISOString(),
      meta: {
        requestedTrackUrl: trackUrl,
        authMode
      }
    });
  } catch (error) {
    logError("plays", error);
    const { status, payload } = toErrorResponse(error);
    return sendJson(res, status, payload);
  }
}
