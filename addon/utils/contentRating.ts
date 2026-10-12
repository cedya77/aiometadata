type RatingConfig = { contentRatingCountry?: string; displayAgeRating?: boolean };

/**
 * Override only the rating country, and only while the age rating is shown: hidden,
 * it would split the caches for nothing. Automatic keeps each caller's legacy fallback.
 */
export function getContentRatingCountry(config: RatingConfig, fallback?: string): string | undefined {
  const country = config.displayAgeRating && typeof config.contentRatingCountry === 'string'
    ? config.contentRatingCountry.trim().toUpperCase() : '';
  return /^[A-Z]{2}$/.test(country) ? country : fallback;
}

/** Leave existing cache keys intact unless a country was explicitly selected. */
export function contentRatingCacheFields(config: RatingConfig): { contentRatingCountry?: string } {
  const country = getContentRatingCountry(config);
  return country ? { contentRatingCountry: country } : {};
}
