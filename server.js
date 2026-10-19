
const http = require("node:http");

const PORT = Number(process.env.PORT) || 3000;
const JIKAN_API = "https://api.jikan.moe/v4";
const MAX_QUERY_LENGTH = 100;
const CACHE_TTL = 60_000;
const cache = new Map();

const SOURCES = [
  {
    name: "Muse Asia",
    url: "https://www.youtube.com/@MuseAsia",
    search: "https://www.youtube.com/@MuseAsia/search?query="
  },
  {
    name: "Ani-One Asia",
    url: "https://www.youtube.com/@AniOneAsia",
    search: "https://www.youtube.com/@AniOneAsia/search?query="
  },
  {
    name: "Crunchyroll",
    url: "https://www.crunchyroll.com/",
    search: "https://www.crunchyroll.com/search?q="
  }
];

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(data, null, 2));
}

function getCache(key) {
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.time > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  cache.set(key, { time: Date.now(), value });

  if (cache.size > 200) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

async function fetchJson(url) {
  const cached = getCache(url);
  if (cached) return cached;

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });

  if (response.status === 429) {
    const error = new Error("The metadata provider is rate-limiting requests.");
    error.status = 429;
    throw error;
  }

  if (!response.ok) {
    const error = new Error("The metadata provider returned an error.");
    error.status = 502;
    throw error;
  }

  const data = await response.json();
  setCache(url, data);
  return data;
}

function mapAnime(item) {
  return {
    id: item.mal_id,
    title: item.title,
    englishTitle: item.title_english || null,
    japaneseTitle: item.title_japanese || null,
    synopsis: item.synopsis || "",
    image: item.images?.jpg?.large_image_url || null,
    score: item.score ?? null,
    episodes: item.episodes ?? null,
    status: item.status || "Unknown",
    year: item.year || item.aired?.prop?.from?.year || null,
    genres: (item.genres || []).map(genre => genre.name),
    metadataUrl: item.url || null
  };
}

function validId(value) {
  return /^\d{1,10}$/.test(value);
}

function officialSources(title) {
  const encoded = encodeURIComponent(title);

  return SOURCES.map(source => ({
    name: source.name,
    channelOrSite: source.url,
    searchUrl: source.search + encoded,
    playback: "Search link only; individual video availability is not verified."
  }));
}

async function route(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  if (req.method !== "GET") {
    return send(res, 405, { error: "GET requests only." });
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  const query = (url.searchParams.get("q") || "").trim();

  try {
    if (path === "/" || path === "/api/health") {
      return send(res, 200, {
        name: "Anime:P API Lab",
        status: "online",
        version: "1.0.0",
        features: [
          "Anime search",
          "Anime details",
          "Episode lists",
          "Official source discovery",
          "YouTube embed URL validation"
        ],
        routes: [
          "GET /api/health",
          "GET /api/search?q=naruto",
          "GET /api/anime/:id",
          "GET /api/anime/:id/episodes?page=1",
          "GET /api/sources?q=naruto",
          "GET /api/embed/youtube/:videoId"
        ]
      });
    }

    if (path === "/api/search") {
      if (!query || query.length > MAX_QUERY_LENGTH) {
        return send(res, 400, {
          error: `Enter a search query of 1-${MAX_QUERY_LENGTH} characters.`
        });
      }

      const apiUrl = new URL(`${JIKAN_API}/anime`);
      apiUrl.searchParams.set("q", query);
      apiUrl.searchParams.set("limit", "12");
      apiUrl.searchParams.set("sfw", "true");

      const result = await fetchJson(apiUrl.toString());

      return send(res, 200, {
        query,
        count: result.data.length,
        results: result.data.map(mapAnime),
        source: "Jikan API / MyAnimeList metadata"
      });
    }

    const detailMatch = path.match(/^\/api\/anime\/(\d+)$/);

    if (detailMatch) {
      const id = detailMatch[1];

      if (!validId(id)) {
        return send(res, 400, { error: "Invalid anime ID." });
      }

      const result = await fetchJson(`${JIKAN_API}/anime/${id}/full`);

      return send(res, 200, {
        anime: mapAnime(result.data)
      });
    }

    const episodesMatch = path.match(
      /^\/api\/anime\/(\d+)\/episodes$/
    );

    if (episodesMatch) {
      const id = episodesMatch[1];
      const page = Number(url.searchParams.get("page") || 1);

      if (!validId(id) || !Number.isInteger(page) || page < 1 || page > 100) {
        return send(res, 400, { error: "Invalid anime ID or page." });
      }

      const result = await fetchJson(
        `${JIKAN_API}/anime/${id}/episodes?page=${page}`
      );

      return send(res, 200, {
        animeId: Number(id),
        page,
        hasNextPage: result.pagination?.has_next_page || false,
        episodes: (result.data || []).map(episode => ({
          number: episode.mal_id,
          title: episode.title || `Episode ${episode.mal_id}`,
          aired: episode.aired || null,
          filler: episode.filler || false,
          recap: episode.recap || false,
          videoUrl: null,
          note: "Metadata only; no video URL is provided by this route."
        }))
      });
    }

    if (path === "/api/sources") {
      if (!query || query.length > MAX_QUERY_LENGTH) {
        return send(res, 400, {
          error: `Enter a title of 1-${MAX_QUERY_LENGTH} characters.`
        });
      }

      return send(res, 200, {
        title: query,
        sources: officialSources(query),
        note: "Search results are not verified for licensing, region, or playback."
      });
    }

    const embedMatch = path.match(
      /^\/api\/embed\/youtube\/([A-Za-z0-9_-]{11})$/
    );

    if (embedMatch) {
      const videoId = embedMatch[1];

      return send(res, 200, {
        provider: "YouTube",
        videoId,
        embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
        note: "An embed URL does not guarantee permission, availability, or playback."
      });
    }

    return send(res, 404, {
      error: "Route not found.",
      help: "Open /api/health to see available routes."
    });
  } catch (error) {
    console.error("API error:", error.message);

    return send(res, error.status || 502, {
      error: error.message || "Unexpected API error.",
      retryable: error.status === 429 || !error.status
    });
  }
}

const server = http.createServer((req, res) => {
  route(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Anime:P API Lab running on port ${PORT}`);
});
