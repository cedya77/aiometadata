// Standard genres for movies and series (44 genres) - using slug format for MDBList API compatibility
const STANDARD_GENRES = [
  "action",
  "adult",
  "adventure",
  "animation",
  "anime",
  "biography",
  "children",
  "comedy",
  "crime",
  "documentary",
  "donghua",
  "drama",
  "eastern",
  "family",
  "fantasy",
  "film-noir",
  "game-show",
  "history",
  "holiday",
  "home-and-garden",
  "horror",
  "kids",
  "music",
  "musical",
  "mystery",
  "news",
  "reality",
  "reality-tv",
  "romance",
  "sci-fi",
  "science-fiction",
  "short",
  "soap",
  "special-interest",
  "sport",
  "sporting-event",
  "superhero",
  "suspense",
  "talk",
  "talk-show",
  "thriller",
  "tv-movie",
  "war",
  "western"
];

// Anime sub-genres (22 genres) - using slug format for MDBList API compatibility
const ANIME_SUB_GENRES = [
  "anime-bl",
  "anime-ecchi",
  "anime-historical",
  "anime-isekai",
  "anime-josei",
  "anime-martial-arts",
  "anime-mecha",
  "anime-military",
  "anime-music",
  "anime-parody",
  "anime-psychological",
  "anime-samurai",
  "anime-school",
  "anime-seinen",
  "anime-shoujo",
  "anime-shounen",
  "anime-slice-of-life",
  "anime-space",
  "anime-sports",
  "anime-supernatural",
  "anime-vampire",
  "anime-yuri"
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
