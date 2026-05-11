interface Genre {
  id: number;
  name: string;
}

function isAnime(mediaObject: any, genreList: Genre[] = []): boolean {
  if (!mediaObject) {
    return false;
  }

  const genreNames = new Set<string>();

  if (Array.isArray(mediaObject.genres)) {
    mediaObject.genres.forEach((g: any) => genreNames.add(g.name.toLowerCase()));
  } else if (Array.isArray(mediaObject.genre_ids)) {
    mediaObject.genre_ids.forEach((id: number) => {
      const genre = genreList.find(g => g.id === id);
      if (genre && genre.name) {
        genreNames.add(genre.name.toLowerCase());
      }
    });
  }

  const hasAnimationGenre = genreNames.has('animation');
  const hasAnimeGenre = genreNames.has('anime');

  if (!hasAnimationGenre && !hasAnimeGenre) {
    return false;
  }

  const originalLanguage = mediaObject.original_language || mediaObject.originalLanguage;
  const originalCountry = mediaObject.originalCountry;

  if ((originalLanguage === 'ja' || originalCountry === 'jp' || originalCountry === 'jpn') && (hasAnimeGenre || hasAnimationGenre)) {
    return true;
  }

  if (hasAnimeGenre) {
    return true;
  }
  return false;
}

export { isAnime };
