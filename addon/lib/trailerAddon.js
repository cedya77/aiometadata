const TIMEOUT_MS = 4000;

// A Stremio addon's manifest URL carries its own configuration, so the stream
// endpoint is derived from it rather than assembled here. Streailer answers a
// wrongly-shaped config path with 200 and its default language, so a URL built
// here could ignore the user's setting without failing.
function toStreamUrl(manifestUrl, type, id) {
  if (typeof manifestUrl !== 'string' || !manifestUrl.trim()) return null;
  const trimmed = manifestUrl.trim();
  if (!trimmed.endsWith('/manifest.json')) return null;
  return `${trimmed.slice(0, -'manifest.json'.length)}stream/${type}/${encodeURIComponent(id)}.json`;
}

async function getAddonTrailers(manifestUrl, type, id, logger) {
  if (!id || (type !== 'movie' && type !== 'series')) return null;

  const url = toStreamUrl(manifestUrl, type, id);
  if (!url) return null;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      logger?.debug?.(`[trailerAddon] ${res.status} for ${type} ${id}`);
      return null;
    }

    const body = await res.json();
    const streams = Array.isArray(body?.streams) ? body.streams : [];
    const withIds = streams.filter((s) => typeof s?.ytId === 'string' && s.ytId.length > 0);
    if (withIds.length === 0) return null;

    return {
      trailers: withIds.map((s) => ({ source: s.ytId, type: 'Trailer' })),
      trailerStreams: withIds.map((s) => ({ title: s.title || 'Trailer', ytId: s.ytId }))
    };
  } catch (err) {
    logger?.debug?.(`[trailerAddon] request failed for ${type} ${id}: ${err?.message ?? err}`);
    return null;
  }
}

// Stremio plays from trailerStreams; providers that fill only `trailers` leave it
// empty and the client takes another addon's trailer instead.
function toTrailerStreams(trailers) {
  if (!Array.isArray(trailers)) return [];
  return trailers
    .filter((trailer) => trailer?.source)
    .map((trailer) => ({ title: trailer.name || 'Trailer', ytId: trailer.source }));
}

module.exports = { getAddonTrailers, toStreamUrl, toTrailerStreams };
