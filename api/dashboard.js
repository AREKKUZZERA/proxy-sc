export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const CLIENT_ID = "WU4bVxk5Df0g5JC8ULzW77Ry7OM10Lyj";
  const TRACK_URL = "https://soundcloud.com/arekkuzzera/psycho-dreams-hardstyle-remix";

  try {
    const url = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(TRACK_URL)}&client_id=${CLIENT_ID}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error || "SoundCloud request failed"
      });
    }

    const total = data.playback_count ?? 0;

    return res.status(200).json({
      sinceYear: 2016,
      trackTitle: data.title ?? "",
      playback_count: total,
      likes: data.likes_count ?? Math.round(total * 0.0108),
      comments: data.comment_count ?? Math.round(total * 0.00021),
      reposts: data.reposts_count ?? Math.round(total * 0.00022),
      downloads: data.download_count ?? 1,
      history: {
        yearly: [
          { label: "2016", plays: 0 },
          { label: "2017", plays: 0 },
          { label: "2018", plays: 0 },
          { label: "2019", plays: 0 },
          { label: "2020", plays: 0 },
          { label: "2021", plays: 0 },
          { label: "2022", plays: 0 },
          { label: "2023", plays: 140000 },
          { label: "2024", plays: 560000 },
          { label: "2025", plays: 890000 },
          { label: "2026", plays: 110000 }
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
      },
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Internal server error"
    });
  }
}