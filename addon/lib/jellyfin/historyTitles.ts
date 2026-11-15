import { createHash } from 'crypto';
import redis from '../redisClient';
import { envInt } from '../../utils/envNumber';
import { movieExternalIds, tvExternalIds } from '../getTmdb';
import { comparable, matchTitle, titleChoices } from '../../utils/titleMatch';
import { imdbOf, positive, type Ambiguous, type Choice } from './historySources';

export type TitleKind = 'movie' | 'series';
export type NamedTitle = { name: string; year: number | null; kind: TitleKind };
export type TitleIds = { tmdb: number; imdb: string | null };
type TitleMatch = TitleIds | { options: Choice[] };

const TMDB_POSTER = 'https://image.tmdb.org/t/p/w154';

const choiceOf = (hit: any): Choice => {
  const title = String(hit.title ?? hit.name ?? '').slice(0, 200);
  const original = hit.original_title ?? hit.original_name;
  return {
    tmdb: hit.id,
    title,
    originalTitle: original && original !== title ? String(original).slice(0, 200) : null,
    year: positive(String(hit.release_date ?? hit.first_air_date ?? '').slice(0, 4)),
    poster: typeof hit.poster_path === 'string' ? `${TMDB_POSTER}${hit.poster_path}` : null,
    overview: String(hit.overview ?? '').slice(0, 300),
  };
};

const imdbFor = async (tmdb: number, kind: TitleKind, config: any) =>
  imdbOf((await (kind === 'series' ? tvExternalIds : movieExternalIds)(String(tmdb), config).catch(() => null))?.imdb_id);

export const titleKey = (name: string, year: unknown, kind: TitleKind) => `${kind}\u0000${comparable(name)}\u0000${positive(year) ?? ''}`;

const choiceKey = (key: string) => createHash('sha1').update(key).digest('hex').slice(0, 16);

export async function titleIdsFor({ name, year, kind }: NamedTitle, config: any): Promise<TitleMatch | null> {
  const key = `history:title:v1:${createHash('sha1').update(titleKey(name, year, kind)).digest('hex')}`;
  const held = await redis.get(key).catch(() => null);
  if (typeof held === 'string') {
    try {
      return held === '' ? null : JSON.parse(held);
    } catch {
      return null;
    }
  }
  const pick = { title: name, year: year ?? undefined, kind, strict: true };
  const matched = await matchTitle(pick, config);
  const tmdb = positive(matched?.hit?.id);
  let value: TitleMatch | null = tmdb ? { tmdb, imdb: imdbOf(matched?.imdbId) ?? (await imdbFor(tmdb, kind, config)) } : null;
  if (!value) {
    const options = (await titleChoices(pick, config)).filter((hit) => positive(hit?.id)).map(choiceOf);
    if (options.length > 1) value = { options };
  }
  const seconds = value ? envInt('JELLYFIN_HISTORY_IMPORT_TITLE_MATCH_TTL_DAYS', 30, 1) * 86400 : envInt('JELLYFIN_HISTORY_IMPORT_TITLE_MISS_TTL_HOURS', 24, 1) * 3600;
  redis.set(key, value ? JSON.stringify(value) : '', 'EX', seconds).catch(() => undefined);
  return value;
}

export async function settleTitles(
  found: Map<string, TitleMatch | null>,
  titles: Map<string, NamedTitle>,
  picks: Record<string, number>,
  config: any,
): Promise<{ ids: Map<string, TitleIds | null>; ambiguous: Ambiguous[]; unpicked: Set<string> }> {
  const ids = new Map<string, TitleIds | null>();
  const ambiguous: Ambiguous[] = [];
  const unpicked = new Set<string>();
  for (const [key, match] of found) {
    if (!match || !('options' in match)) {
      ids.set(key, match as TitleIds | null);
      continue;
    }
    const title = titles.get(key)!;
    const picked = match.options.find((option) => option.tmdb === picks[choiceKey(key)])?.tmdb ?? null;
    ambiguous.push({ key: choiceKey(key), name: `${title.name}${title.year ? ` (${title.year})` : ''}`, options: match.options, picked });
    ids.set(key, picked ? { tmdb: picked, imdb: await imdbFor(picked, title.kind, config) } : null);
    if (!picked) unpicked.add(key);
  }
  ambiguous.sort((a, b) => a.name.localeCompare(b.name));
  return { ids, ambiguous, unpicked };
}
