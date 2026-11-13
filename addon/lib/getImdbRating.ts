// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
const { getImdbRatingString }: any = require('./imdbRatings');

async function getImdbRating(imdbId: string): Promise<string | undefined> {
  if (!imdbId) {
    return undefined;
  }

  return await getImdbRatingString(imdbId);
}

export { getImdbRating };
module.exports = { getImdbRating };
