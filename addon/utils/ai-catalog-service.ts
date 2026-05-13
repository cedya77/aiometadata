import consola from 'consola';

const logger = consola.withTag('AICatalog');

const PROMPT_HEADER = `You are a Stremio catalog configuration generator. Given a user's natural language description, output a JSON object with a "catalogs" array that maps to supported discovery sources.

=== SOURCES & PARAMETERS ===
`;

const SOURCE_TMDB = `
## TMDB (source: "tmdb", catalogType: "movie" or "series")
mediaType: "movie" for movies, "tv" for series
Static params:
- sort_by (movies): popularity.desc, popularity.asc, primary_release_date.desc, primary_release_date.asc, vote_average.desc, vote_average.asc, vote_count.desc, revenue.desc
- sort_by (series): popularity.desc, popularity.asc, first_air_date.desc, first_air_date.asc, vote_average.desc, vote_average.asc, vote_count.desc
- with_genres / without_genres: pipe-separated genre IDs (use | for OR)
- vote_average.gte / vote_average.lte: 0-10
- vote_count.gte: positive integer (use 50+ for quality filter)
- with_runtime.gte / with_runtime.lte: minutes
- with_original_language: ISO 639-1 code (e.g. "en", "ko", "ja", "fr", "es")
- with_origin_country: ISO 3166-1 code (e.g. "US", "KR", "JP")
- include_adult: boolean (default false)
- primary_release_date.gte / primary_release_date.lte: YYYY-MM-DD (movies only)
- first_air_date.gte / first_air_date.lte: YYYY-MM-DD (series only)
- certification_country + certification: e.g. "US" + "R" (movies only)
- with_release_type: "4|5|6" for released content only (movies)
- with_status: "0|3|4|5" for released content only (series)

Movie genre IDs (ONLY for catalogType "movie"): 28=Action, 12=Adventure, 16=Animation, 35=Comedy, 80=Crime, 99=Documentary, 18=Drama, 10751=Family, 14=Fantasy, 36=History, 27=Horror, 10402=Music, 9648=Mystery, 10749=Romance, 878=Science Fiction, 10770=TV Movie, 53=Thriller, 10752=War, 37=Western
TV genre IDs (ONLY for catalogType "series"): 10759=Action & Adventure, 16=Animation, 35=Comedy, 80=Crime, 99=Documentary, 18=Drama, 10751=Family, 10762=Kids, 9648=Mystery, 10763=News, 10764=Reality, 10765=Sci-Fi & Fantasy, 10766=Soap, 10767=Talk, 10768=War & Politics, 37=Western
CRITICAL: Movie and TV genre IDs are NOT interchangeable. There is NO Horror genre for TV — use 9648=Mystery or keywords instead. For horror TV shows, use resolve.keywords: ["horror"].

Dynamic (put in "resolve" object, backend resolves names to IDs):
- companies: ["Pixar", "Marvel Studios", "A24"]
- keywords: ["superhero", "based on novel", "dystopia", "plot twist", "mindfuck", "time loop"]
- people: ["Christopher Nolan", "Tom Hanks"] (movies only)
- watchProviders: ["Netflix", "Disney+", "Hulu"] (MUST also set watchRegion in params e.g. "US". Default to "US" if unsure.)

IMPORTANT about keywords: There is NO "keywords" field in params. Keywords MUST go in the "resolve" object so the backend can look up their IDs. Never put keywords directly in params.
Use keywords for thematic/niche concepts that genres can't capture. Examples of correct usage:
- "mindfuck movies" → resolve: { "keywords": ["plot twist", "twist ending", "nonlinear timeline", "mindfuck"] }
- "heist movies" → resolve: { "keywords": ["heist", "robbery"] }
- "time travel" → resolve: { "keywords": ["time travel"] }
- "treasure hunt" → resolve: { "keywords": ["treasure", "treasure hunt"] }
- "zombie movies" → resolve: { "keywords": ["zombie"] }
Keywords are more precise than genres for specific themes. Prefer keywords over broad genre combinations when the user describes a specific concept or theme.

CRITICAL — when user mentions specific titles: TMDB keywords are thematic tags, NOT movie/series titles. If the user asks for a catalog referencing specific titles (e.g. "movies like Friday the 13th and Nightmare on Elm Street"), do NOT use those titles as keywords. Instead, identify the themes, subgenres, and characteristics those titles share (e.g. slasher, serial killer, summer camp, supernatural horror) and use THOSE as keywords combined with appropriate genres. Think: "what makes these titles similar?" not "what are these titles called?"
- "Friday the 13th and Elm Street movies" → with_genres: "27", resolve: { "keywords": ["slasher", "serial killer", "masked killer"] }
- "movies like Interstellar and Arrival" → with_genres: "878", resolve: { "keywords": ["space", "alien contact", "time travel"] }
- "shows like Breaking Bad and Ozark" → with_genres: "80|18", resolve: { "keywords": ["drug trade", "money laundering", "crime family"] }
`;

const SOURCE_ANILIST = `
## AniList (source: "anilist", catalogType: "anime", mediaType: "anime")
Static params:
- sort: TRENDING_DESC, POPULARITY_DESC, SCORE_DESC, FAVOURITES_DESC, START_DATE_DESC, UPDATED_AT_DESC, EPISODES_DESC
- genre_in / genre_not_in: comma-separated strings from: Action, Adventure, Comedy, Drama, Ecchi, Fantasy, Hentai, Horror, Mahou Shoujo, Mecha, Music, Mystery, Psychological, Romance, Sci-Fi, Slice of Life, Sports, Supernatural, Thriller
- tag_in / tag_not_in: comma-separated strings (Isekai, Time Travel, Super Power, School, Military, Magic, Demons, Vampire, Gore, Samurai, Historical, Space, Cooking, Reincarnation, Martial Arts, Robots)
- format_in: comma-separated from TV, TV_SHORT, MOVIE, SPECIAL, OVA, ONA
- season: WINTER, SPRING, SUMMER, FALL, CURRENT
- seasonYear: integer (e.g. 2024)
- status: FINISHED, RELEASING, NOT_YET_RELEASED, CANCELLED, HIATUS
- countryOfOrigin: JP, KR, CN, TW
- averageScore_greater / averageScore_lesser: 0-100
- popularity_greater: minimum popularity (integer)
- episodes_greater / episodes_lesser: episode count range
- duration_greater / duration_lesser: episode duration in minutes
- startDate_greater / startDate_lesser: YYYYMMDD format (no dashes)
- isAdult: boolean (default false). For hentai content, set BOTH isAdult: true AND genre_in: "Hentai".

Dynamic (put in "resolve"):
- studios: ["Bones", "MAPPA", "Ufotable", "Wit Studio", "Kyoto Animation"]
`;

const SOURCE_MAL = `
## MAL (source: "mal", catalogType: "anime", mediaType: "anime")
Static params:
- order_by: score, popularity, rank, members, favorites, start_date, end_date, episodes, title
- sort: asc, desc
- type: tv, movie, ova, special, ona, music
- status: airing, complete, upcoming
- rating: g, pg, pg13, r17, r, rx
- genres / genres_exclude: comma-separated genre names (e.g. "Action,Adventure,Fantasy"). Valid names: Action, Adventure, Racing, Comedy, Avant Garde, Mythology, Mystery, Drama, Ecchi, Fantasy, Strategy Game, Hentai, Historical, Horror, Kids, Martial Arts, Mecha, Music, Parody, Samurai, Romance, School, Sci-Fi, Shoujo, Girls Love, Shounen, Boys Love, Space, Sports, Super Power, Vampire, Harem, Slice of Life, Supernatural, Military, Detective, Psychological, Suspense, Seinen, Josei, Gourmet, Isekai, Mahou Shoujo
- min_score / max_score: 0-10
- season: WINTER, SPRING, SUMMER, FALL, CURRENT
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
- media: movies, shows, anime
- sort (movies): popular-this-week, popular-this-month, rank, votes, budget, revenue, release-date, most-anticipated, a-z, z-a
- sort (shows/anime): popular-today, popular-this-week, popular-this-month, rank, votes, release-date, last-air-date, a-z, z-a
- genre (movies): action, adventure, animation, comedy, crime, documentary, drama, family, fantasy, history, horror, music, mystery, romance, science-fiction, thriller, tv-movie, war, western
- genre (shows): action, adventure, animation, comedy, crime, documentary, drama, family, fantasy, history, horror, mystery, romance, science-fiction, thriller, war, western, korean-drama, reality, game-show
- genre (anime): action, adventure, comedy, drama, ecchi, fantasy, gore, harem, historical, horror, isekai, kids, magic, martial-arts, mecha, military, music, mystery, psychological, romance, samurai, school, sci-fi, seinen, shoujo, shounen, slice-of-life, space, sports, super-power, supernatural, thriller, vampire
- type (shows): all-types, tv-shows, entertainment, documentaries, animation-filter
- type (anime): all-types, series, movies, ovas, onas
- country (movies): us, uk, ca, kr
- country (shows): us, uk, ca, kr, jp
- network (shows): netflix, disney, peacock, appletv, cbs, abc, fox, cw, hbo, showtime, fx, amc, starz
- network (anime): tvtokyo, tokyomx, fujitv, nhk, mbs, animax, cartoonnetwork
- year: this-week, this-month, this-year, or decade strings like 2010s, 2000s, 1990s
`;

const SOURCE_TVDB = `
## TVDB (source: "tvdb", catalogType: "movie" or "series", mediaType same as catalogType)
Static params:
- sort: score, firstAired, name, lastAired (lastAired for series only)
- sortType: asc, desc (series only)
- country: lowercase country code. Only set if user specifies a country. Omit for global/unfiltered results.
- lang: 3-letter language code. Only set if user specifies a language. Omit to use default.
- year: integer

Dynamic (put in "resolve", backend resolves names to IDs):
- company: ["HBO", "BBC", "Netflix"] (only first one is used)
- genre: "Horror" (single genre name, backend resolves to numeric ID)
- status: "Continuing" or "Ended" or "Upcoming" (backend resolves to numeric ID)
- contentRating: "TV-MA" or "TV-14" etc. (backend resolves to numeric ID)
`;

const PROMPT_FOOTER = `
=== OUTPUT SCHEMA ===
{
  "catalogs": [
    {
      "source": <one of the available sources above>,
      "catalogType": "movie" | "series" | "anime",
      "name": "Short descriptive name (max 40 chars)",
      "mediaType": "movie" | "tv" | "anime" | "movies" | "shows",
      "params": { ... },
      "resolve": { ... }
    }
  ]
}

Rules:
- "resolve" is ONLY for dynamic entities that need name-to-ID lookup. Omit if none needed.
- For anime content, prefer AniList or MAL over TMDB.
- For movies/series, prefer TMDB (most comprehensive filters).
- "Cartoons" means western animated content (e.g. SpongeBob, Avatar, Rick and Morty) — use TMDB or Simkl with Animation genre, NOT AniList/MAL. AniList/MAL are strictly for Japanese anime (and occasionally Korean/Chinese animation).
- Return exactly 1 catalog unless the request clearly implies multiple (e.g. "horror, comedy, and sci-fi catalogs", "by decade starting from the 70s", "create 3 catalogs"). Never split a single concept into multiple catalogs — one request like "best James Cameron movies" is 1 catalog, not separate "popular" and "top rated" catalogs. Max 5.
- Always include sort_by/sort/order_by in params.
- For TMDB "best" or "top" requests: use vote_count.desc (most voted) rather than vote_average.desc. High vote count naturally surfaces the best-known, most-watched titles. Only use vote_average.desc when the user explicitly asks for "highest rated" or "best scored".
- When using vote_average.desc, always set vote_count.gte >= 50 to avoid obscure titles.
- Return ONLY valid JSON. No markdown, no explanation, no code fences.`;

interface AICatalogOutput {
  source: string;
  catalogType: string;
  name: string;
  mediaType: string;
  params: Record<string, any>;
  resolve?: Record<string, string[]>;
}

interface ParsedAIResponse {
  catalogs: AICatalogOutput[];
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

interface ResolvedEntity {
  id: number;
  name: string;
}

const VALID_SOURCES = ['tmdb', 'tvdb', 'anilist', 'mal', 'simkl'] as const;

const VALID_TMDB_MOVIE_SORTS = ['popularity.desc', 'popularity.asc', 'primary_release_date.desc', 'primary_release_date.asc', 'vote_average.desc', 'vote_average.asc', 'vote_count.desc', 'revenue.desc'];
const VALID_TMDB_TV_SORTS = ['popularity.desc', 'popularity.asc', 'first_air_date.desc', 'first_air_date.asc', 'vote_average.desc', 'vote_average.asc', 'vote_count.desc'];
const VALID_ANILIST_SORTS = ['TRENDING_DESC', 'POPULARITY_DESC', 'POPULARITY', 'SCORE_DESC', 'SCORE', 'FAVOURITES_DESC', 'START_DATE_DESC', 'START_DATE', 'UPDATED_AT_DESC', 'TITLE_ROMAJI', 'TITLE_ENGLISH', 'EPISODES_DESC'];
const VALID_MAL_SORTS = ['score', 'popularity', 'rank', 'members', 'favorites', 'start_date', 'end_date', 'episodes', 'title'];
const VALID_SIMKL_MOVIE_SORTS = ['popular-this-week', 'popular-this-month', 'rank', 'votes', 'budget', 'revenue', 'release-date', 'most-anticipated', 'a-z', 'z-a'];
const VALID_SIMKL_TV_SORTS = ['popular-today', 'popular-this-week', 'popular-this-month', 'rank', 'votes', 'release-date', 'last-air-date', 'a-z', 'z-a'];
const VALID_TVDB_SORTS = ['score', 'firstAired', 'name', 'lastAired'];

const VALID_TMDB_MOVIE_GENRES = new Set([28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37]);
const VALID_TMDB_TV_GENRES = new Set([10759, 16, 35, 80, 99, 18, 10751, 10762, 9648, 10763, 10764, 10765, 10766, 10767, 10768, 37]);

const MAL_GENRE_NAMES: Record<number, string> = {
  1: 'Action', 2: 'Adventure', 3: 'Racing', 4: 'Comedy', 5: 'Avant Garde', 6: 'Mythology',
  7: 'Mystery', 8: 'Drama', 9: 'Ecchi', 10: 'Fantasy', 11: 'Strategy Game', 12: 'Hentai',
  13: 'Historical', 14: 'Horror', 15: 'Kids', 17: 'Martial Arts', 18: 'Mecha', 19: 'Music',
  20: 'Parody', 21: 'Samurai', 22: 'Romance', 23: 'School', 24: 'Sci-Fi', 25: 'Shoujo',
  26: 'Girls Love', 27: 'Shounen', 28: 'Boys Love', 29: 'Space', 30: 'Sports', 31: 'Super Power',
  32: 'Vampire', 35: 'Harem', 36: 'Slice of Life', 37: 'Supernatural', 38: 'Military',
  39: 'Detective', 40: 'Psychological', 41: 'Suspense', 42: 'Seinen', 43: 'Josei',
  46: 'Award Winning', 47: 'Gourmet', 48: 'Workplace', 49: 'Erotica', 50: 'Adult Cast',
  51: 'Anthropomorphic', 52: 'CGDCT', 53: 'Childcare', 54: 'Combat Sports', 55: 'Delinquents',
  56: 'Educational', 57: 'Gag Humor', 58: 'Gore', 59: 'High Stakes Game', 60: 'Idols (Female)',
  61: 'Idols (Male)', 62: 'Isekai', 63: 'Iyashikei', 64: 'Love Polygon', 65: 'Magical Sex Shift',
  66: 'Mahou Shoujo', 67: 'Medical', 68: 'Organized Crime', 69: 'Otaku Culture',
  70: 'Performing Arts', 71: 'Pets', 72: 'Reincarnation', 73: 'Reverse Harem',
  74: 'Love Status Quo', 75: 'Showbiz', 76: 'Survival', 77: 'Team Sports', 78: 'Time Travel',
  79: 'Video Game', 80: 'Visual Arts', 81: 'Crossdressing', 82: 'Urban Fantasy', 83: 'Villainess',
};

interface AvailableKeys {
  tmdb?: boolean;
  tvdb?: boolean;
}

function buildCatalogCreationPrompt(query: string, keys?: AvailableKeys): { systemPrompt: string; userPrompt: string } {
  const sections = [PROMPT_HEADER];
  if (!keys || keys.tmdb) sections.push(SOURCE_TMDB);
  sections.push(SOURCE_ANILIST, SOURCE_MAL, SOURCE_SIMKL);
  if (!keys || keys.tvdb) sections.push(SOURCE_TVDB);
  sections.push(PROMPT_FOOTER);
  return { systemPrompt: sections.join(''), userPrompt: query };
}

function parseCatalogAIResponse(rawText: string): ParsedAIResponse | null {
  if (!rawText) return null;

  let text = rawText.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed.catalogs)) {
      return { catalogs: parsed.catalogs.slice(0, 5) };
    }

    if (parsed.source && parsed.catalogType) {
      return { catalogs: [parsed] };
    }

    return null;
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.catalogs)) {
          return { catalogs: parsed.catalogs.slice(0, 5) };
        }
        if (parsed.source && parsed.catalogType) {
          return { catalogs: [parsed] };
        }
      } catch {
        return null;
      }
    }
    return null;
  }
}

const TMDB_GENRE_NAMES: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller',
  10752: 'War', 37: 'Western', 10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News',
  10764: 'Reality', 10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};

const SORT_CORRECTIONS: Record<string, Record<string, string>> = {
  series: { 'primary_release_date.desc': 'first_air_date.desc', 'primary_release_date.asc': 'first_air_date.asc', 'revenue.desc': 'popularity.desc' },
  movie: { 'first_air_date.desc': 'primary_release_date.desc', 'first_air_date.asc': 'primary_release_date.asc' },
};

function normalizeCatalog(catalog: AICatalogOutput): void {
  const typeAliases: Record<string, string> = { movies: 'movie', shows: 'series', tv: 'series' };
  if (typeAliases[catalog.catalogType]) catalog.catalogType = typeAliases[catalog.catalogType];

  if (catalog.source === 'tmdb') {
    const corrections = SORT_CORRECTIONS[catalog.catalogType];
    if (corrections && catalog.params.sort_by && corrections[catalog.params.sort_by]) {
      catalog.params.sort_by = corrections[catalog.params.sort_by];
    }

    if (catalog.catalogType === 'series') {
      for (const suffix of ['.gte', '.lte']) {
        if (catalog.params[`primary_release_date${suffix}`]) {
          catalog.params[`first_air_date${suffix}`] = catalog.params[`primary_release_date${suffix}`];
          delete catalog.params[`primary_release_date${suffix}`];
        }
      }
    } else if (catalog.catalogType === 'movie') {
      for (const suffix of ['.gte', '.lte']) {
        if (catalog.params[`first_air_date${suffix}`]) {
          catalog.params[`primary_release_date${suffix}`] = catalog.params[`first_air_date${suffix}`];
          delete catalog.params[`first_air_date${suffix}`];
        }
      }
    }

    for (const field of ['keywords', 'companies', 'people']) {
      if (catalog.params[field]) {
        if (!catalog.resolve) catalog.resolve = {};
        const value = catalog.params[field];
        const names = typeof value === 'string' ? value.split(/[|,]/).map((s: string) => s.trim()) : Array.isArray(value) ? value : [];
        const resolveKey = field === 'people' ? 'people' : field;
        if (!catalog.resolve[resolveKey]) catalog.resolve[resolveKey] = [];
        catalog.resolve[resolveKey].push(...names);
        delete catalog.params[field];
      }
    }

    for (const field of ['with_genres', 'without_genres']) {
      if (catalog.params[field]) {
        const validGenres = catalog.catalogType === 'movie' ? VALID_TMDB_MOVIE_GENRES : VALID_TMDB_TV_GENRES;
        const ids = String(catalog.params[field]).split(/[|,]/).map(Number);
        const validIds: number[] = [];
        const keywordsToAdd: string[] = [];
        for (const id of ids) {
          if (validGenres.has(id)) {
            validIds.push(id);
          } else if (TMDB_GENRE_NAMES[id]) {
            keywordsToAdd.push(TMDB_GENRE_NAMES[id].toLowerCase());
          }
        }
        if (keywordsToAdd.length > 0) {
          if (!catalog.resolve) catalog.resolve = {};
          const resolveField = field === 'with_genres' ? 'keywords' : 'excludeKeywords';
          if (!catalog.resolve[resolveField]) catalog.resolve[resolveField] = [];
          catalog.resolve[resolveField].push(...keywordsToAdd);
        }
        const sep = String(catalog.params[field]).includes('|') ? '|' : ',';
        if (validIds.length > 0) {
          catalog.params[field] = validIds.join(sep);
        } else {
          delete catalog.params[field];
        }
      }
    }
  }

  if (catalog.source === 'tvdb') {
    if (!catalog.params.country) catalog.params.country = 'usa';
    if (!catalog.params.lang) catalog.params.lang = 'eng';
    if (!catalog.resolve) catalog.resolve = {};
    for (const field of ['genre', 'status', 'contentRating']) {
      if (catalog.params[field] !== undefined) {
        const val = catalog.params[field];
        if (!catalog.resolve[field]?.length) {
          catalog.resolve[field] = [String(val)];
        }
        delete catalog.params[field];
      }
    }
  }

  if (catalog.source === 'simkl' && !catalog.params.media) {
    const typeMap: Record<string, string> = { movie: 'movies', series: 'shows', anime: 'anime' };
    catalog.params.media = typeMap[catalog.catalogType] || 'movies';
  }

  if (catalog.source === 'mal') {
    const malNameToId = Object.fromEntries(
      Object.entries(MAL_GENRE_NAMES).map(([id, name]) => [name.toLowerCase(), Number(id)])
    );
    for (const field of ['genres', 'genres_exclude']) {
      if (catalog.params[field]) {
        const parts = String(catalog.params[field]).split(',').map((s: string) => s.trim());
        const ids = parts.map(p => {
          const asNum = Number(p);
          if (Number.isFinite(asNum) && MAL_GENRE_NAMES[asNum]) return asNum;
          return malNameToId[p.toLowerCase()] ?? null;
        }).filter((id): id is number => id !== null);
        catalog.params[field] = ids.length ? ids.join(',') : undefined;
        if (!catalog.params[field]) delete catalog.params[field];
      }
    }
  }

  if (catalog.resolve) {
    for (const key of Object.keys(catalog.resolve)) {
      const val = catalog.resolve[key];
      if (typeof val === 'string') {
        catalog.resolve[key] = [val] as any;
      }
    }
  }
}

function validateCatalogParams(catalog: AICatalogOutput): ValidationResult {
  const errors: string[] = [];

  if (!VALID_SOURCES.includes(catalog.source as any)) {
    errors.push(`Invalid source: ${catalog.source}`);
  }

  if (!['movie', 'series', 'anime'].includes(catalog.catalogType)) {
    errors.push(`Invalid catalogType: ${catalog.catalogType}`);
  }

  if ((catalog.source === 'anilist' || catalog.source === 'mal') && catalog.catalogType !== 'anime') {
    errors.push(`${catalog.source} only supports catalogType "anime"`);
  }

  if ((catalog.source === 'tmdb' || catalog.source === 'tvdb') && !['movie', 'series'].includes(catalog.catalogType)) {
    errors.push(`${catalog.source} only supports catalogType "movie" or "series"`);
  }

  if (!catalog.name || catalog.name.length > 60) {
    errors.push('Name is required and must be under 60 chars');
  }

  if (catalog.source === 'tmdb') {
    const validSorts = catalog.catalogType === 'movie' ? VALID_TMDB_MOVIE_SORTS : VALID_TMDB_TV_SORTS;
    if (catalog.params.sort_by && !validSorts.includes(catalog.params.sort_by)) {
      errors.push(`Invalid TMDB sort_by: ${catalog.params.sort_by}`);
    }

    for (const field of ['with_genres', 'without_genres']) {
      if (catalog.params[field]) {
        const ids = String(catalog.params[field]).split(/[|,]/).map(Number);
        const validGenres = catalog.catalogType === 'movie' ? VALID_TMDB_MOVIE_GENRES : VALID_TMDB_TV_GENRES;
        for (const id of ids) {
          if (!validGenres.has(id)) {
            errors.push(`Invalid TMDB genre ID: ${id}`);
          }
        }
      }
    }
  }

  if (catalog.source === 'anilist') {
    if (catalog.params.sort && !VALID_ANILIST_SORTS.includes(catalog.params.sort)) {
      errors.push(`Invalid AniList sort: ${catalog.params.sort}`);
    }
  }

  if (catalog.source === 'mal') {
    if (catalog.params.order_by && !VALID_MAL_SORTS.includes(catalog.params.order_by)) {
      errors.push(`Invalid MAL order_by: ${catalog.params.order_by}`);
    }
  }

  if (catalog.source === 'simkl') {
    const isMovie = catalog.params.media === 'movies';
    const validSorts = isMovie ? VALID_SIMKL_MOVIE_SORTS : VALID_SIMKL_TV_SORTS;
    if (catalog.params.sort && !validSorts.includes(catalog.params.sort)) {
      errors.push(`Invalid Simkl sort: ${catalog.params.sort}`);
    }
  }

  if (catalog.source === 'tvdb') {
    if (catalog.params.sort && !VALID_TVDB_SORTS.includes(catalog.params.sort)) {
      errors.push(`Invalid TVDB sort: ${catalog.params.sort}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function pickBestMatch(results: any[], queryName: string): any | null {
  if (!results.length) return null;
  const nameLower = queryName.toLowerCase();
  const exactMatches = results.filter((r: any) => (r.name || r.title || '').toLowerCase() === nameLower);
  if (exactMatches.length) {
    exactMatches.sort((a: any, b: any) => a.id - b.id);
    return exactMatches[0];
  }
  return results[0];
}

interface ResolveContext {
  tmdbApiKey?: string;
  tvdbApiKey?: string;
  userUUID?: string;
}

interface ResolveResult {
  resolved: Record<string, string>;
  warnings: string[];
}

async function resolveEntities(catalog: AICatalogOutput, ctx: ResolveContext): Promise<ResolveResult> {
  const resolved: Record<string, string> = {};
  const warnings: string[] = [];
  const resolve = catalog.resolve;
  if (!resolve) return { resolved, warnings };

  const moviedb = require('../lib/getTmdb');
  const { httpGet, httpPost } = require('./httpClient');

  if (catalog.source === 'tmdb') {
    if (!ctx.tmdbApiKey) {
      logger.warn('[AI Catalog] No TMDB API key available for entity resolution');
      return { resolved, warnings };
    }
    const config = { apiKeys: { tmdb: ctx.tmdbApiKey } };

    if (resolve.companies?.length) {
      logger.info(`[AI Catalog] Resolving TMDB companies: ${resolve.companies.join(', ')}`);
      const items = await resolveNamedEntities(resolve.companies, async (name) => {
        const data = await moviedb.makeTmdbRequest('/search/company', ctx.tmdbApiKey, { query: name, page: 1 }, 'GET', null, config);
        const results = (data?.results || []).filter((r: any) => r?.id);
        const best = pickBestMatch(results, name);
        if (!best) return null;
        logger.debug(`[AI Catalog] Company "${name}" -> ID ${best.id} (${best.name})`);
        return { id: best.id, label: best.name || name };
      });
      if (items.length) resolved.with_companies = items.map(i => i.id).join('|');
      if (items.length) resolved._formState_withCompanies = JSON.stringify(items);
    }

    const allKeywords = [...(resolve.keywords || []), ...(resolve.excludeKeywords || [])];
    const excludeKeywordNames = new Set((resolve.excludeKeywords || []).map((n: string) => n.toLowerCase()));

    if (allKeywords.length) {
      logger.info(`[AI Catalog] Resolving TMDB keywords: ${allKeywords.join(', ')}`);
      const items = await resolveNamedEntities(allKeywords, async (name) => {
        const data = await moviedb.makeTmdbRequest('/search/keyword', ctx.tmdbApiKey, { query: name, page: 1 }, 'GET', null, config);
        const results = (data?.results || []).filter((r: any) => r?.id);
        const best = pickBestMatch(results, name);
        if (!best) return null;
        logger.debug(`[AI Catalog] Keyword "${name}" -> ID ${best.id} (${best.name})`);
        return { id: best.id, label: best.name || name, _exclude: excludeKeywordNames.has(name.toLowerCase()) };
      });
      const includeItems = items.filter((i: any) => !i._exclude);
      const excludeItems = items.filter((i: any) => i._exclude);
      if (includeItems.length) {
        resolved.with_keywords = includeItems.map(i => i.id).join('|');
        resolved._formState_withKeywords = JSON.stringify(includeItems.map(i => ({ id: i.id, label: i.label })));
      }
      if (excludeItems.length) {
        resolved.without_keywords = excludeItems.map(i => i.id).join('|');
        resolved._formState_withoutKeywords = JSON.stringify(excludeItems.map(i => ({ id: i.id, label: i.label })));
      }
    }

    if (resolve.people?.length) {
      logger.info(`[AI Catalog] Resolving TMDB people: ${resolve.people.join(', ')}`);
      const items = await resolveNamedEntities(resolve.people, async (name) => {
        const data = await moviedb.makeTmdbRequest('/search/person', ctx.tmdbApiKey, { query: name, page: 1, include_adult: false }, 'GET', null, config);
        const results = (data?.results || []).filter((r: any) => r?.id);
        const best = pickBestMatch(results, name);
        if (!best) return null;
        logger.debug(`[AI Catalog] Person "${name}" -> ID ${best.id} (${best.name})`);
        return { id: best.id, label: best.name || name };
      });
      if (items.length) resolved.with_people = items.map(i => i.id).join('|');
      if (items.length) resolved._formState_selectedPeople = JSON.stringify(items);
    }

    if (resolve.watchProviders?.length) {
      const mediaType = catalog.mediaType === 'tv' ? 'tv' : 'movie';
      const region = String(catalog.params.watch_region || catalog.params.watchRegion || 'US').toUpperCase();
      if (!catalog.params.watch_region) catalog.params.watch_region = region;
      const providersData = await moviedb.makeTmdbRequest(`/watch/providers/${mediaType}`, ctx.tmdbApiKey, { watch_region: region }, 'GET', null, config);
      const allProviders = providersData?.results || [];
      const items: Array<{ id: number; label: string }> = [];
      for (const name of resolve.watchProviders) {
        const match = allProviders.find((p: any) => p.provider_name?.toLowerCase() === name.toLowerCase());
        if (match?.provider_id) items.push({ id: match.provider_id, label: match.provider_name || name });
      }
      if (items.length) {
        resolved.with_watch_providers = items.map(i => i.id).join('|');
        resolved.with_watch_monetization_types = 'flatrate|free|ads|rent|buy';
        resolved._formState_watchProviders = JSON.stringify(items);
      }
    }
  }

  if (catalog.source === 'anilist' && resolve.studios?.length) {
    const anilist = require('../lib/anilist');
    const items: Array<{ id: number; label: string }> = [];
    for (const name of resolve.studios) {
      try {
        const results = await anilist.searchStudios(name);
        logger.info(`[AI Catalog] AniList studio search "${name}": ${results?.length ?? 0} results${results?.[0] ? ` (top: ${results[0].name}, id: ${results[0].id})` : ''}`);
        if (results?.[0]?.id) items.push({ id: results[0].id, label: results[0].name || name });
      } catch (e: any) {
        logger.warn(`[AI Catalog] Failed to resolve AniList studio "${name}": ${e.message}`);
      }
    }
    if (items.length) {
      resolved.studios = items.map(i => i.id).join(',');
      resolved._formState_anilistSelectedStudios = JSON.stringify(items);
    }
  }

  if (catalog.source === 'mal' && resolve.producers?.length) {
    const JIKAN_API_BASE = process.env.JIKAN_API_BASE || 'https://api.jikan.moe/v4';
    const items: Array<{ id: number; label: string }> = [];
    for (const name of resolve.producers) {
      try {
        const url = `${JIKAN_API_BASE}/producers?q=${encodeURIComponent(name)}&limit=5&order_by=favorites&sort=desc`;
        const response = await httpGet(url, { timeout: 15000 });
        const firstResult = response.data?.data?.[0];
        if (firstResult?.mal_id) {
          const defaultTitle = firstResult.titles?.find((t: any) => t.type === 'Default');
          items.push({ id: firstResult.mal_id, label: defaultTitle?.title || firstResult.name || name });
        }
      } catch (e: any) {
        logger.warn(`Failed to resolve MAL producer "${name}": ${e.message}`);
      }
    }
    if (items.length) {
      resolved.producers = items.map(i => i.id).join(',');
      resolved._formState_malProducers = JSON.stringify(items);
    }
  }

  if (catalog.source === 'tvdb' && ctx.tvdbApiKey) {
    const tvdbApi = require('../lib/tvdb');
    const tvdbConfig = { apiKeys: { tvdb: ctx.tvdbApiKey }, ...(ctx.userUUID ? { userUUID: ctx.userUUID } : {}) };

    if (resolve.company?.length) {
      try {
        const searchData = await tvdbApi.searchCompanies(resolve.company[0], tvdbConfig);
        const results = Array.isArray(searchData) ? searchData : [];
        if (results[0]?.id) {
          resolved.company = String(results[0].id);
          resolved._formState_withCompanies = JSON.stringify([{ id: results[0].id, label: results[0].name || resolve.company[0] }]);
        }
      } catch (e: any) {
        logger.warn(`Failed to resolve TVDB company "${resolve.company[0]}": ${e.message}`);
      }
    }

    if (resolve.genre?.length) {
      try {
        const genres = await tvdbApi.getAllGenres(tvdbConfig);
        const val = resolve.genre[0];
        const asNum = Number(val);
        const match = Number.isFinite(asNum)
          ? genres.find((g: any) => g.id === asNum)
          : genres.find((g: any) => g.name?.toLowerCase() === val.toLowerCase());
        if (match?.id) {
          resolved.genre = String(match.id);
          resolved._formState_includeGenres = JSON.stringify([{ id: match.id, label: match.name }]);
        } else {
          logger.warn(`[AI Catalog] TVDB genre "${val}" not found`);
          warnings.push(`Could not resolve genre "${resolve.genre[0]}"`);
        }
      } catch (e: any) {
        logger.warn(`Failed to resolve TVDB genre "${resolve.genre[0]}": ${e.message}`);
      }
    }

    if (resolve.status?.length) {
      try {
        const tvdbType = catalog.catalogType === 'movie' ? 'movies' : 'series';
        const statuses = await tvdbApi.getStatuses(tvdbType, tvdbConfig);
        const val = resolve.status[0];
        const asNum = Number(val);
        const match = Number.isFinite(asNum)
          ? statuses.find((s: any) => s.id === asNum)
          : statuses.find((s: any) => s.name?.toLowerCase() === val.toLowerCase());
        if (match?.id != null) {
          resolved.status = String(match.id);
          resolved._formState_tvdbStatus = String(match.id);
        } else {
          logger.warn(`[AI Catalog] TVDB status "${val}" not found`);
          warnings.push(`Could not resolve status "${resolve.status[0]}"`);
        }
      } catch (e: any) {
        logger.warn(`Failed to resolve TVDB status "${resolve.status[0]}": ${e.message}`);
      }
    }

    if (resolve.contentRating?.length) {
      try {
        const ratings = await tvdbApi.getAllContentRatings(tvdbConfig);
        const val = resolve.contentRating[0];
        const asNum = Number(val);
        const match = Number.isFinite(asNum)
          ? ratings.find((r: any) => r.id === asNum)
          : ratings.find((r: any) => r.name?.toLowerCase() === val.toLowerCase());
        if (match?.id != null) {
          resolved.contentRating = String(match.id);
          resolved._formState_certificationValue = String(match.id);
        } else {
          logger.warn(`[AI Catalog] TVDB content rating "${val}" not found`);
          warnings.push(`Could not resolve content rating "${resolve.contentRating[0]}"`);
        }
      } catch (e: any) {
        logger.warn(`Failed to resolve TVDB content rating "${resolve.contentRating[0]}": ${e.message}`);
      }
    }
  }

  return { resolved, warnings };
}

async function resolveNamedEntities(names: string[], resolver: (name: string) => Promise<{ id: number; label: string } | null>): Promise<Array<{ id: number; label: string }>> {
  const items: Array<{ id: number; label: string }> = [];
  for (const name of names) {
    try {
      const result = await resolver(name);
      if (result) {
        items.push(result);
      } else {
        logger.warn(`[AI Catalog] Could not resolve "${name}" - no results`);
      }
    } catch (e: any) {
      logger.error(`[AI Catalog] Failed to resolve "${name}": ${e.message}`);
    }
  }
  return items;
}

interface CatalogConfig {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  showInHome: boolean;
  source: string;
  cacheTTL: number;
  metadata: {
    description: string;
    discover: {
      version: number;
      source: string;
      mediaType: string;
      params: Record<string, any>;
      formState: Record<string, any>;
    };
  };
}

function deriveFormState(source: string, catalogType: string, params: Record<string, any>): Record<string, any> {
  const fs: Record<string, any> = {};

  if (source === 'tmdb') {
    fs.includeAdult = params.include_adult ?? false;
    if (params['vote_count.gte']) fs.voteCountMin = Number(params['vote_count.gte']);
    if (params['vote_average.gte'] !== undefined || params['vote_average.lte'] !== undefined) {
      fs.voteAverageRange = [Number(params['vote_average.gte'] ?? 0), Number(params['vote_average.lte'] ?? 10)];
    }
    if (params['with_runtime.gte'] !== undefined || params['with_runtime.lte'] !== undefined) {
      fs.runtimeRange = [Number(params['with_runtime.gte'] ?? 0), Number(params['with_runtime.lte'] ?? 400)];
    }
    if (params.with_original_language) fs.originalLanguage = params.with_original_language;
    if (params.with_origin_country) fs.originCountry = params.with_origin_country;
    if (params.certification_country) fs.certificationCountry = params.certification_country;
    if (params.certification) fs.certificationValue = params.certification;
    if (params['certification.lte']) { fs.certificationValue = params['certification.lte']; fs.certificationMode = 'lte'; }
    if (params['certification.gte']) { fs.certificationValue = params['certification.gte']; fs.certificationMode = 'gte'; }
    if (params.watch_region) fs.watchRegion = params.watch_region;
    if (params.region) fs.releaseRegion = params.region;
    if (params.with_release_type === '4|5|6' || params.with_status === '0|3|4|5') fs.releasedOnly = true;

    if (catalogType === 'movie') {
      if (params['primary_release_date.gte']) fs.primaryReleaseFrom = params['primary_release_date.gte'];
      if (params['primary_release_date.lte']) fs.primaryReleaseTo = params['primary_release_date.lte'];
    } else {
      if (params['first_air_date.gte']) fs.firstAirFrom = params['first_air_date.gte'];
      if (params['first_air_date.lte']) fs.firstAirTo = params['first_air_date.lte'];
      if (params['air_date.gte']) fs.airDateFrom = params['air_date.gte'];
      if (params['air_date.lte']) fs.airDateTo = params['air_date.lte'];
    }

    if (params.with_genres) {
      const ids = String(params.with_genres).split(/[|,]/).map(Number);
      fs.includeGenres = ids.map(id => ({ id, label: TMDB_GENRE_NAMES[id] || `Genre ${id}` }));
      fs.genreJoinMode = String(params.with_genres).includes('|') ? 'or' : 'and';
    }
    if (params.without_genres) {
      const ids = String(params.without_genres).split(/[|,]/).map(Number);
      fs.excludeGenres = ids.map(id => ({ id, label: TMDB_GENRE_NAMES[id] || `Genre ${id}` }));
    }
  }

  if (source === 'anilist') {
    if (params.genre_in) fs.anilistIncludeGenres = String(params.genre_in).split(',').map((s: string) => s.trim());
    if (params.genre_not_in) fs.anilistExcludeGenres = String(params.genre_not_in).split(',').map((s: string) => s.trim());
    if (params.tag_in) fs.anilistIncludeTags = String(params.tag_in).split(',').map((s: string) => s.trim());
    if (params.tag_not_in) fs.anilistExcludeTags = String(params.tag_not_in).split(',').map((s: string) => s.trim());
    if (params.format_in) fs.anilistFormats = String(params.format_in).split(',').map((s: string) => s.trim());
    if (params.season) fs.anilistSeason = params.season;
    if (params.seasonYear) fs.anilistSeasonYear = String(params.seasonYear);
    if (params.status) fs.anilistStatus = params.status;
    if (params.countryOfOrigin) fs.anilistCountry = params.countryOfOrigin;
    if (params.averageScore_greater !== undefined || params.averageScore_lesser !== undefined) {
      fs.anilistScoreRange = [Number(params.averageScore_greater ?? 0), Number(params.averageScore_lesser ?? 100)];
    }
    if (params.popularity_greater) fs.anilistPopularityMin = Number(params.popularity_greater);
    if (params.episodes_greater !== undefined || params.episodes_lesser !== undefined) {
      fs.anilistEpisodesRange = [Number(params.episodes_greater ?? 0), Number(params.episodes_lesser ?? 200)];
    }
    if (params.duration_greater !== undefined || params.duration_lesser !== undefined) {
      fs.anilistDurationRange = [Number(params.duration_greater ?? 0), Number(params.duration_lesser ?? 180)];
    }
    if (params.isAdult !== undefined) fs.anilistIsAdult = params.isAdult;
    if (params.startDate_greater) fs.anilistStartDateFrom = String(params.startDate_greater).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    if (params.startDate_lesser) fs.anilistStartDateTo = String(params.startDate_lesser).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  }

  if (source === 'mal') {
    if (params.sort) fs.malSortDirection = params.sort;
    if (params.type) fs.malType = params.type;
    if (params.status) fs.malStatus = params.status;
    if (params.rating) fs.malRating = params.rating;
    if (params.min_score) fs.malMinScore = Number(params.min_score);
    if (params.max_score) fs.malMaxScore = Number(params.max_score);
    if (params.season) fs.malSeason = params.season;
    if (params.seasonYear) fs.malSeasonYear = String(params.seasonYear);
    if (params.start_date) fs.malStartDate = params.start_date;
    if (params.end_date) fs.malEndDate = params.end_date;
    if (params.sfw !== undefined) fs.malSfw = params.sfw;
    if (params.genres) {
      fs.malIncludeGenreIds = String(params.genres).split(',').map((s: string) => {
        const id = Number(s.trim());
        return { id, label: MAL_GENRE_NAMES[id] || `Genre ${id}` };
      });
    }
    if (params.genres_exclude) {
      fs.malExcludeGenreIds = String(params.genres_exclude).split(',').map((s: string) => {
        const id = Number(s.trim());
        return { id, label: MAL_GENRE_NAMES[id] || `Genre ${id}` };
      });
    }
  }

  if (source === 'simkl') {
    if (params.media) fs.simklMediaType = params.media;
    if (params.genre) fs.simklGenre = params.genre;
    if (params.type) fs.simklType = params.type;
    if (params.country) fs.simklCountry = params.country;
    if (params.network) fs.simklNetwork = params.network;
    if (params.year) fs.simklYear = params.year;
  }

  if (source === 'tvdb') {
    if (params.sortType) fs.tvdbSortDirection = params.sortType;
    if (params.status) fs.tvdbStatus = String(params.status);
    if (params.year) fs.tvdbYear = String(params.year);
    if (params.country) fs.originCountry = params.country;
    if (params.lang) fs.originalLanguage = params.lang;
    if (params.genre) fs.includeGenres = [{ id: Number(params.genre), label: `Genre ${params.genre}` }];
    if (params.contentRating) fs.certificationValue = String(params.contentRating);
  }

  return fs;
}


function buildCatalogConfigs(catalogs: AICatalogOutput[], resolvedParams: Record<string, string>[], originalQuery: string, cacheTTL?: number, perCatalogWarnings?: string[][]): CatalogConfig[] {
  const SOURCE_PREFIXES: Record<string, string> = {
    tmdb: 'tmdb.discover',
    tvdb: 'tvdb.discover',
    simkl: 'simkl.discover',
    mal: 'mal.discover',
    anilist: 'anilist.discover',
  };

  const SOURCE_LABELS: Record<string, string> = {
    tmdb: 'TMDB',
    tvdb: 'TVDB',
    simkl: 'SIMKL',
    mal: 'MAL',
    anilist: 'ANILIST',
  };

  return catalogs.map((catalog, i) => {
    const sanitizedName = catalog.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'ai_catalog';
    const uniqueSuffix = (Date.now() + i).toString(36);

    const sourcePrefix = SOURCE_PREFIXES[catalog.source] ?? 'tmdb.discover';
    const catalogTypeSegment = catalog.source === 'simkl'
      ? catalog.params.media || catalog.catalogType
      : (catalog.source === 'anilist' || catalog.source === 'mal')
        ? 'anime'
        : catalog.catalogType;

    const catalogId = `${sourcePrefix}.${catalogTypeSegment}.${sanitizedName}.${uniqueSuffix}`;

    const resolved = resolvedParams[i] || {};
    const catalogWarnings = perCatalogWarnings?.[i] || [];

    // Separate _formState_ metadata from actual params
    const formStateExtras: Record<string, any> = {};
    const cleanResolved: Record<string, any> = {};
    for (const [key, value] of Object.entries(resolved)) {
      if (key.startsWith('_formState_')) {
        const formKey = key.replace('_formState_', '');
        try { formStateExtras[formKey] = JSON.parse(value); } catch { formStateExtras[formKey] = value; }
      } else {
        cleanResolved[key] = value;
      }
    }

    const mergedParams = { ...catalog.params, ...cleanResolved };

    const sourceLabel = SOURCE_LABELS[catalog.source] ?? 'TMDB';
    const discoverMediaType = catalog.mediaType || catalog.catalogType;

    // Derive full formState from params so BYC editor can reconstruct the form
    const derivedFormState = deriveFormState(catalog.source, catalog.catalogType, mergedParams);

    return {
      id: catalogId,
      type: catalog.catalogType,
      name: catalog.name,
      enabled: true,
      showInHome: true,
      source: catalog.source,
      cacheTTL: cacheTTL ?? 86400,
      metadata: {
        description: `${sourceLabel} Discover (${discoverMediaType}) - AI Generated`,
        discover: {
          version: 2,
          source: catalog.source,
          mediaType: discoverMediaType,
          params: mergedParams,
          formState: {
            catalogName: catalog.name,
            discoverSource: catalog.source,
            catalogType: catalog.catalogType,
            sortBy: mergedParams.sort_by || mergedParams.sort || mergedParams.order_by,
            aiGenerated: true,
            aiQuery: originalQuery,
            ...(catalogWarnings.length ? { aiWarnings: catalogWarnings } : {}),
            ...derivedFormState,
            ...formStateExtras,
          },
        },
      },
    };
  });
}

export {
  buildCatalogCreationPrompt,
  parseCatalogAIResponse,
  normalizeCatalog,
  validateCatalogParams,
  resolveEntities,
  buildCatalogConfigs,
};

module.exports = {
  buildCatalogCreationPrompt,
  parseCatalogAIResponse,
  normalizeCatalog,
  validateCatalogParams,
  resolveEntities,
  buildCatalogConfigs,
};
