// Standard genres for movies and series (44 genres)
const STANDARD_GENRES = [
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
const ANIME_SUB_GENRES = [
  "Anime: Boys' Love (Yaoi)",
  "Anime-Ecchi",
  "Anime-Historical",
  "Anime-Isekai",
  "Anime-Josei",
  "Anime-Martial-Arts",
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
  "Anime-Slice-of-Life",
  "Anime-Space",
  "Anime-Sports",
  "Anime-Supernatural",
  "Anime-Vampire",
  "Anime-Yuri"
];

// All genres combined (66 total)
const ALL_GENRES = [...STANDARD_GENRES, ...ANIME_SUB_GENRES];

// Helper function to get genres based on selection
function getGenresBySelection(selection) {
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

module.exports = {
  STANDARD_GENRES,
  ANIME_SUB_GENRES,
  ALL_GENRES,
  getGenresBySelection
};
