import consola from 'consola';
import type { TasteProfile } from './profile';
import { collectWatchedRows, titleKeys, watchedIndex, type WatchedRow } from './history';
import { envInt } from '../envNumber';

const logger = consola.withTag('Recommendations');


/** A row of twenty reads as thin. The model is asked for more than this, since
 *  some titles will not resolve and some are already watched. */
const DEFAULT_WANT = parseInt(process.env.RECOMMENDATION_COUNT || '100', 10);

const RECENT_TTL = parseInt(process.env.RECOMMENDATION_RECENT_TTL || String(24 * 60 * 60), 10);

/** Roughly what one pick costs to write: a title, a year, a kind and a short reason. */
const TOKENS_PER_PICK = parseInt(process.env.RECOMMENDATION_TOKENS_PER_PICK || '90', 10);

/** OpenRouter reserves the whole window against the balance, and thinking draws
 *  from it too, so it is sized to the reply rather than the model's ceiling. */
function replyBudget(picks: number, effort: string): number {
  const { budgetFor }: any = require('./provider');
  return budgetFor(picks * TOKENS_PER_PICK + 512, effort);
}

/** Models search for a plain question and not for a JSON ranking prompt, so the
 *  search is asked separately and its answer passed in. Shared between users. */
async function fetchRecent(profile: TasteProfile, kind: RecommendKind, chosen: any, config: any): Promise<string> {
  const { cacheWrapGlobal }: any = require('../../lib/getCache');
  const now = new Date().getFullYear();
  const shape = kind === 'movie' ? 'films'
    : kind === 'anime' ? 'anime series and films'
      : kind === 'series' ? 'live-action television series'
        : 'films and television series';
  const flavour = profile.likes.slice(0, 6).join(', ') || profile.summary.slice(0, 300);
  const question = `What ${shape} released in ${now - 1} and ${now} would suit someone who likes ${flavour}? `
    + 'List title and year, one per line, with a few words on each. Only titles that have actually been released.';

  const { createHash } = require('crypto');
  const key = `recommendations:recent:${kind}:${chosen.model}:${createHash('md5').update(question).digest('hex')}`;

  return cacheWrapGlobal(key, async () => {
    const { generateContent } = require(chosen.clientPath);
    try {
      const { reasoningEffort, budgetFor }: any = require('./provider');
      const result = await generateContent({
        apiKey: chosen.apiKey,
        model: chosen.model,
        prompt: question,
        useGrounding: true,
        reasoningEffort: reasoningEffort(config),
        // Floored at the client's own default, which this call used to get.
        maxTokens: budgetFor(2048, reasoningEffort(config), 8192),
        timeout: 60000,
      });
      const queries = result?.groundingMetadata?.webSearchQueries;
      const usage = result?.usage;
      logger.info(
        `Recent ${kind} search via ${chosen.model}: `
        + (queries?.length ? `${queries.length} queries, ` : '')
        + (usage?.promptTokens ? `${usage.promptTokens} prompt tokens, ` : '')
        + (usage?.cost ? `$${Number(usage.cost).toFixed(4)}, ` : '')
        + `${(result?.text || '').length} chars back`
        + (!result?.text && result?.finishReason ? `, finish_reason=${result.finishReason}` : '')
      );
      return (result?.text || '').slice(0, 6000);
    } catch (error: any) {
      logger.warn(`Web search pass failed, continuing without it: ${error.message}`);
      return '';
    }
  }, RECENT_TTL, {
    // The shared classifier reads a plain string as empty, which would drop this
    // onto the 60s empty-result TTL and search again on every catalog load.
    resultClassifier: (result: any) => (typeof result === 'string' && result.trim()
      ? { type: 'SUCCESS', ttl: null }
      : { type: 'EMPTY_RESULT', ttl: 60 }),
  });
}

export type RecommendKind = 'movie' | 'series' | 'anime' | 'all';

/** Where live results come from: OpenRouter's :online pastes them in ahead of
 *  the call, Gemini needs the separate pass below. Either way the ranking call
 *  itself reads context rather than searching. */
type SearchMode = 'preloaded' | false;

interface Suggestion {
  title: string;
  year?: number;
  kind: 'movie' | 'series';
  reason?: string;
  fit?: number;
}

/** The flag only offers the tool; the model still decides whether to call it. */
function systemPrompt(searchMode: SearchMode): string {
  return [
    'You recommend films and television from a description of someone\'s taste.',
    'Every title must be real and findable on TMDB; do not invent one.',
    'Do not recommend anything in the exclusion list.',
    'Favour things the person is unlikely to have already found on their own,',
    'but not so obscure they cannot be watched.',
    searchMode
      ? 'Live search results are in your context. Use them for anything recent, and do NOT attempt to call any tools or functions.'
      : '',
    'Respond with JSON only.',
  ].filter(Boolean).join(' ');
}

function describeProfile(profile: TasteProfile): string {
  const section = (label: string, values: string[]) =>
    values.length ? `${label}: ${values.join('; ')}` : '';
  return [
    profile.summary,
    section('Draws them in', profile.likes),
    section('Turns them off', profile.dislikes),
    section('Film-makers that fit', profile.directors),
    section('Eras they favour', profile.eras),
    section('Steer clear of', profile.avoid),
  ].filter(Boolean).join('\n');
}

/** A model reaches for canon and skews old. The target is read off the viewer's
 *  own history, not fixed here, and the year is stated: it has no clock. */
export function eraBrief(rows: WatchedRow[], kind: RecommendKind, want: number, live = true): string {
  const now = new Date().getFullYear();
  const relevant = kind === 'all' ? rows : rows.filter(row => row.kind === kind);
  const years = relevant.map(row => row.year).filter((year): year is number => !!year).sort((a, b) => a - b);

  if (years.length < 10) return `It is currently ${now}.`;

  const at = (fraction: number) => years[Math.min(years.length - 1, Math.floor(years.length * fraction))];
  const decades: Record<string, number> = {};
  for (const year of years) {
    const decade = `${Math.floor(year / 10) * 10}s`;
    decades[decade] = (decades[decade] || 0) + 1;
  }

  // A decade target is too coarse at the recent end: "the 2020s" is satisfied by
  // 2020 to 2023 while the library is mostly newer than that, so the last two
  // years get their own line, again at whatever weight they actually carry.
  const fresh = years.filter(year => year >= now - 1).length;
  const freshPicks = Math.round((fresh / years.length) * want);

  const mix = Object.entries(decades)
    .sort((a, b) => b[1] - a[1])
    .map(([decade, count]) => ({ decade, picks: Math.round((count / years.length) * want) }))
    .filter(entry => entry.picks > 0)
    .map(entry => `${entry.picks} from the ${entry.decade}`);

  return [
    `It is currently ${now}.`,
    `Their releases run from ${years[0]} to ${years[years.length - 1]}, median ${at(0.5)},`,
    `with the middle of the library between ${at(0.1)} and ${at(0.9)}.`,
    `Aim for about the same spread: roughly ${mix.join(', ')}.`,
    freshPicks > 0 && live
      ? `Within that, about ${freshPicks} should be from ${now - 1} or ${now}: that is how much of`
        + ' their watching is brand new, and a list that stops a few years short will read as stale.'
      : '',
    freshPicks > 0 && !live
      ? `Up to about ${freshPicks} can be from ${now - 1} or ${now}, but only titles you know were released.`
        + ' If you know too few, take the rest from the years just before rather than guessing.'
      : '',
    'Treat that as the shape to hit, not a quota to fill exactly, and do not pad it',
    'with well-known classics from outside their range: they have almost certainly seen those.',
  ].filter(Boolean).join(' ');
}

function buildPrompt(
  profile: TasteProfile,
  kind: RecommendKind,
  exclude: string[],
  want: number,
  watched: WatchedRow[] = [],
  searchMode: SearchMode = false,
  recent = ''
): string {
  // Each kind has its own row, so they must not overlap. Anime is television and
  // anime films are films, so without saying otherwise a quarter-anime library
  // pulls anime into all three.
  const shape = kind === 'movie'
    ? 'films only, and no anime — anime has its own row, so exclude anime films entirely'
    : kind === 'series'
      ? 'live-action television series only, and no anime — anime has its own row, so exclude anime series entirely'
      : kind === 'anime'
        ? 'anime only, series or films'
        : 'a mix of films and television';

  return [
    describeProfile(profile),
    '',
    `Recommend ${want} titles: ${shape}.`,
    '',
    eraBrief(watched, kind, want, !!recent),
    recent ? '' : 'Name only titles you know have been released. Do not guess at sequels or titles you only know as announced or in production.',
    recent
      ? `Released recently, found by search just now:\n${recent}\n\n`
        + 'Draw the newest part of your list from these where they fit, and take their years as '
        + 'correct over your own recollection. They are candidates, not a list to copy out: skip '
        + 'any that do not suit, and keep the rest of the list from your own knowledge.'
      : '',
    '',
    'Already watched, do not repeat any of these:',
    exclude.join(', '),
    '',
    'Score each pick\'s "fit" from 1 to 10 for how well it suits them.',
    'Return JSON: {"picks":[{"title":"…","year":1999,"kind":"movie"|"series","fit":8,"reason":"…"}]}',
    'Keep each reason under 15 words. Long reasons cost more than they are worth here,',
    'and enough of them will truncate the reply before the list is finished.',
  ].join('\n');
}

/** Reads the entries that are intact when the reply will not parse, so one stray
 *  quote costs a title rather than the row. */
function salvagePicks(body: string): any[] {
  const picksAt = body.indexOf('"picks"');
  const from = picksAt >= 0 ? body.indexOf('[', picksAt) + 1 : 0;
  if (from <= 0) return [];

  const found: any[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let at = from; at < body.length; at += 1) {
    const char = body[at];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') {
      if (depth === 0) start = at;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          found.push(JSON.parse(body.slice(start, at + 1)));
        } catch { /* one unreadable entry, not a reason to lose the rest */ }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }

  return found;
}

function parsePicks(raw: string): Suggestion[] {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  const body = trimmed.slice(start, end + 1);

  let entries: any[] = [];
  try {
    const parsed = JSON.parse(body);
    entries = Array.isArray(parsed?.picks) ? parsed.picks : [];
  } catch (error: any) {
    entries = salvagePicks(body);
    logger.warn(`Reply did not parse (${error.message}), salvaged ${entries.length} entries`);
  }

  return entries
    .filter((pick: any) => pick && typeof pick.title === 'string' && pick.title.trim())
    .map((pick: any) => ({
      title: String(pick.title).trim(),
      year: Number.isFinite(Number(pick.year)) ? Number(pick.year) : undefined,
      kind: pick.kind === 'series' ? 'series' : 'movie',
      reason: typeof pick.reason === 'string' ? pick.reason.trim() : undefined,
      fit: Number.isFinite(Number(pick.fit)) && Number(pick.fit) > 0 ? Number(pick.fit) : undefined,
    }));
}

/** A model will name titles that do not exist or spell them oddly; anything that
 *  does not resolve is dropped rather than shown. */
type Genres = { movie: Array<{ id: number; name: string }>; series: Array<{ id: number; name: string }> };

/** Search hits carry genre ids, not names. Both lists, since the anime row
 *  resolves films and series alike. */
async function genreLists(config: any): Promise<Genres> {
  const { getGenreList }: any = require('../../lib/getGenreList');
  const language = config?.language || 'en-US';
  try {
    const [movie, series] = await Promise.all([
      getGenreList('tmdb', language, 'movie', config),
      getGenreList('tmdb', language, 'series', config),
    ]);
    return { movie: movie || [], series: series || [] };
  } catch (error: any) {
    logger.debug(`Could not read genre lists, anime cannot be filtered out: ${error.message}`);
    return { movie: [], series: [] };
  }
}

/** The anime mappings decide, as they do for metadata. TMDB's genres answer only for a
 *  title too new to be mapped. */
function isAnimeTitle(hit: any, kind: 'movie' | 'series', genres: Genres): boolean {
  const idMapper: any = require('../../lib/id-mapper');
  const mapped = idMapper.getMappingByTmdbId(String(hit.id), kind)
    || (kind === 'movie' && idMapper.getTraktAnimeMovieByTmdbId?.(String(hit.id)));
  if (mapped) return true;
  const { isAnime }: any = require('../isAnime');
  return isAnime(hit, kind === 'series' ? genres.series : genres.movie);
}

function closestYear<T>(entries: T[], yearOf: (entry: T) => number, year?: number): T | undefined {
  if (!year) return entries[0];
  return entries.find((entry) => yearOf(entry) === year)
    ?? entries.find((entry) => yearOf(entry) && Math.abs(yearOf(entry) - year) <= 1);
}

function comparable(title: string): string {
  return title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

async function matchOnLumiere(pick: Suggestion, config: any): Promise<any | null> {
  const { lumiereApiBase }: any = require('../lumiereLists');
  const base = lumiereApiBase();
  if (!base) return null;
  const { getSetting }: any = require('../../lib/settingsService');
  const { fetchLumiereSearch }: any = require('../lumiereSearch');
  const { cacheWrapGlobal }: any = require('../../lib/getCache');
  const type = pick.kind === 'series' ? 'series' : 'movie';
  const timeoutMs = parseInt(getSetting('LUMIERE_SEARCH_TIMEOUT_MS'), 10) || 5000;
  const ttl = parseInt(getSetting('LUMIERE_SEARCH_TTL_SECONDS'), 10);
  const search = () => fetchLumiereSearch(base, type, pick.title, 10, timeoutMs);
  const results: Array<{ imdbId: string; year: number | null; title?: string; originalTitle?: string; akas?: string[] }> = (ttl > 0
    ? await cacheWrapGlobal(`recommendations:lumiere:v2:${type}:${pick.title.toLowerCase().trim()}`, search, ttl)
    : await search()) || [];
  const wanted = comparable(pick.title);
  const yearOf = (entry: (typeof results)[number]) => entry.year || 0;
  const named = results.filter((entry) => [entry.title, entry.originalTitle, ...(entry.akas ?? [])].some((title) => title && comparable(title) === wanted));
  const match = closestYear(named, yearOf, pick.year)
    ?? named.find((entry) => (entry.akas ?? []).some((title) => comparable(title) === wanted))
    ?? closestYear(results, yearOf, pick.year);
  if (!match) return null;

  const { find }: any = require('../../lib/getTmdb');
  const found = await cacheWrapGlobal(
    `recommendations:find:${match.imdbId}`,
    () => find({ id: match.imdbId, external_source: 'imdb_id' }, config),
    envInt('RECOMMENDATION_FACT_TTL', 30 * 24 * 60 * 60, 60),
    {
      resultClassifier: (result: any) => (result?.movie_results?.length || result?.tv_results?.length
        ? { type: 'SUCCESS', ttl: null }
        : { type: 'EMPTY_RESULT', ttl: 60 * 60 }),
    },
  );
  const hit = (pick.kind === 'series' ? found?.tv_results : found?.movie_results)?.[0];
  return hit?.id ? { hit, imdbId: match.imdbId } : null;
}

async function searchTmdb(pick: Suggestion, config: any): Promise<any | null> {
  const { searchMovie, searchTv }: any = require('../../lib/getTmdb');
  const params: any = { query: pick.title, include_adult: false };
  if (pick.year) params[pick.kind === 'series' ? 'first_air_date_year' : 'year'] = pick.year;

  const response = pick.kind === 'series'
    ? await searchTv(params, config)
    : await searchMovie(params, config);

  const hit = (response?.results || [])[0];
  if (hit?.id || !pick.year) return hit?.id ? hit : null;
  const loose = pick.kind === 'series'
    ? await searchTv({ query: pick.title, include_adult: false }, config)
    : await searchMovie({ query: pick.title, include_adult: false }, config);
  const yearOf = (entry: any) => Number(String(entry.release_date || entry.first_air_date || '').slice(0, 4));
  return closestYear((loose?.results || []).filter((entry: any) => entry?.id), yearOf, pick.year) ?? null;
}

async function resolveSuggestion(pick: Suggestion, config: any, genres: Genres): Promise<any | null> {
  try {
    const lumiere = await matchOnLumiere(pick, config).catch((error: any) => {
      logger.debug(`LumiereDB could not match "${pick.title}": ${error.message}`);
      return null;
    });
    const hit = lumiere?.hit ?? await searchTmdb(pick, config);
    if (!hit?.id) {
      logger.debug(`No match for "${pick.title}" (${pick.year ?? 'no year'}, ${pick.kind})`);
      return null;
    }

    return {
      tmdbId: hit.id,
      imdbId: lumiere?.imdbId,
      matchedBy: lumiere ? 'lumiere' : 'tmdb',
      kind: pick.kind,
      anime: isAnimeTitle(hit, pick.kind, genres),
      // Kept from the search we already ran. TMDB counts are a fraction of
      // IMDb's and from a different crowd, but they are free and need no key,
      // so they are the fallback when nothing better can be looked up.
      votes: Number.isFinite(hit.vote_count) ? hit.vote_count : undefined,
      score: Number.isFinite(hit.vote_average) ? hit.vote_average : undefined,
      votesFrom: 'tmdb',
      title: hit.title || hit.name || pick.title,
      year: Number(String(hit.release_date || hit.first_air_date || '').slice(0, 4)) || pick.year,
      poster: hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null,
      description: hit.overview || undefined,
      reason: pick.reason,
      fit: pick.fit,
    };
  } catch (error: any) {
    logger.debug(`Could not resolve "${pick.title}": ${error.message}`);
    return null;
  }
}

/**
 * The recommendation pass. Cached per user, kind and day so a catalog refresh
 * does not spend a model call, and so the list is stable while someone browses.
 */
/** Keyed by every input that changes the answer. */
export function picksKey(config: any, userUUID: string, kind: RecommendKind, want = DEFAULT_WANT): string {
  const { resolveProvider, reasoningEffort, RECOMMENDATION_EPOCH }: any = require('./provider');
  const chosen = resolveProvider(config);
  const { resolveSources, viewerKey }: any = require('./history');
  const sources = resolveSources(config).choice;
  return `recommendations:picks:v${RECOMMENDATION_EPOCH}:${viewerKey(config, userUUID)}:${kind}:${want}:${sources}:${chosen?.provider || 'none'}:${chosen?.model || 'none'}:${chosen?.webSearch ? 'web' : 'offline'}:${reasoningEffort(config)}`;
}

export async function recommend(
  config: any,
  userUUID: string,
  profile: TasteProfile,
  kind: RecommendKind,
  want = DEFAULT_WANT
): Promise<any[]> {
  const { cacheWrapGlobal }: any = require('../../lib/getCache');
  const { resolveProvider, reasoningEffort, refreshTtl }: any = require('./provider');
  const chosen = resolveProvider(config);
  const key = picksKey(config, userUUID, kind, want);
  const ttl = refreshTtl(config);

  const build = async () => {
    const watched = await collectWatchedRows(config, userUUID);
    const known = await watchedIndex(config, userUUID);
    // Only the most recent slice: the exclusion list is a prompt cost, and the
    // resolved results are filtered against the full set afterwards anyway.
    const exclude = known.rows
      .filter(row => kind === 'all' || row.kind === kind)
      .sort((a, b) => String(b.watchedAt || '').localeCompare(String(a.watchedAt || '')))
      .slice(0, envInt('RECOMMENDATION_EXCLUDE_MAX', 400, 0))
      .map(row => (row.year ? `${row.title} (${row.year})` : row.title));

    if (!chosen) return [];
    const { model, apiKey, clientPath, webSearch } = chosen;
    const searchMode: SearchMode = webSearch ? 'preloaded' : false;
    // Both providers are asked as a question first. OpenRouter will search off a
    // ranking prompt too, but the query it derives from twenty thousand
    // characters of JSON instructions is a poor one, and it is billed per
    // request: a plain question is a better search and is asked once a day.
    const recent = searchMode ? await fetchRecent(profile, kind, chosen, config) : '';
    const { generateContent } = require(clientPath);

    // Asking for extra covers the ones that will not resolve or are already watched.
    const asked = Math.ceil(want * 1.25);
    const result = await generateContent({
      apiKey,
      // The search happened in the pass above and its answer is in the prompt,
      // so this call reads context rather than paying to search again.
      model: recent ? String(model).replace(/:online$/, '') : model,
      prompt: buildPrompt(profile, kind, exclude, asked, watched, searchMode, recent),
      systemPrompt: systemPrompt(searchMode),
      timeout: 90000,
      maxTokens: replyBudget(asked, reasoningEffort(config)),
      reasoningEffort: reasoningEffort(config),
    });

    const picks = result?.text ? parsePicks(result.text) : [];
    if (!picks.length) {
      const raw = result?.text || '';
      // Without the provider's own reason, a short reply reads the same whether
      // it hit the token ceiling, was filtered, or the model simply stopped.
      const why = result?.finishReason ? `, finish_reason=${result.finishReason}` : '';
      logger.warn(
        `No usable recommendations for ${userUUID}/${kind}: `
        + (!raw ? 'the model returned nothing'
          : result?.finishReason === 'length' ? `reply ran out of room (${raw.length} chars)`
          : `nothing readable in the reply (${raw.length} chars)`)
        + `${why} [${chosen.provider}/${model}]`
      );
      if (raw) {
        const edge = (text: string) => text.replace(/\s+/g, ' ').trim();
        logger.debug(`Reply opened with: ${edge(raw.slice(0, 200))}`);
        logger.debug(`Reply ended with: ${edge(raw.slice(-200))}`);
      }
      return [];
    }

    // A row asks for one shape of thing and the model does not always oblige: a
    // series row came back holding an anime film. The prompt cannot be trusted
    // to enforce this, so what it returns is checked against what was asked.
    const wantedShape = picks.filter(pick => (kind === 'anime' ? true : pick.kind === kind));

    const genres = await genreLists(config);
    const resolved = (await Promise.all(
      wantedShape.map(pick => resolveSuggestion(pick, config, genres)),
    )).filter(Boolean);

    const viaLumiere = resolved.filter((item: any) => item.matchedBy === 'lumiere').length;
    for (const item of resolved) delete item.matchedBy;
    const rightKind = resolved.filter((item: any) => (kind === 'anime' ? item.anime : !item.anime));

    // Attached before caching, so ordering a page is a sort rather than a lookup.
    const { attachRatings }: any = require('./enrich');
    await attachRatings(rightKind, config).catch(() => undefined);

    // Simkl stores anime under its romaji title and TMDB answers in English, so a
    // title is not a key across the two. Ids first, title and year as fallback.
    const seen = new Set<string>();
    let repeated = 0;
    let alreadyWatched = 0;
    const kept = rightKind.filter((item: any) => {
      const keys = titleKeys(item);
      if (keys.some(key => known.keys.has(key))) { alreadyWatched += 1; return false; }
      if (keys.some(key => seen.has(key))) { repeated += 1; return false; }
      for (const key of keys) seen.add(key);
      return true;
    });

    logger.info(
      `${userUUID}/${kind}: ${picks.length} proposed, `
      + `${picks.length - wantedShape.length} wrong kind, ${resolved.length} resolved (${viaLumiere} via LumiereDB), `
      + `${resolved.length - rightKind.length} anime-mismatched, ${alreadyWatched} already watched, `
      + `${repeated} repeated, ${kept.length} kept`
    );
    return kept;
  };

  // Rewriting this before it expires is the shared refresh-ahead's job, one
  // layer up: a page rebuild re-runs this build with the source cache bypassed.
  return cacheWrapGlobal(key, build, ttl, { sourceList: true });
}

module.exports = { recommend, parsePicks, eraBrief, picksKey };
