export type RatingKind = 'movie' | 'tv';
export type RatingSource = 'tomatoes' | 'tomatoesAudience' | 'metacritic' | 'letterboxd' | 'rogerebert' | 'trakt' | 'tmdb' | 'mal';
export type Scores = Partial<Record<RatingSource, number>>;

export interface RatingRef {
  kind: RatingKind;
  tmdbId: string;
  recent?: boolean;
}

export interface RatingsProvider {
  name: string;
  maxBatch: number;
  fetch(refs: RatingRef[]): Promise<Map<string, Scores>>;
}

export class RatingsPaused extends Error {
  constructor(readonly ms: number) {
    super('rate limited');
  }
}

export const ratingKey = (ref: RatingRef) => `${ref.kind}:${ref.tmdbId}`;
