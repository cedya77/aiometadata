import { hasAgeRatingCap } from '../utils/ageRating';
import { mapWithConcurrency } from '../utils/concurrency';
import { envInt } from '../utils/envNumber';

type Kind = 'movie' | 'series';

const ART = [['poster', 'poster'], ['background', 'background'], ['logo', 'logo'], ['landscapePoster', 'landscapePosterUrl']] as const;

const host = (): string => {
  const name = String(process.env.HOST_NAME || '');
  return name.startsWith('http') ? name : `https://${name}`;
};

const withMetaArt = (config: any, kind: Kind): any => ({
  ...config,
  artProviders: { ...(config.artProviders ?? {}), [kind]: { poster: 'meta', background: 'meta', logo: 'meta' } },
});

export async function previewMeta(config: any, userUUID: string, type: Kind, id: string): Promise<any | null> {
  const { cacheWrapMetaSmart } = require('./getCache');
  const { getMeta } = require('./getMeta');
  const { applyMetaArt } = require('./metaArt');
  const scoped = { ...config, userUUID };
  const language = config?.language || 'en-US';
  const result = await cacheWrapMetaSmart(
    userUUID,
    id,
    () => getMeta(type, language, id, scoped, userUUID, false),
    undefined,
    { enableErrorCaching: true, maxRetries: 2, config: scoped },
    type,
    false
  );
  if (!result?.meta) return null;
  const meta = { ...result.meta };
  applyMetaArt(meta, scoped, type, '');
  return meta;
}

async function localizedText(config: any, row: any, kind: Kind, tmdbId: any): Promise<{ name: string; description: string } | null> {
  const language = config?.language || 'en-US';
  if (row._artSource !== 'simkl' || !tmdbId || language.split('-')[0] === 'en') return null;
  const { fetchTmdbDetails, tmdbLocalizedText } = require('./getMeta');
  const data = await fetchTmdbDetails(kind, tmdbId, language, config).catch(() => null);
  return data ? tmdbLocalizedText(data, kind, language) : null;
}

async function titleCard(config: any, row: any, kind: Kind): Promise<any> {
  const { canonicalIds } = require('./jellyfin/canonicalIds');
  const { resolveArtworkForProfile } = require('./getMeta');
  const { applyMetaArt } = require('./metaArt');
  const ids = await canonicalIds({ imdb: row._imdbId, tmdb: row._tmdbId, tvdb: row._tvdbId }, kind, config);
  const request = {
    type: kind,
    ids: { imdbId: ids.imdb, tmdbId: ids.tmdb, tvdbId: ids.tvdb },
    metaProvider: row._artSource,
    providerArt: { poster: row.poster, background: row.background, logo: null, landscape: row.landscapePoster, originalLanguage: row._originalLanguage },
  };
  const [art, text] = await Promise.all([resolveArtworkForProfile(request, config), localizedText(config, row, kind, ids.tmdb)]);
  const missing = ART.filter(([, field]) => !art[field]).map(([name]) => name);
  if (missing.length) {
    const fallback = await resolveArtworkForProfile({ ...request, wanted: missing }, withMetaArt(config, kind));
    for (const [, field] of ART) art[field] = art[field] || fallback[field];
  }
  const card = {
    ...row,
    ...(text?.name ? { name: text.name } : {}),
    ...(text?.description ? { description: text.description } : {}),
    id: ids.imdb || row.id,
    poster: art.poster || row.poster || `${host()}/missing_poster.png`,
    background: art.background || row.background,
    landscapePoster: art.landscapePosterUrl || row.landscapePoster,
    ...(art.logo ? { logo: art.logo } : {}),
    ...(ids.imdb ? { _imdbId: ids.imdb } : {}),
    ...(ids.tmdb ? { _tmdbId: String(ids.tmdb) } : {}),
    ...(ids.tvdb ? { _tvdbId: String(ids.tvdb) } : {}),
  };
  applyMetaArt(card, config, kind, '');
  return card;
}

export async function titleCards(config: any, userUUID: string, rows: any[]): Promise<any[]> {
  const { isAnimeTitle } = require('./jellyfin/canonicalIds');
  const scoped = { ...config, userUUID };
  const full = hasAgeRatingCap(config);
  return mapWithConcurrency(rows, envInt('TITLE_CARD_CONCURRENCY', 8, 1), async (row: any) => {
    const kind: Kind = row.type === 'movie' ? 'movie' : 'series';
    if (full || isAnimeTitle(String(row.id), kind)) {
      return (await previewMeta(config, userUUID, kind, String(row.id)).catch(() => null)) ?? row;
    }
    return titleCard(scoped, row, kind).catch(() => row);
  });
}
