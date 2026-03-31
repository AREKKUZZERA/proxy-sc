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
import {
  fetchCollection,
  getApiBaseUrl,
  normalizeTrack,
  resolveResource,
  sumTrackTotals
} from "./_lib/soundcloud.js";

const DEFAULT_USER_URL = process.env.SOUNDCLOUD_USER_URL?.trim() || "https://soundcloud.com/arekkuzzera";
const INCLUDE_MANUAL_ADJUSTMENTS = process.env.DASHBOARD_INCLUDE_MANUAL_ADJUSTMENTS !== "false";

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
    if (index === 0) {
      return { label: item.label, plays: item.total };
    }

    const previousTotal = items[index - 1].total;
    return {
      label: item.label,
      plays: Math.max(item.total - previousTotal, 0)
    };
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
    daily: Array.from({ length: 14 }, (_, index) => ({
      label: String(index + 1),
      plays: 2000 + index * 180
    }))
  }
};

function addTotals(liveTotals, manualTotals) {
  return {
    playback_count: liveTotals.playback_count + manualTotals.playback_count,
    likes: liveTotals.likes + manualTotals.likes,
    comments: liveTotals.comments + manualTotals.comments,
    reposts: liveTotals.reposts + manualTotals.reposts,
    downloads: liveTotals.downloads + manualTotals.downloads
  };
}

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
    const requestedUrl = getQueryValue(req, "url", "user_url", "userUrl");
    const userUrl = resolveSoundCloudUrl(requestedUrl, DEFAULT_USER_URL);

    const { data: user, authMode } = await resolveResource(userUrl, { expectedKinds: ["user"] });
    const userId = user?.id;

    if (!userId) {
      throw new Error("SoundCloud resolve response did not contain a user id");
    }

    const collectionPath = `/users/${encodeURIComponent(String(userId))}/tracks`;
    const { items, authMode: collectionAuthMode } = await fetchCollection(collectionPath);

    const normalizedTracks = items
      .map(normalizeTrack)
      .sort((left, right) => right.playback_count - left.playback_count);

    const liveTotals = sumTrackTotals(normalizedTracks);
    const manualTotals = INCLUDE_MANUAL_ADJUSTMENTS
      ? MANUAL_ADJUSTMENTS.totals
      : { playback_count: 0, likes: 0, comments: 0, reposts: 0, downloads: 0 };

    const finalTotals = addTotals(liveTotals, manualTotals);

    setCacheHeaders(res, {
      browserMaxAge: 0,
      sMaxAge: 300,
      staleWhileRevalidate: 86400
    });

    return sendJson(res, 200, {
      artist: user?.username || "AREKKUZZERA",
      trackCount: normalizedTracks.length,
      sinceYear: 2016,
      trackTitle: `${user?.username || "Artist"} — All Tracks`,
      playback_count: finalTotals.playback_count,
      likes: finalTotals.likes,
      comments: finalTotals.comments,
      reposts: finalTotals.reposts,
      downloads: finalTotals.downloads,
      history: INCLUDE_MANUAL_ADJUSTMENTS
        ? MANUAL_ADJUSTMENTS.history
        : { yearly: [], monthly: [], daily: [] },
      tracks: normalizedTracks,
      updatedAt: new Date().toISOString(),
      meta: {
        apiBaseUrl: getApiBaseUrl(),
        requestedUserUrl: userUrl,
        authMode: collectionAuthMode || authMode,
        manualAdjustmentsApplied: INCLUDE_MANUAL_ADJUSTMENTS,
        historyIsSynthetic: INCLUDE_MANUAL_ADJUSTMENTS
      }
    });
  } catch (error) {
    logError("dashboard", error);
    const { status, payload } = toErrorResponse(error);
    return sendJson(res, status, payload);
  }
}
