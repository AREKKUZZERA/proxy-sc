export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID;
  const USER_URL = "https://soundcloud.com/arekkuzzera";

  try {
    // 1) resolve user
    const userRes = await fetch(
      `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(USER_URL)}&client_id=${CLIENT_ID}`
    );
    const userData = await userRes.json();

    if (!userRes.ok) {
      return res.status(userRes.status).json({
        error: userData?.error || "Failed to resolve user"
      });
    }

    const userId = userData.id || userData.urn;
    if (!userId) {
      return res.status(500).json({ error: "User id not found" });
    }

    // 2) get user tracks
    const tracksRes = await fetch(
      `https://api-v2.soundcloud.com/users/${userId}/tracks?client_id=${CLIENT_ID}&limit=200`
    );
    const tracksData = await tracksRes.json();

    if (!tracksRes.ok) {
      return res.status(tracksRes.status).json({
        error: tracksData?.error || "Failed to fetch tracks"
      });
    }

    const tracks = Array.isArray(tracksData.collection)
      ? tracksData.collection
      : Array.isArray(tracksData)
      ? tracksData
      : [];

    const totals = tracks.reduce(
      (acc, track) => {
        acc.playback_count += Number(track.playback_count || 0);
        acc.likes += Number(track.likes_count || 0);
        acc.comments += Number(track.comment_count || 0);
        acc.reposts += Number(track.reposts_count || 0);
        acc.downloads += Number(track.download_count || 0);
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

    return res.status(200).json({
      artist: userData.username || "Unknown artist",
      trackCount: tracks.length,
      ...totals,
      tracks: tracks.map((t) => ({
        title: t.title,
        playback_count: Number(t.playback_count || 0),
        likes_count: Number(t.likes_count || 0),
        comment_count: Number(t.comment_count || 0),
        reposts_count: Number(t.reposts_count || 0),
        download_count: Number(t.download_count || 0),
        permalink_url: t.permalink_url || null
      })),
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Internal server error"
    });
  }
}