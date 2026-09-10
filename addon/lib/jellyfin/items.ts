import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { encodeJellyfinId, parseStremioId } from './ids';
import { EMPTY_USER_DATA } from './dto';
import { placeholderSources } from './streams';
import redis from '../redisClient';
import type { CatalogRef } from './views';

const logger = consola.withTag('Jellyfin');

const TICKS_PER_MS = 10000;

export interface ItemImages {
  primary?: string;
  backdrop?: string;
  logo?: string;
  thumb?: string;
}

const imageCache = new LRUCache<string, ItemImages>({
  max: envInt('JELLYFIN_IMAGE_CACHE_MAX', 20000, 1),
  ttl: envInt('JELLYFIN_IMAGE_MEMO_TTL', 6 * 60 * 60, 60) * 1000,
});

/**
 * Scoped per server id, which is derived from the configuration: art depends on
 * a user's providers and language, so two configurations must not read each
 * other's. Held in Redis as well as in process, because a client keeps its item
 * ids across a restart and asks for their art before anything has rebuilt them.
 */
function imageKey(scope: string, itemId: string): string {
  return `${scope}|${itemId}`;
}

function imageTtl(): number {
  return envInt('JELLYFIN_IMAGE_CACHE_TTL', 7 * 24 * 60 * 60, 60);
}

export function rememberImages(scope: string, itemId: string, images: ItemImages): void {
  if (!images.primary && !images.backdrop && !images.logo && !images.thumb) return;

  const key = imageKey(scope, itemId);
  imageCache.set(key, images);

  if (redis) {
    redis
      .set(`jf:img:${key}`, JSON.stringify(images), 'EX', imageTtl())
      .catch(() => undefined);
  }
}

export async function recallImages(scope: string, itemId: string): Promise<ItemImages | undefined> {
  const key = imageKey(scope, itemId);
  const local = imageCache.get(key);
  if (local) return local;

  if (!redis) return undefined;

  try {
    const stored = await redis.get(`jf:img:${key}`);
    if (!stored) return undefined;
    const images = JSON.parse(stored) as ItemImages;
    imageCache.set(key, images);
    return images;
  } catch {
    return undefined;
  }
}

function localBase(): string {
  return `http://127.0.0.1:${process.env.PORT || '3232'}`;
}

/**
 * The catalog route owns id normalisation, per-source dispatch, cursors and
 * poster resolution. Going through it over loopback keeps the Jellyfin surface
 * and the Stremio surface on identical data instead of a second copy of that
 * dispatch drifting out of step.
 */
export async function fetchCatalogPage(
  userUUID: string,
  type: string,
  catalogId: string,
  extras: Record<string, string> = {}
): Promise<any[]> {
  const parts = Object.entries(extras)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  const extraSegment = parts.length ? `/${parts.join('&')}` : '';
  const url = `${localBase()}/stremio/${encodeURIComponent(userUUID)}/catalog/${encodeURIComponent(type)}/${encodeURIComponent(catalogId)}${extraSegment}.json`;

  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      logger.debug(`Catalog ${type}/${catalogId} returned ${response.status}`);
      return [];
    }
    const body: any = await response.json();
    return Array.isArray(body?.metas) ? body.metas : [];
  } catch (error: any) {
    logger.warn(`Catalog ${type}/${catalogId} failed: ${error?.message || error}`);
    return [];
  }
}

export interface Window {
  items: any[];
  hasMore: boolean;
}

function maxPages(): number {
  return envInt('JELLYFIN_CATALOG_MAX_PAGES', 10, 1);
}

const pageLengths = new LRUCache<string, number>({
  max: envInt('JELLYFIN_PAGE_LENGTH_CACHE_MAX', 2000, 1),
});

/**
 * `skip` is an absolute offset, but the catalog route rounds it up to a whole
 * page for a stable cache key, so an offset landing mid-page silently loses the
 * items before the next boundary. Stremio never hits that because it advances
 * skip by what it was handed; a Jellyfin client picks offsets from its own grid.
 *
 * Asking only on boundaries and trimming the remainder here keeps every request
 * on the page numbers the warmer already wrote.
 */
export async function fetchWindow(
  userUUID: string,
  catalog: CatalogRef,
  startIndex: number,
  limit: number,
  extras: Record<string, string> = {},
  keep?: (meta: any) => boolean
): Promise<Window> {
  const lengthKey = `${catalog.type}|${catalog.id}|${extras.genre ?? ''}|${extras.search ?? ''}`;
  let pageLength = pageLengths.get(lengthKey);

  if (!pageLength && startIndex > 0) {
    const probe = await fetchCatalogPage(userUUID, catalog.type, catalog.id, extras);
    if (probe.length > 0) {
      pageLength = probe.length;
      pageLengths.set(lengthKey, pageLength);
    }
  }

  const alignedSkip = pageLength ? Math.floor(startIndex / pageLength) * pageLength : startIndex;
  let offset = startIndex - alignedSkip;

  const collected: any[] = [];
  const seen = new Set<string>();
  let skip = alignedSkip;
  let pages = 0;
  let exhausted = false;

  while (collected.length < offset + limit && pages < maxPages()) {
    const page = await fetchCatalogPage(userUUID, catalog.type, catalog.id, {
      ...extras,
      ...(skip > 0 ? { skip: String(skip) } : {}),
    });
    pages++;

    if (page.length === 0) {
      exhausted = true;
      break;
    }

    if (pages === 1 && !pageLength) {
      pageLength = page.length;
      pageLengths.set(lengthKey, pageLength);
    }

    for (const meta of page) {
      const key = meta?.id ? String(meta.id) : null;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      // Filtered here rather than after the window is cut, so a start index
      // counts the items a client actually receives. A movie list holding a
      // series would otherwise return a short page, which reads as the end.
      if (keep && !keep(meta)) continue;
      collected.push(meta);
    }

    skip += page.length;
  }

  // Duplicates are dropped above, so trimming by count would cut into the window
  // itself; the offset only ever covers items that came before startIndex.
  if (offset > collected.length) offset = collected.length;

  return {
    items: collected.slice(offset, offset + limit),
    hasMore: !exhausted && collected.length >= offset + limit,
  };
}

function parseRuntimeTicks(runtime: any): number | null {
  if (typeof runtime !== 'string') return null;
  const hours = /(\d+)\s*h/.exec(runtime);
  const minutes = /(\d+)\s*min/.exec(runtime);
  const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  return total > 0 ? total * 60 * 1000 * TICKS_PER_MS : null;
}

function parseRating(value: any): number | null {
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function providerIds(meta: any): Record<string, string> {
  const ids: Record<string, string> = {};
  if (meta._imdbId || meta.imdb_id) ids.Imdb = String(meta._imdbId || meta.imdb_id);
  if (meta._tmdbId) ids.Tmdb = String(meta._tmdbId);
  if (meta._tvdbId) ids.Tvdb = String(meta._tvdbId);
  return ids;
}

function peopleFrom(meta: any, serverId: string): any[] {
  const cast = Array.isArray(meta.app_extras?.cast) ? meta.app_extras.cast : [];
  const people = cast.slice(0, 20).map((member: any) => {
    const id = encodeJellyfinId({ k: 'person', n: String(member?.name || '') });
    // A client only asks for a portrait when the tag is present, so registering
    // the photo and setting it have to happen together.
    if (member?.photo) rememberImages(serverId, id, { primary: member.photo });
    return {
      Name: member?.name,
      Id: id,
      Role: member?.character || member?.role || '',
      Type: 'Actor',
      PrimaryImageTag: member?.photo ? 'p' : undefined,
    };
  });

  for (const director of Array.isArray(meta.director) ? meta.director : []) {
    people.push({
      Name: director,
      Id: encodeJellyfinId({ k: 'person', n: String(director) }),
      Role: '',
      Type: 'Director',
      PrimaryImageTag: undefined,
    });
  }

  return people.filter((p: any) => p.Name);
}

function premiereDate(meta: any): string | null {
  if (typeof meta.released === 'string' && meta.released) return meta.released;
  const year = parseInt(String(meta.year || meta.releaseInfo || ''), 10);
  return Number.isFinite(year) ? new Date(Date.UTC(year, 0, 1)).toISOString() : null;
}

function productionYear(meta: any): number | null {
  const raw = String(meta.year || meta.releaseInfo || '').slice(0, 4);
  const year = parseInt(raw, 10);
  return Number.isFinite(year) ? year : null;
}

export function jellyfinTypeFor(metaType: string): 'Movie' | 'Series' {
  return metaType === 'movie' || metaType === 'anime.movie' ? 'Movie' : 'Series';
}

export function metaToBaseItem(
  meta: any,
  mediaType: string,
  serverId: string,
  parentId: string | null
): any {
  const itemType = jellyfinTypeFor(meta.type || mediaType);
  const kind = itemType === 'Movie' ? 'movie' : 'series';
  const id = encodeJellyfinId({ k: kind, t: mediaType, i: String(meta.id) });

  const images: ItemImages = {
    primary: meta.poster || undefined,
    backdrop: meta.background || undefined,
    logo: meta.logo || undefined,
    thumb: meta.landscapePoster || undefined,
  };
  rememberImages(serverId, id, images);

  const imageTags: Record<string, string> = {};
  if (images.primary) imageTags.Primary = 'p';
  if (images.logo) imageTags.Logo = 'l';
  if (images.thumb) imageTags.Thumb = 't';

  return {
    Name: meta.name,
    Id: id,
    ServerId: serverId,
    Etag: id,
    Type: itemType,
    MediaType: itemType === 'Movie' ? 'Video' : 'Unknown',
    IsFolder: itemType === 'Series',
    ParentId: parentId,
    Overview: meta.description || null,
    ProductionYear: productionYear(meta),
    PremiereDate: premiereDate(meta),
    Genres: Array.isArray(meta.genres) ? meta.genres : [],
    GenreItems: (Array.isArray(meta.genres) ? meta.genres : []).map((g: string) => ({
      Name: g,
      Id: encodeJellyfinId({ k: 'genre', t: mediaType, c: 'all', g }),
    })),
    CommunityRating: parseRating(meta.imdbRating),
    OfficialRating: meta.app_extras?.certification || null,
    RunTimeTicks: parseRuntimeTicks(meta.runtime),
    ProviderIds: providerIds(meta),
    People: peopleFrom(meta, serverId),
    Studios: [],
    Taglines: [],
    RemoteTrailers: (Array.isArray(meta.trailerStreams) ? meta.trailerStreams : [])
      .slice(0, 5)
      .map((t: any) => ({ Name: t?.title, Url: t?.ytId ? `https://www.youtube.com/watch?v=${t.ytId}` : undefined }))
      .filter((t: any) => t.Url),
    ImageTags: imageTags,
    BackdropImageTags: images.backdrop ? ['b'] : [],
    ImageBlurHashes: {},
    UserData: { ...EMPTY_USER_DATA, Key: id },
    LocationType: 'FileSystem',
    PrimaryImageAspectRatio: itemType === 'Movie' ? 0.6666666666666666 : 0.6666666666666666,
    CanDelete: false,
    CanDownload: false,
    PlayAccess: 'Full',
    LockedFields: [],
    LockData: false,
    ChildCount: null,
    ...(itemType === 'Movie'
      ? { EnableMediaSourceDisplay: true, MediaSources: placeholderSources(id) }
      : {}),
  };
}

/** The same decision filterByIncludeTypes makes, taken on a meta. */
export function includeTypesFilter(
  mediaType: string,
  includeItemTypes: string | undefined
): ((meta: any) => boolean) | undefined {
  if (!includeItemTypes) return undefined;

  const wanted = new Set(includeItemTypes.split(',').map((t) => t.trim()).filter(Boolean));
  if (!wanted.size || (!wanted.has('Movie') && !wanted.has('Series'))) return undefined;

  return (meta: any) => wanted.has(jellyfinTypeFor(meta?.type || mediaType));
}

export function filterByIncludeTypes(items: any[], includeItemTypes: string | undefined): any[] {
  if (!includeItemTypes) return items;
  const wanted = new Set(
    includeItemTypes.split(',').map((t) => t.trim()).filter(Boolean)
  );
  if (wanted.size === 0) return items;
  return items.filter((item) => wanted.has(item.Type));
}

export async function fetchMeta(
  userUUID: string,
  stremioType: string,
  id: string
): Promise<any | null> {
  const url = `${localBase()}/stremio/${encodeURIComponent(userUUID)}/meta/${encodeURIComponent(stremioType)}/${encodeURIComponent(id)}.json`;
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      logger.debug(`Meta ${stremioType}/${id} returned ${response.status}`);
      return null;
    }
    const body: any = await response.json();
    return body?.meta ?? null;
  } catch (error: any) {
    logger.warn(`Meta ${stremioType}/${id} failed: ${error?.message || error}`);
    return null;
  }
}

function seasonNumbersFrom(videos: any[]): number[] {
  const seasons = new Set<number>();
  for (const video of videos) {
    if (Number.isInteger(video?.season)) seasons.add(video.season);
  }
  return [...seasons].sort((a, b) => a - b);
}

export function buildSeasons(
  meta: any,
  mediaType: string,
  seriesId: string,
  serverId: string
): any[] {
  const videos = Array.isArray(meta?.videos) ? meta.videos : [];
  const numbers = seasonNumbersFrom(videos);

  // The posters arrive as a bare list with the season numbers dropped, so they
  // are only trusted when there is exactly one for each season the meta
  // publishes. Anything else falls back to the series poster rather than
  // hanging the wrong season's art on a season.
  const posters = Array.isArray(meta?.app_extras?.seasonPosters) ? meta.app_extras.seasonPosters : [];
  const aligned = posters.length === numbers.length;

  return numbers.map((season, index) => {
    const id = encodeJellyfinId({ k: 'season', t: mediaType, i: String(meta.id), s: season });
    const episodes = videos.filter((v: any) => v.season === season);

    const primary = (aligned ? posters[index] : undefined) || meta.poster || undefined;
    if (primary) rememberImages(serverId, id, { primary, backdrop: meta.background || undefined });

    return {
      Name: season === 0 ? 'Specials' : `Season ${season}`,
      Id: id,
      ServerId: serverId,
      Etag: id,
      Type: 'Season',
      MediaType: 'Unknown',
      IsFolder: true,
      ParentId: seriesId,
      SeriesId: seriesId,
      SeriesName: meta.name,
      IndexNumber: season,
      ChildCount: episodes.length,
      RecursiveItemCount: episodes.length,
      UserData: { ...EMPTY_USER_DATA, Key: id },
      ImageTags: primary ? { Primary: 'p' } : {},
      BackdropImageTags: [],
      ImageBlurHashes: {},
      LocationType: 'FileSystem',
      PrimaryImageAspectRatio: 0.6666666666666666,
      CanDelete: false,
      CanDownload: false,
    };
  });
}

export function buildEpisodes(
  meta: any,
  mediaType: string,
  seriesId: string,
  serverId: string,
  season: number | null
): any[] {
  const videos = Array.isArray(meta?.videos) ? meta.videos : [];
  const wanted = season === null ? videos : videos.filter((v: any) => v.season === season);

  return wanted.map((video: any) => {
    const hasSeason = Number.isInteger(video.season);

    // A video carries its own id, and it is not always built from the series
    // one: a MAL series (mal:52991) publishes kitsu:46474:1 episodes. Identity
    // comes from that id so it rebuilds to what a stream addon was given, while
    // season and episode numbering stay with the video for display.
    const parsed = parseStremioId(String(video.id ?? ''));
    const id = encodeJellyfinId(
      parsed
        ? { k: 'episode', t: mediaType, i: parsed.base, s: parsed.season, e: parsed.episode as number }
        : {
            k: 'episode',
            t: mediaType,
            i: String(meta.id),
            s: hasSeason ? video.season : null,
            e: Number(video.episode),
          }
    );
    const parentSeasonId = hasSeason
      ? encodeJellyfinId({ k: 'season', t: mediaType, i: String(meta.id), s: video.season })
      : seriesId;

    if (video.thumbnail) rememberImages(serverId, id, { primary: video.thumbnail });

    return {
      Name: video.title || `Episode ${video.episode}`,
      Id: id,
      ServerId: serverId,
      Etag: id,
      Type: 'Episode',
      MediaType: 'Video',
      IsFolder: false,
      ParentId: parentSeasonId,
      SeasonId: hasSeason ? parentSeasonId : null,
      SeriesId: seriesId,
      SeriesName: meta.name,
      ParentIndexNumber: hasSeason ? video.season : null,
      IndexNumber: Number(video.episode),
      Overview: video.overview || null,
      PremiereDate: video.released || null,
      RunTimeTicks: parseRuntimeTicks(video.runtime),
      ProviderIds: {},
      ImageTags: video.thumbnail ? { Primary: 'p' } : {},
      BackdropImageTags: [],
      ImageBlurHashes: {},
      UserData: { ...EMPTY_USER_DATA, Key: id },
      LocationType: 'FileSystem',
      PrimaryImageAspectRatio: 1.7777777777777777,
      CanDelete: false,
      CanDownload: false,
      LockedFields: [],
      LockData: false,
      EnableMediaSourceDisplay: true,
      MediaSources: placeholderSources(id),
    };
  });
}
