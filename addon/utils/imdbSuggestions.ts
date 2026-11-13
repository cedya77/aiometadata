// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { httpGet } from './httpClient.js';

const logger = consola.withTag('ImdbSuggestions');

// The titles path spends all eight slots the endpoint allows on titles, where the
// unscoped one shares them with people and franchises we would only discard.
const SUGGESTION_BASE = 'https://v3.sg.media-imdb.com/suggestion/titles/x';

const TITLE_QIDS: Record<string, string[]> = {
  movie: ['movie', 'tvMovie', 'video', 'short', 'tvShort'],
  series: ['tvSeries', 'tvMiniSeries'],
};

/**
 * IMDb answers bot-challenged clients with a 2xx and no usable body rather than an
 * error status, so an empty payload has to be told apart from a genuine no-match.
 * Throwing keeps the empty list out of the cache and out of the user's results.
 */
export class ImdbSuggestionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImdbSuggestionUnavailableError';
  }
}

function describeBody(data: unknown): string {
  if (data === null || data === undefined) return 'empty';
  if (typeof data === 'string') return data.trim() === '' ? 'empty' : `${data.length} chars of non-JSON`;
  return typeof data;
}

export interface ImdbSuggestion {
  imdbId: string;
  title: string;
  year: number | null;
  qid: string;
  rank: number;
}

/**
 * The endpoint matches the query as typed, including punctuation and non-Latin
 * scripts, so it is passed through with nothing but whitespace tidied up.
 */
function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

export async function fetchImdbSuggestions(
  type: string,
  query: string,
  timeoutMs: number
): Promise<ImdbSuggestion[]> {
  const normalized = normalizeQuery(query);
  if (!normalized) return [];

  const allowed = TITLE_QIDS[type === 'movie' ? 'movie' : 'series'];
  const url = `${SUGGESTION_BASE}/${encodeURIComponent(normalized)}.json?includeVideos=0`;

  const response: any = await httpGet(url, { timeout: timeoutMs });
  const entries = response?.data?.d;

  if (!Array.isArray(entries)) {
    throw new ImdbSuggestionUnavailableError(
      `IMDb returned no suggestion payload (status ${response?.status}, body ${describeBody(response?.data)})`
    );
  }

  return entries
      .filter((entry: any) =>
        typeof entry?.id === 'string'
        && entry.id.startsWith('tt')
        && typeof entry.qid === 'string'
        && allowed.includes(entry.qid))
      .map((entry: any) => ({
        imdbId: entry.id,
        title: entry.l || '',
        year: typeof entry.y === 'number' ? entry.y : null,
        qid: entry.qid,
        rank: typeof entry.rank === 'number' ? entry.rank : Number.MAX_SAFE_INTEGER,
      }))
      .sort((a: ImdbSuggestion, b: ImdbSuggestion) => a.rank - b.rank);
}
