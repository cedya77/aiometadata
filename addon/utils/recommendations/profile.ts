import consola from 'consola';
import { collectWatchedRows, isWatched, type WatchedRow } from './history';
import { formatHistory, isNegative, tuningFrom, DEFAULT_TUNING, type HistoryStats, type Tuning } from './rows';
import type { FactMap } from './enrich';

const logger = consola.withTag('Recommendations');

/** Long, because a taste profile is stable and rebuilding it costs a model call. */
const PROFILE_TTL = parseInt(process.env.RECOMMENDATION_PROFILE_TTL || String(7 * 24 * 60 * 60), 10);

export interface TasteProfile {
  summary: string;
  likes: string[];
  dislikes: string[];
  directors: string[];
  eras: string[];
  avoid: string[];
  builtFrom: number;
  builtAt: string;
}

const SYSTEM_PROMPT = [
  'You describe a person\'s taste in film and television from what they have watched.',
  'You are not recommending anything yet, and you must not name titles that are not in the list.',
  'Infer patterns rather than restating the list. Be specific and concrete: "slow-burn',
  'procedurals with unreliable narrators" is useful, "likes drama" is not.',
  'Respond with JSON only, no prose and no code fences.',
].join(' ');

/**
 * What an unfinished title is worth is the viewer's setting, so the model is
 * told how to read the mark rather than left to assume the worst.
 */
function stalledNote(weight: string): string {
  if (weight === 'ignore') return '';
  if (weight === 'note') {
    return '"set aside" means they stopped a while ago and have not returned. That is often'
      + ' circumstance rather than dislike, so do not read it as one.';
  }
  if (weight === 'mild') {
    return '"stalled" means they stopped a while ago and did not return. Treat it as weak'
      + ' evidence that it lost them, well short of a rating or a drop.';
  }
  return '"stalled" means they stopped a while ago and did not return. Treat it as abandoning it.';
}

function buildProfilePrompt(
  rows: WatchedRow[],
  limit?: number,
  facts?: FactMap,
  chosen?: WatchedRow[],
  tuning: Tuning = DEFAULT_TUNING,
): { prompt: string; stats: HistoryStats; used: number; sample: WatchedRow[] } {
  const { lines, stats, used, sample } = formatHistory(rows, limit, facts, chosen, tuning);
  const decades = Object.entries(stats.decades)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([decade, count]) => `${decade}:${count}`)
    .join(', ');

  const genreTally: Record<string, number> = {};
  if (facts) {
    for (const row of sample) {
      for (const genre of facts.get(row.key)?.genres || []) {
        genreTally[genre] = (genreTally[genre] || 0) + 1;
      }
    }
  }
  const genres = Object.entries(genreTally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([genre, count]) => `${genre}:${count}`)
    .join(', ');

  // Asking for dislikes from a library with nothing scored low and nothing put
  // down invites the model to invent them, and every later request reads them.
  const negatives = sample.filter(row => isNegative(row, facts?.get(row.key)?.episodes, tuning)).length;

  const prompt = [
    'Watch history sample. A star rating is the user\'s own score out of 10.',
    'Episode counts show how far into a series they got. "dropped" and "on hold" are',
    'their own marks, and "still watching" means they are current with it.',
    stalledNote(tuning.stalledWeight),
    'Where known, each line also carries its genres and how it is rated elsewhere',
    'out of 100. That last figure is the wider verdict, not theirs.',
    '',
    lines,
    '',
    `Library totals: ${stats.total} titles (${stats.movies} films, ${stats.series} series, ${stats.anime} anime).`,
    `${stats.rated} carry a rating${stats.meanRating ? `, averaging ${stats.meanRating}` : ''}. ${stats.abandoned} left unfinished.`,
    `Release decades: ${decades}.`,
    genres ? `Genres across the sample: ${genres}.` : '',
    '',
    'Return JSON with these keys:',
    '  summary   — two or three sentences on what they reach for and why',
    '  likes     — up to 8 concrete pulls (tone, structure, subject, craft)',
    negatives
      ? '  dislikes  — up to 6, inferred from low scores, drops and titles left unfinished'
      : '  dislikes  — return an empty array: nothing here is scored low or left unfinished',
    '  directors — up to 6 film-makers whose work fits. No credits are given here, so name',
    '              only those you are confident made the titles listed',
    '  eras      — up to 4 periods or movements they favour',
    negatives
      ? '  avoid     — up to 5 things a recommendation should steer clear of'
      : '  avoid     — return an empty array rather than guessing at one',
  ].filter(Boolean).join('\n');

  return { prompt, stats, used, sample };
}

function parseProfile(raw: string): Partial<TasteProfile> | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

const asList = (value: any, cap: number): string[] => (Array.isArray(value) ? value : [])
  .filter((entry: any) => typeof entry === 'string' && entry.trim())
  .map((entry: string) => entry.trim())
  .slice(0, cap);

/** Cached per user: the history moves slowly and this is the expensive half. */
/** Built in one place: the status panel looks the profile up by the same key. */
export function profileCacheKey(config: any, userUUID: string): string {
  const { resolveProvider, reasoningEffort }: any = require('./provider');
  const { resolveSources }: any = require('./history');
  const chosen = resolveProvider(config);
  const sources = resolveSources(config).choice;
  // Bumped when the prompt changes shape, so an improvement is not hidden behind
  // a week of cached profiles written by the previous one.
  const tuning = tuningFrom(config);
  return `recommendations:profile:v2:${userUUID}:${sources}:`
    + `${chosen?.provider || 'none'}:${chosen?.model || 'none'}:${reasoningEffort(config)}:`
    + `${tuning.stalledWeight}:${tuning.staleDays}`;
}

export async function getTasteProfile(
  config: any,
  userUUID: string,
  options: { force?: boolean; limit?: number } = {}
): Promise<TasteProfile | null> {
  const { cacheWrapGlobal }: any = require('../../lib/getCache');
  const { resolveProvider, reasoningEffort }: any = require('./provider');
  const chosen = resolveProvider(config);
  const key = profileCacheKey(config, userUUID);

  const build = async (): Promise<TasteProfile | null> => {
    const rows = (await collectWatchedRows(config, userUUID)).filter(isWatched);
    if (rows.length < 10) {
      logger.debug(`Only ${rows.length} watched titles for ${userUUID}, not enough to profile`);
      return null;
    }

    // Chosen before enriching, because only what reaches the model is worth a
    // lookup: a 584 title library sends 200 lines.
    const { stratify, DEFAULT_LIMIT }: any = require('./rows');
    const tuning = tuningFrom(config);
    const sample = stratify(rows, options.limit || DEFAULT_LIMIT, tuning);

    const { enrichRows }: any = require('./enrich');
    const facts = await enrichRows(sample, config);
    const { prompt, used } = buildProfilePrompt(rows, options.limit, facts, sample, tuning);

    if (!chosen) {
      logger.debug('No AI provider key available, cannot build a profile');
      return null;
    }
    // Summarising a watch history has nothing to look up, so the search suffix
    // is dropped here: left on, every profile build pays OpenRouter for a search
    // whose results the prompt never refers to.
    const { provider, apiKey, clientPath } = chosen;
    const model = String(chosen.model).replace(/:online$/, '');
    const { generateContent } = require(clientPath);

    const result = await generateContent({
      apiKey,
      model,
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      timeout: 60000,
      maxTokens: 2048,
      reasoningEffort: reasoningEffort(config),
    });

    const parsed = result?.text ? parseProfile(result.text) : null;
    if (!parsed?.summary) {
      logger.warn(
        `Profile generation returned nothing usable for ${userUUID} `
        + `[${provider}/${model}]`
        + (result?.finishReason ? `, finish_reason=${result.finishReason}` : '')
      );
      return null;
    }

    logger.info(`Built taste profile for ${userUUID} from ${used} of ${rows.length} titles via ${provider}/${model}`);

    return {
      summary: String(parsed.summary).trim(),
      likes: asList(parsed.likes, 8),
      dislikes: asList(parsed.dislikes, 6),
      directors: asList(parsed.directors, 6),
      eras: asList(parsed.eras, 4),
      avoid: asList(parsed.avoid, 5),
      builtFrom: rows.length,
      builtAt: new Date().toISOString(),
    };
  };

  if (options.force) return build();

  // The shared classifier recognises metas and arrays, so a profile object reads
  // as empty and lands on the 60s empty-result TTL: every catalog load would
  // rebuild it, which is the expensive half of this pipeline.
  const classifyProfile = (result: any) => (
    result && typeof result.summary === 'string' && result.summary.trim()
      ? { type: 'SUCCESS', ttl: null }
      : { type: 'EMPTY_RESULT', ttl: 60 }
  );

  // Deliberately not a source list: a page rebuild bypasses those, and a taste
  // profile is a paid model call with a week of life, not something upstream
  // that has gone stale.
  return cacheWrapGlobal(key, build, PROFILE_TTL, {
    resultClassifier: classifyProfile,
  });
}

module.exports = { getTasteProfile, profileCacheKey, buildProfilePrompt, parseProfile, PROFILE_TTL };
