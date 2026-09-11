const idMapper: any = require('./id-mapper');

interface NormalizedRating {
  imdb: string;
  rating: number;
  ratedAt: string;
  title: string;
  year: number | null;
}

const IMDB_HEADER =
  'Const,Your Rating,Date Rated,Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors';

function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// MovieLens rejects the whole file over a single malformed row, so only a
// well-formed id gets through.
function normalizeImdb(raw: any): string | null {
  return imdbIdsIn(raw)[0] ?? null;
}

// Simkl keeps a multi-part anime film as one entry and lists every part's IMDb
// id in the field, comma separated.
function imdbIdsIn(raw: any): string[] {
  if (raw === null || raw === undefined) return [];
  const ids: string[] = [];
  for (const match of String(raw).matchAll(/(?:^|[^0-9])(?:tt)?(\d{5,10})(?![0-9])/g)) {
    const id = `tt${match[1]}`;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function validRating(r: any): boolean {
  return typeof r === 'number' && r >= 1 && r <= 10;
}

function fromMovieRatingItems(items: any[]): NormalizedRating[] {
  const out: NormalizedRating[] = [];
  for (const it of items || []) {
    const imdb = normalizeImdb(it?.movie?.ids?.imdb);
    const rating = it?.rating;
    if (!imdb || !validRating(rating)) continue;
    out.push({
      imdb,
      rating,
      ratedAt: it?.rated_at || '',
      title: it?.movie?.title || '',
      year: it?.movie?.year ?? null,
    });
  }
  return out;
}

/** The anime_type values the rest of the codebase reads as a film rather than a series. */
const ANIME_FILM_TYPES = new Set(['movie', 'ona']);

function mappedFilmImdb(ids: any): string | null {
  if (!ids) return null;
  const simklId = ids.simkl ?? ids.simkl_id;
  const mapping =
    (simklId && idMapper.getMappingBySimklId(simklId))
    || (ids.mal && idMapper.getMappingByMalId(ids.mal))
    || (ids.anidb && idMapper.getMappingByAnidbId(ids.anidb))
    || (ids.anilist && idMapper.getMappingByAnilistId(ids.anilist))
    || (ids.kitsu && idMapper.getMappingByKitsuId(ids.kitsu))
    || null;
  if (!mapping?.imdb_id) return null;
  if (!ANIME_FILM_TYPES.has(String(mapping.type || '').toLowerCase())) return null;
  return normalizeImdb(mapping.imdb_id);
}

/**
 * Handles both ratings buckets. Anime is wrapped in `show` whatever its
 * anime_type, so a film there would otherwise be read as a series and dropped.
 * An entry whose anime_type Simkl does not know is kept: the worst a series
 * costs is a CSV row MovieLens finds no movie for, while dropping it loses a
 * rating for good.
 */
function fromSimklRatings(items: any[]): NormalizedRating[] {
  const out: NormalizedRating[] = [];
  for (const it of items || []) {
    if (it?.anime_type && !ANIME_FILM_TYPES.has(it.anime_type)) continue;
    const media = it?.movie || it?.show;
    const rating = it?.user_rating ?? it?.rating;
    if (!validRating(rating)) continue;

    // A rating given to the entry as a whole is a rating of each of its parts.
    let imdbIds = imdbIdsIn(media?.ids?.imdb);
    if (imdbIds.length === 0) {
      const mapped = mappedFilmImdb(media?.ids);
      if (mapped) imdbIds = [mapped];
    }
    for (const imdb of imdbIds) {
      out.push({
        imdb,
        rating,
        ratedAt: it?.user_rated_at || it?.last_watched_at || it?.rated_at || '',
        title: media?.title || '',
        year: media?.year ?? null,
      });
    }
  }
  return out;
}

function mergeRatings(...lists: NormalizedRating[][]): NormalizedRating[] {
  const byImdb = new Map<string, NormalizedRating>();
  for (const list of lists) {
    for (const r of list) {
      const prev = byImdb.get(r.imdb);
      if (!prev || (r.ratedAt || '') > (prev.ratedAt || '')) {
        byImdb.set(r.imdb, r);
      }
    }
  }
  return Array.from(byImdb.values());
}

function normalizedToImdbCsv(ratings: NormalizedRating[]): { csv: string; count: number } {
  const rows: string[] = [IMDB_HEADER];
  for (const r of ratings || []) {
    if (!normalizeImdb(r.imdb) || !validRating(r.rating)) continue;
    rows.push([
      csvField(r.imdb),
      csvField(r.rating),
      csvField((r.ratedAt || '').slice(0, 10)),
      csvField(r.title),
      csvField(`https://www.imdb.com/title/${r.imdb}/`),
      'movie',
      '',
      '',
      csvField(r.year),
      '',
      '',
      '',
      '',
    ].join(','));
  }
  return { csv: rows.join('\n') + '\n', count: rows.length - 1 };
}

export {
  NormalizedRating,
  fromMovieRatingItems,
  fromSimklRatings,
  mergeRatings,
  normalizedToImdbCsv,
};
module.exports = {
  fromMovieRatingItems,
  fromSimklRatings,
  mergeRatings,
  normalizedToImdbCsv,
};
