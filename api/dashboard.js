export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const CLIENT_ID = "WU4bVxk5Df0g5JC8ULzW77Ry7OM10Lyj";
  const USER_URL = "https://soundcloud.com/arekkuzzera";

  const MANUAL_ADJUSTMENTS = {
    totals: {
      playback_count: 271858,
      likes: 2759,
      comments: 36,
      reposts: 118,
      downloads: 0
    },

    history: {
      yearly: [
        { label: "2016", plays: 0 },
        { label: "2017", plays: 0 },
        { label: "2018", plays: 0 },
        { label: "2019", plays: 0 },
        { label: "2020", plays: 0 },
        { label: "2021", plays: 0 },
        { label: "2022", plays: 0 },
        { label: "2023", plays: 150000 },
        { label: "2024", plays: 560000 },
        { label: "2025", plays: 910000 },
        { label: "2026", plays: 115564 }
      ],
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

  async function fetchJsonSafe(url, options = {}) {
    const response = await fetch(url, {
      ...options,
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

  try {
    const resolved = await fetchJsonSafe(
      `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(USER_URL)}&client_id=${CLIENT_ID}`
    );

    if (!resolved.response.ok) {
      return res.status(resolved.response.status).json({
        error: resolved.data?.error || `Resolve failed: HTTP ${resolved.response.status}`,
        debug: resolved.data || resolved.text || null
      });
    }

    const user = resolved.data;
    const userId = user?.id;

    if (!userId) {
      return res.status(500).json({
        error: "User ID not found in resolve response",
        debug: user || null
      });
    }

    const tracksResult = await fetchJsonSafe(
      `https://api-v2.soundcloud.com/users/${userId}/tracks?client_id=${CLIENT_ID}&limit=200`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Origin": "https://soundcloud.com",
          "Referer": "https://soundcloud.com/",
          "Sec-Fetch-Site": "same-site",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty"
        }
      }
    );

    if (!tracksResult.response.ok) {
      return res.status(tracksResult.response.status).json({
        error: tracksResult.data?.error || `Tracks request failed: HTTP ${tracksResult.response.status}`,
        debug: tracksResult.data || tracksResult.text || null
      });
    }

    const payload = tracksResult.data;
    const tracks = Array.isArray(payload?.collection)
      ? payload.collection
      : Array.isArray(payload)
        ? payload
        : [];

    const totals = tracks.reduce(
      (acc, track) => {
        acc.playback_count += Number(track?.playback_count || 0);
        acc.likes += Number(track?.likes_count || 0);
        acc.comments += Number(track?.comment_count || 0);
        acc.reposts += Number(track?.reposts_count || 0);
        acc.downloads += Number(track?.download_count || 0);
        return acc;
      },
      {
        playback_count: 0,
        likes: 0,
        comments: 0,
        reposts: 0,
        downloads: 0
      }
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
        permalink_url: track?.permalink_url || null
      }))
      .sort((a, b) => b.playback_count - a.playback_count);

    return res.status(200).json({
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
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Internal server error"
    });
  }
}