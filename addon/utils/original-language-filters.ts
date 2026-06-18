export function normalizeOriginalLanguageCodes(languages: unknown): string[] {
  if (!Array.isArray(languages)) return [];

  return Array.from(new Set(
    languages
      .map(language => String(language).trim().toLowerCase())
      .filter(Boolean)
  ));
}

export function filterByExcludedOriginalLanguages<T extends { original_language?: unknown }>(
  items: T[],
  excludedOriginalLanguages: unknown
): T[] {
  const excluded = new Set(normalizeOriginalLanguageCodes(excludedOriginalLanguages));
  if (excluded.size === 0) return items;

  return items.filter(item => {
    const originalLanguage = typeof item.original_language === 'string'
      ? item.original_language.trim().toLowerCase()
      : '';
    return !originalLanguage || !excluded.has(originalLanguage);
  });
}
