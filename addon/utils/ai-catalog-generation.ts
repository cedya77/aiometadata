import type { AICatalogGenerationMode, AICatalogOutput, AvailableKeys, ParsedAIResponse } from './ai-catalog-schema';
import { SOURCE_SCHEMAS } from './ai-catalog-schema';
import { isPlainObject } from './ai-catalog-sanitizer';
import consola from 'consola';

const logger = consola.withTag('AICatalog');
const SCHEMA: any = SOURCE_SCHEMAS;

function listValues(values: string[] | readonly string[] | Record<string, string>): string {
  return Array.isArray(values)
    ? values.join(', ')
    : Object.values(values).join(', ');
}

const PROMPT_HEADER = `You generate Stremio catalog discovery configs from natural language.

=== HARD RULES ===
- Return valid JSON only: { "catalogs": [...] }.
- Return exactly 1 catalog unless the user explicitly asks for multiple. Max 5.
- Always include the source sort field: sort_by, sort, or order_by.
- Use the fewest hard filters needed. Extra keywords/entities/providers can easily produce empty catalogs.
- Put dynamic names in resolve; put only scalar/static filters in params.
- Current date: {{CURRENT_DATE}}.
- Use only the source schemas documented in this prompt.

=== DECISION POLICY ===
- Genres beat keywords for broad categories, but use keywords alongside genres when the user describes specific themes, topics, or subgenres. Countries beat country keywords. Provider/network/company filters beat keyword guesses.
`;

const AUTO_DECISION_POLICY = `- Prefer TMDB for movies/series, AniList or MAL for anime, and TMDB/Simkl for western cartoons.
`;

const TMDB_DECISION_POLICY = `- Use TMDB for movie and series requests.
- Use with_origin_country for country/nationality requests. Use with_original_language only when the user asks for language.
- Use TMDB keywords only for concrete themes/subgenres not available as genres/entities. Put plain semantic names in resolve.keywords or resolve.excludeKeywords.
- For subjective mood/vibe requests, do not use mood words as TMDB keywords. Translate the mood into broad genre OR groups when possible: feel-good -> Comedy|Family|Animation|Romance|Adventure; dark/gritty -> Crime|Drama|Thriller|Mystery. Keep entity filters like cast/company/provider/network.
- Do not add parent, distributor, or related companies unless the user names them.
- Broad negative genres use resolve.excludeGenres when possible: "no comedy" -> excludeGenres: ["Comedy"].
- Use resolve.genres together with resolve.excludeGenres when a TMDB genre is too broad and a small, obvious exclusion would improve tone or scope. Example: serious crime dramas can use genres ["Crime","Drama"] and excludeGenres ["Comedy"]; do not exclude genres that the user asked for or that are central to the request.
- For broad TMDB "top/best/highly rated" catalogs, use vote_count.desc or vote_average.desc with vote_count.gte >= 300. Use 500+ for very broad genres (Action, Comedy, Drama, Horror, Thriller, Romance, Sci-Fi, etc.). Only these four low-volume TV genres get a lower threshold of vote_count.gte 5-10: Reality, Documentary, Talk, TV Movie. All other genres use >= 300.
- For recent TV catalogs, prefer popularity.desc with a first_air_date.gte floor.
- If the user references specific titles, do not use titles as TMDB keywords. Infer shared themes instead.
- For TMDB genres, use resolve.genres / resolve.excludeGenres with genreMode or excludeGenreMode. "crime dramas" -> genres ["Crime","Drama"], genreMode "and"; "action or adventure" -> genres ["Action","Adventure"], genreMode "or".
`;

const ANIME_DECISION_POLICY = `- Use direct anime genre, tag, format, season, status, score, popularity, and date params when supported by the selected source.
- For broad "best" or "must watch" anime requests, prefer score/popularity sorts and avoid over-constraining status unless the user asks for it.
`;

const TVDB_DECISION_POLICY = `- Use TVDB only for movie and series requests.
- TVDB supports fewer broad filters than TMDB; omit unsupported constraints instead of inventing params.
`;

const SOURCE_SCHEMAS_HEADER = `
=== SOURCE SCHEMAS ===
`;

function formatPromptDate(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

const SOURCE_TMDB = `
## TMDB (source: "tmdb", catalogType: "movie" or "series")
mediaType: "movie" for movies, "tv" for series.

Static params:
- sort_by movies: ${listValues(SCHEMA.tmdb.movie.sorts)}
- sort_by series: ${listValues(SCHEMA.tmdb.series.sorts)}
- Use resolve.genres / resolve.excludeGenres for genres. Use genre names only.
- vote_average.gte / vote_average.lte: 0-10
- vote_count.gte: positive integer
- with_runtime.gte / with_runtime.lte: minutes
- with_original_language: ISO 639-1 code
- with_origin_country: ISO 3166-1 code
- include_adult: boolean
- movies only: primary_release_date.gte/lte, certification_country, certification, with_release_type
- series only: first_air_date.gte/lte, with_status
- watch_region: region for watch provider resolution, default "US" when needed

TMDB genres:
- Movie genre names: ${listValues(SCHEMA.tmdb.movie.genreNames)}
- TV genre names: ${listValues(SCHEMA.tmdb.series.genreNames)}
CRITICAL: Movie and TV genre names are NOT interchangeable. There is NO Horror genre for TV — use 9648=Mystery or resolve.keywords: ["horror"] instead. For horror TV shows, use resolve.keywords: ["horror"].
Use genreMode "and" for combined genre concepts where results should match every genre: crime drama, family animation, sci-fi horror. Use genreMode "or" for alternatives or broad buckets.

Dynamic (put in "resolve" object, backend resolves names to IDs):
- genres: ["Crime", "Drama"] plus genreMode: "and" | "or"
- excludeGenres: ["Comedy"] plus excludeGenreMode: "and" | "or"
- companies: ["Pixar", "Marvel Studios", "A24"]
- keywords: ["superhero", "based on novel", "dystopia", "plot twist", "mindfuck", "time loop"]
- excludeKeywords: ["superhero", "anime", "japanese"]
- cast: ["Tom Hanks", "Leonardo DiCaprio"] (movie actor requests only)
- people: ["Christopher Nolan"] (movies only; broader cast/crew attachment)
- watchProviders: ["Netflix", "Disney+", "Hulu"] (MUST also set watch_region in params e.g. "US". Default to "US" if unsure.)
- networks: ["HBO", "Netflix", "BBC One"] (series only)

IMPORTANT about keywords: There is NO "keywords" field in params. Keywords MUST go in the "resolve" object so the backend can look up their IDs. Never put keywords directly in params.
Use keywords for thematic/niche concepts that genres can't capture. Examples of correct usage:
- "mindfuck movies" -> resolve: { "keywords": ["plot twist", "twist ending", "nonlinear timeline", "mindfuck"] }
- "heist movies" -> resolve: { "keywords": ["heist", "robbery"] }
- "time travel" -> resolve: { "keywords": ["time travel"] }
- "treasure hunt" -> resolve: { "keywords": ["treasure", "treasure hunt"] }
- "zombie movies" -> resolve: { "keywords": ["zombie"] }
- "home renovation shows" -> resolve: { "keywords": ["home renovation", "renovation"] }
Keywords are more precise than genres for specific themes. Prefer keywords over broad genre combinations when the user describes a specific concept or theme.

CRITICAL: when user mentions specific titles, TMDB keywords are thematic tags, NOT movie/series titles. If the user asks for a catalog referencing specific titles (e.g. "movies like Friday the 13th and Nightmare on Elm Street"), do NOT use those titles as keywords. Instead, identify the themes, subgenres, and characteristics those titles share (e.g. slasher, serial killer, summer camp, supernatural horror) and use THOSE as keywords combined with appropriate genres.
- "Friday the 13th and Elm Street movies" -> resolve: { "genres": ["Horror"], "keywords": ["slasher", "serial killer", "masked killer"] }
- "movies like Interstellar and Arrival" -> resolve: { "genres": ["Science Fiction"], "keywords": ["space", "alien contact", "time travel"] }
- "shows like Breaking Bad and Ozark" -> resolve: { "genres": ["Crime", "Drama"], "keywords": ["drug trade", "money laundering", "crime family"] }
`;

const SOURCE_ANILIST = `
## AniList (source: "anilist", catalogType: "anime", mediaType: "anime")
Static params:
- sort: ${listValues(SCHEMA.anilist.anime.sorts)}
- genre_in / genre_not_in: comma-separated strings from: ${listValues(SCHEMA.anilist.anime.genres)}
- tag_in / tag_not_in: comma-separated AniList tag names. Common examples: ${listValues(SCHEMA.anilist.anime.tags)}
- format_in: comma-separated from: ${listValues(SCHEMA.anilist.anime.formats)}
- season: ${listValues(SCHEMA.anilist.anime.seasons)}
- seasonYear: integer (e.g. 2024)
- For decade/year ranges, do NOT repeat seasonYear. Use startDate_greater/startDate_lesser instead. Example: "2010s anime movies" -> startDate_greater: "20100101", startDate_lesser: "20191231", format_in: "MOVIE".
- status: single value from ${listValues(SCHEMA.anilist.anime.statuses)}. Omit for broad requests like "best" or "must watch" unless the user explicitly asks for airing/finished/upcoming.
- countryOfOrigin: ${listValues(SCHEMA.anilist.anime.countries)}
- averageScore_greater / averageScore_lesser: 0-100
- popularity_greater: minimum popularity (integer)
- episodes_greater / episodes_lesser: episode count range
- duration_greater / duration_lesser: episode duration in minutes
- startDate_greater / startDate_lesser: YYYYMMDD format (no dashes)
- isAdult: boolean (default false). For hentai content, set BOTH isAdult: true AND genre_in: "Hentai".
For "no fanservice", prefer genre_not_in: "Ecchi,Hentai" instead of inventing a Fanservice tag. For "not childish", prefer tag_not_in: "Kids". Status accepts only one value; omit status for broad "must watch" requests.
Harem is a tag, not a genre. Use tag_not_in: "Harem" for "no harem".
Use tag_in/tag_not_in directly in params for AniList tag concepts. Do NOT put tags in resolve. For "feel-good" or "heartwarming" anime, prefer genre_in: "Slice of Life,Comedy" and optionally tag_in: "Iyashikei" if available; do not use resolve.tags.

Dynamic (put in "resolve"):
- studios: ["Bones", "MAPPA", "Ufotable", "Wit Studio", "Kyoto Animation"]
`;

const SOURCE_MAL = `
## MAL (source: "mal", catalogType: "anime", mediaType: "anime")
Static params:
- order_by: ${listValues(SCHEMA.mal.anime.sorts)}
- sort: ${listValues(SCHEMA.mal.anime.sortDirections)}
- type: ${listValues(SCHEMA.mal.anime.types)}
- status: ${listValues(SCHEMA.mal.anime.statuses)}
- rating: ${listValues(SCHEMA.mal.anime.ratings)}
- genres / genres_exclude: comma-separated genre names (e.g. "Action,Adventure,Fantasy"). Valid names: ${listValues(SCHEMA.mal.anime.genres)}
- min_score / max_score: 0-10
- season: ${listValues(SCHEMA.mal.anime.seasons)}
- seasonYear: integer
- start_date / end_date: YYYY-MM-DD
- sfw: boolean (default true)

Dynamic (put in "resolve"):
- producers: ["Bones", "MAPPA", "Toei Animation"]
`;

const SOURCE_SIMKL = `
## Simkl (source: "simkl", catalogType depends on media)
mediaType and catalogType: media "movies" -> catalogType "movie", media "shows" -> catalogType "series", media "anime" -> catalogType "anime"
Static params:
- media: ${listValues(SCHEMA.simkl.media)}
- sort (movies): ${listValues(SCHEMA.simkl.movies.sorts)}
- sort (shows/anime): ${listValues(SCHEMA.simkl.shows.sorts)}
- genre (movies): ${listValues(SCHEMA.simkl.movies.genres)}
- genre (shows): ${listValues(SCHEMA.simkl.shows.genres)}
- genre (anime): ${listValues(SCHEMA.simkl.anime.genres)}
- type (shows): ${listValues(SCHEMA.simkl.shows.types)}
- type (anime): ${listValues(SCHEMA.simkl.anime.types)}
- country (movies): ${listValues(SCHEMA.simkl.movies.countries)}
- country (shows): ${listValues(SCHEMA.simkl.shows.countries)}
- network (shows): ${listValues(SCHEMA.simkl.shows.networks)}
- network (anime): ${listValues(SCHEMA.simkl.anime.networks)}
- year: ${listValues(SCHEMA.simkl.movies.yearShortcuts)}, or decade strings like 2010s, 2000s, 1990s
Simkl supports one genre only. Do not use comma-separated genres. Simkl does not support resolve or negative filters like "no kids"; omit unsupported negative filters or choose another source.
`;

const SOURCE_TVDB = `
## TVDB (source: "tvdb", catalogType: "movie" or "series", mediaType same as catalogType)
Static params:
- sort (movies): ${listValues(SCHEMA.tvdb.movie.sorts)}
- sort (series): ${listValues(SCHEMA.tvdb.series.sorts)}
- sortType: ${listValues(SCHEMA.tvdb.series.sortDirections)} (series only)
- country: lowercase country code. Only set if user specifies a country. Omit for global/unfiltered results.
- lang: 3-letter language code. Only set if user specifies a language. Omit to use default.
- year: integer
TVDB year is an exact year, not a "from year onward" range. For year ranges, prefer TMDB unless the user explicitly requests TVDB.

Dynamic (put in "resolve", backend resolves names to IDs):
- company: ["HBO", "BBC", "Netflix"] (only first one is used)
- genre: "Horror" (single genre name, backend resolves to numeric ID)
- status: "Continuing" or "Ended" or "Upcoming" (backend resolves to numeric ID)
- contentRating: "TV-MA" or "TV-14" etc. (backend resolves to numeric ID)
`;


type PromptSource = Exclude<AICatalogGenerationMode, 'auto'> | 'simkl';

interface BuildCatalogCreationPromptOptions {
  mode: AICatalogGenerationMode;
  keys: AvailableKeys;
}

const SOURCE_SECTIONS: Record<PromptSource, string> = {
  tmdb: SOURCE_TMDB,
  anilist: SOURCE_ANILIST,
  mal: SOURCE_MAL,
  simkl: SOURCE_SIMKL,
  tvdb: SOURCE_TVDB,
};

const PROMPT_OUTPUT_CONTRACT = `
=== OUTPUT CONTRACT ===
Each catalog object:
- source: one available source above
- catalogType: "movie" | "series" | "anime"
- name: short descriptive name, max 40 chars
- mediaType: "movie" | "tv" | "anime" | "movies" | "shows"
- params: static params only
- resolve: optional dynamic names only

Rules:
- "resolve" is ONLY for dynamic entities that need name-to-ID lookup. Omit if none needed.
- For anime content, prefer AniList or MAL over TMDB.
- For movies/series, prefer TMDB (most comprehensive filters).
- "Cartoons" means western animated content (e.g. SpongeBob, Avatar, Rick and Morty) — use TMDB or Simkl with Animation genre, NOT AniList/MAL. AniList/MAL are strictly for Japanese anime (and occasionally Korean/Chinese animation).
- Return exactly 1 catalog unless the request clearly implies multiple (e.g. "horror, comedy, and sci-fi catalogs", "by decade starting from the 70s", "create 3 catalogs"). Never split a single concept into multiple catalogs — one request like "best James Cameron movies" is 1 catalog, not separate "popular" and "top rated" catalogs. Max 5.
- Always include sort_by/sort/order_by in params.
- For TMDB "best" or "top" requests: use vote_count.desc (most voted) rather than vote_average.desc. High vote count naturally surfaces the best-known, most-watched titles. Only use vote_average.desc when the user explicitly asks for "highest rated" or "best scored".
- When using vote_average.desc, always set vote_count.gte >= 50 to avoid obscure titles. Exception: for Reality, Documentary, Talk, or TV Movie genres only, use vote_count.gte 5-10.
- Return ONLY valid JSON. No markdown, no explanation, no code fences.

`;

const SOURCE_EXAMPLES: Record<PromptSource, string> = {
  tmdb: `
User: Good Netflix true crime documentaries
JSON: {"catalogs":[{"source":"tmdb","catalogType":"movie","name":"Netflix True Crime Docs","mediaType":"movie","params":{"sort_by":"vote_count.desc","vote_count.gte":25,"watch_region":"US"},"resolve":{"genres":["Documentary"],"genreMode":"and","watchProviders":["Netflix"],"keywords":["true crime"]}}]}

User: Netflix stand-up comedy specials
JSON: {"catalogs":[{"source":"tmdb","catalogType":"movie","name":"Netflix Stand-Up Comedy","mediaType":"movie","params":{"sort_by":"popularity.desc","vote_count.gte":25,"watch_region":"US"},"resolve":{"watchProviders":["Netflix"],"keywords":["stand-up comedy"]}}]}

User: HBO dark crime dramas
JSON: {"catalogs":[{"source":"tmdb","catalogType":"series","name":"HBO Crime Dramas","mediaType":"tv","params":{"sort_by":"vote_average.desc","vote_count.gte":300},"resolve":{"genres":["Crime","Drama"],"genreMode":"and","networks":["HBO"]}}]}

User: Tom Hanks family comedies
JSON: {"catalogs":[{"source":"tmdb","catalogType":"movie","name":"Tom Hanks Family Comedies","mediaType":"movie","params":{"sort_by":"popularity.desc","vote_count.gte":50},"resolve":{"genres":["Comedy","Family"],"genreMode":"and","cast":["Tom Hanks"]}}]}

User: BBC period dramas
JSON: {"catalogs":[{"source":"tmdb","catalogType":"series","name":"BBC Period Dramas","mediaType":"tv","params":{"sort_by":"popularity.desc"},"resolve":{"genres":["Drama"],"genreMode":"and","networks":["BBC One"],"keywords":["period drama"]}}]}

User: British mystery shows from 2020 onward
JSON: {"catalogs":[{"source":"tmdb","catalogType":"series","name":"British Mystery Shows","mediaType":"tv","params":{"sort_by":"popularity.desc","with_origin_country":"GB","first_air_date.gte":"2020-01-01"},"resolve":{"genres":["Mystery"],"genreMode":"and"}}]}

User: serious crime dramas from the 2000s
JSON: {"catalogs":[{"source":"tmdb","catalogType":"movie","name":"2000s Crime Dramas","mediaType":"movie","params":{"sort_by":"vote_average.desc","primary_release_date.gte":"2000-01-01","primary_release_date.lte":"2009-12-31","vote_count.gte":500},"resolve":{"genres":["Crime","Drama"],"genreMode":"and","excludeGenres":["Comedy"],"excludeGenreMode":"or"}}]}

User: 80s action movies with practical stunts, no comedy
JSON: {"catalogs":[{"source":"tmdb","catalogType":"movie","name":"80s Action Movies","mediaType":"movie","params":{"sort_by":"vote_count.desc","primary_release_date.gte":"1980-01-01","primary_release_date.lte":"1989-12-31","vote_count.gte":300},"resolve":{"genres":["Action"],"genreMode":"and","excludeGenres":["Comedy"],"excludeGenreMode":"or"}}]}
`,

  anilist: `
User: feel-good anime movies without fanservice
JSON: {"catalogs":[{"source":"anilist","catalogType":"anime","name":"Feel-Good Anime Movies","mediaType":"anime","params":{"sort":"SCORE_DESC","format_in":"MOVIE","genre_in":"Slice of Life,Comedy","genre_not_in":"Ecchi,Hentai"}}]}
`,

  mal: `
User: top rated anime movies on MAL
JSON: {"catalogs":[{"source":"mal","catalogType":"anime","name":"Top Rated Anime Movies","mediaType":"anime","params":{"order_by":"score","sort":"desc","type":"movie","sfw":true}}]}
`,

  simkl: `
User: popular 2000s sci-fi shows
JSON: {"catalogs":[{"source":"simkl","catalogType":"series","name":"2000s Sci-Fi Shows","mediaType":"shows","params":{"media":"shows","sort":"popular-this-month","genre":"science-fiction","year":"2000s"}}]}
`,

  tvdb: `
User: 1980 horror movies on TVDB
JSON: {"catalogs":[{"source":"tvdb","catalogType":"movie","name":"1980 Horror Movies","mediaType":"movie","params":{"sort":"score","year":1980},"resolve":{"genre":["Horror"]}}]}
`,
};

const PROMPT_FOOTER = `
Return only JSON. No markdown, explanations, or code fences.`;

function getPromptSources(mode: AICatalogGenerationMode, keys: AvailableKeys): PromptSource[] {
  if (mode === 'auto') {
    return [
      ...(keys.tmdb ? ['tmdb' as const] : []),
      'anilist',
      'mal',
      ...(keys.simkl ? ['simkl' as const] : []),
      ...(keys.tvdb ? ['tvdb' as const] : []),
    ];
  }

  if (mode === 'tmdb' && !keys.tmdb) {
    throw new Error('TMDB catalog generation requires a TMDB API key');
  }
  if (mode === 'tvdb' && !keys.tvdb) {
    throw new Error('TVDB catalog generation requires a TVDB API key');
  }

  return [mode];
}

function getDecisionPolicy(mode: AICatalogGenerationMode, sources: PromptSource[]): string {
  const sections: string[] = [];
  if (mode === 'auto') sections.push(AUTO_DECISION_POLICY);
  if (sources.includes('tmdb')) sections.push(TMDB_DECISION_POLICY);
  if (sources.includes('anilist') || sources.includes('mal')) sections.push(ANIME_DECISION_POLICY);
  if (sources.includes('tvdb')) sections.push(TVDB_DECISION_POLICY);
  return sections.join('');
}

export function buildCatalogCreationPrompt(query: string, options: BuildCatalogCreationPromptOptions): { systemPrompt: string; userPrompt: string } {
  const sources = getPromptSources(options.mode, options.keys);
  const sections = [PROMPT_HEADER];
  sections.push(getDecisionPolicy(options.mode, sources));
  sections.push(SOURCE_SCHEMAS_HEADER);
  sections.push(...sources.map((source) => SOURCE_SECTIONS[source]));
  sections.push(PROMPT_OUTPUT_CONTRACT);
  sections.push('\n=== EXAMPLES ===\n');
  sections.push(...sources.map((source) => SOURCE_EXAMPLES[source]));
  sections.push(PROMPT_FOOTER);
  return { systemPrompt: sections.join('').replace('{{CURRENT_DATE}}', formatPromptDate()), userPrompt: query };
}

function normalizeResolveValue(value: any): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => typeof item === 'string' || typeof item === 'number' ? String(item).trim() : '')
    .filter(Boolean);
}

function coerceResolve(rawResolve: any): Record<string, string[]> | undefined {
  if (!isPlainObject(rawResolve)) return undefined;

  const resolve: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(rawResolve)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    const names = normalizeResolveValue(value);
    if (names.length) resolve[key.trim()] = names;
  }

  return Object.keys(resolve).length ? resolve : undefined;
}

function coerceAICatalogOutput(rawCatalog: any): AICatalogOutput | null {
  if (!isPlainObject(rawCatalog)) return null;

  const source = typeof rawCatalog.source === 'string' ? rawCatalog.source.trim().toLowerCase() : '';
  const catalogType = typeof rawCatalog.catalogType === 'string' ? rawCatalog.catalogType.trim().toLowerCase() : '';
  const name = typeof rawCatalog.name === 'string' ? rawCatalog.name.trim() : '';

  if (!source || !catalogType || !name) return null;
  if (rawCatalog.params !== undefined && !isPlainObject(rawCatalog.params)) return null;

  const mediaType = typeof rawCatalog.mediaType === 'string' && rawCatalog.mediaType.trim()
    ? rawCatalog.mediaType.trim().toLowerCase()
    : catalogType;
  const resolve = coerceResolve(rawCatalog.resolve);

  return {
    source,
    catalogType,
    name,
    mediaType,
    params: { ...(rawCatalog.params || {}) },
    ...(resolve ? { resolve } : {}),
  };
}

function parsedCatalogsFromJson(parsed: any, warnings: string[] = []): ParsedAIResponse | null {
  const rawCatalogs = Array.isArray(parsed?.catalogs)
    ? parsed.catalogs
    : isPlainObject(parsed) && parsed.source && parsed.catalogType
      ? [parsed]
      : null;

  if (!rawCatalogs) return null;

  const catalogs: AICatalogOutput[] = [];
  let ignoredCatalogs = 0;
  rawCatalogs.forEach((rawCatalog) => {
    const catalog = coerceAICatalogOutput(rawCatalog);
    if (catalog) {
      catalogs.push(catalog);
    } else {
      ignoredCatalogs += 1;
    }
  });

  if (ignoredCatalogs) {
    warnings.push(`${ignoredCatalogs} generated catalog${ignoredCatalogs === 1 ? ' was' : 's were'} invalid and skipped`);
  }

  if (catalogs.length > 5) {
    warnings.push(`AI returned ${catalogs.length} catalogs; kept the first 5`);
    catalogs.length = 5;
  }

  return catalogs.length ? { catalogs, ...(warnings.length ? { warnings } : {}) } : null;
}

function extractBalancedJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

export function parseCatalogAIResponse(rawText: string): ParsedAIResponse | null {
  if (!rawText) {
    logger.warn('Empty AI response received');
    return null;
  }

  let text = rawText.trim();
  const warnings: string[] = [];
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  const tryParse = (json: string): ParsedAIResponse | null => {
    try {
      return parsedCatalogsFromJson(JSON.parse(json), warnings);
    } catch {
      return null;
    }
  };

  let result = tryParse(text);
  if (result) return result;

  // Extract first balanced top-level JSON object by tracking brace depth
  const balanced = extractBalancedJson(text);
  if (balanced) {
    result = tryParse(balanced);
    if (result) return result;
  }

  // Last resort: greedy regex
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    result = tryParse(jsonMatch[0]);
    if (result) return result;
  }

  logger.error(`Failed to parse AI response as JSON. Raw: ${text.slice(0, 500)}`);
  return null;
}
