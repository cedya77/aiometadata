type RatingConfig = { contentRatingCountry?: string };

/** Override only the rating country; automatic keeps each caller's legacy fallback. */
export function getContentRatingCountry(config: RatingConfig, fallback?: string): string | undefined {
  const country = typeof config.contentRatingCountry === 'string'
    ? config.contentRatingCountry.trim().toUpperCase() : '';
  return /^[A-Z]{2}$/.test(country) ? country : fallback;
}

/** Leave existing cache keys intact unless a country was explicitly selected. */
export function contentRatingCacheFields(config: RatingConfig): { contentRatingCountry?: string } {
  const country = getContentRatingCountry(config);
  return country ? { contentRatingCountry: country } : {};
}
