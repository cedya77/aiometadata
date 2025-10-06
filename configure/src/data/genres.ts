// Standard genres for movies and series (44 genres)
export const STANDARD_GENRES = [
  "Action",
  "Adult",
  "Adventure",
  "Animation",
  "Anime",
  "Biography",
  "Children",
  "Comedy",
  "Crime",
  "Documentary",
  "Donghua",
  "Drama",
  "Eastern",
  "Family",
  "Fantasy",
  "Film Noir",
  "Game Show",
  "History",
  "Holiday",
  "Home and Garden",
  "Horror",
  "Kids",
  "Music",
  "Musical",
  "Mystery",
  "News",
  "Reality",
  "Reality TV",
  "Romance",
  "Sci-Fi",
  "Science Fiction",
  "Short",
  "Soap",
  "Special Interest",
  "Sport",
  "Sporting Event",
  "Superhero",
  "Suspense",
  "Talk",
  "Talk Show",
  "Thriller",
  "TV Movie",
  "War",
  "Western"
];

// Anime sub-genres (22 genres)
export const ANIME_SUB_GENRES = [
  "Anime-Boys' Love (Yaoi)",
  "Anime-Historical",
  "Anime-Isekai",
  "Anime-Josei",
  "Anime-Martial Arts",
  "Anime-Mecha",
  "Anime-Military",
  "Anime-Music",
  "Anime-Parody",
  "Anime-Psychological",
  "Anime-Samurai",
  "Anime-School",
  "Anime-Seinen",
  "Anime-Shoujo",
  "Anime-Shounen",
  "Anime-Slice of Life",
  "Anime-Space",
  "Anime-Sports",
  "Anime-Supernatural",
  "Anime-Vampire",
  "Anime-Yuri"
];

// All genres combined (66 total)
export const ALL_GENRES = [...STANDARD_GENRES, ...ANIME_SUB_GENRES];

// Genre selection types
export type GenreSelection = 'standard' | 'anime' | 'all';

// Helper function to get genres based on selection
export function getGenresBySelection(selection: GenreSelection): string[] {
  switch (selection) {
    case 'standard':
      return STANDARD_GENRES;
    case 'anime':
      return ANIME_SUB_GENRES;
    case 'all':
      return ALL_GENRES;
    default:
      return STANDARD_GENRES;
  }
}
