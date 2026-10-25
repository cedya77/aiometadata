export interface TagExclusions {
  keywords: string[];
  words: string[];
  genres: string[];
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function csvOf(value: unknown): string[] {
  return typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

export function tagExclusions(config: any, tags: string[]): TagExclusions {
  const wanted = new Set(tags.map((tag) => tag.trim().toLowerCase()));
  const out: TagExclusions = { keywords: [], words: [], genres: [] };
  for (const tag of Array.isArray(config?.tags) ? config.tags : []) {
    if (typeof tag?.name !== 'string' || !wanted.has(tag.name.trim().toLowerCase())) continue;
    out.keywords.push(...listOf(tag.hideKeywords));
    out.words.push(...listOf(tag.hideWords));
    out.genres.push(...listOf(tag.hideGenres));
  }
  return { keywords: unique(out.keywords), words: unique(out.words), genres: unique(out.genres) };
}

export function withTagExclusions<T extends Record<string, any>>(config: T, tags: string[]): T {
  const extra = tagExclusions(config, tags);
  if (!extra.keywords.length && !extra.words.length && !extra.genres.length) return config;
  return {
    ...config,
    ...(extra.keywords.length ? { exclusionTmdbKeywords: unique([...listOf(config.exclusionTmdbKeywords), ...extra.keywords]) } : {}),
    ...(extra.words.length ? { exclusionKeywords: unique([...csvOf(config.exclusionKeywords), ...extra.words]).join(', ') } : {}),
    ...(extra.genres.length ? { exclusionGenres: unique([...csvOf(config.exclusionGenres), ...extra.genres]).join(', ') } : {}),
  };
}
