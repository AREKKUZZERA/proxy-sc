export default async function handler(req, res) {
  const CLIENT_ID = "WU4bVxk5Df0g5JC8ULzW77Ry7OM10Lyj";
  const TRACK_URL = "https://soundcloud.com/arekkuzzera/psycho-dreams-hardstyle-remix";

  try {
    const url =
      `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(TRACK_URL)}&client_id=${CLIENT_ID}`;

    const response = await fetch(url);
    const data = await response.json();

    return res.status(200).json({
      playback_count: data.playback_count ?? null
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}