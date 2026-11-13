// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
interface Genre {
  id: number;
  name: string;
}

// TMDB's Animation genre. Its name follows the request language, so a list read in
// Portuguese says "Animação"; the id is the same in every language.
const TMDB_ANIMATION = 16;

function isAnime(mediaObject: any, genreList: Genre[] = []): boolean {
  if (!mediaObject) {
    return false;
  }

  const genreNames = new Set<string>();
  const genreIds = new Set<number>();

  if (Array.isArray(mediaObject.genres)) {
    mediaObject.genres.forEach((g: any) => {
      if (Number.isFinite(g?.id)) genreIds.add(g.id);
      if (g?.name) genreNames.add(String(g.name).toLowerCase());
    });
  } else if (Array.isArray(mediaObject.genre_ids)) {
    mediaObject.genre_ids.forEach((id: number) => {
      genreIds.add(id);
      const genre = genreList.find(g => g.id === id);
      if (genre && genre.name) {
        genreNames.add(genre.name.toLowerCase());
      }
    });
  }

  const hasAnimationGenre = genreIds.has(TMDB_ANIMATION) || genreNames.has('animation');
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
