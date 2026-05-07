interface EpisodeEntry {
  episode: number;
  [key: string]: any;
}

interface SeasonEpisodeResult {
  season: number;
  episode: number;
}

function resolveOneToOneSeasonEpisodeFallback(mappedImdbSeasons: any[], tmdbEpisodeNumber: number, tmdbSeasonEpisodeCount: number | string): SeasonEpisodeResult | null {
  if (!Array.isArray(mappedImdbSeasons) || mappedImdbSeasons.length !== 1) {
    return null;
  }

  const [imdbSeasonNum, imdbSeasonEpisodes] = mappedImdbSeasons[0];
  const expectedEpisodeCount = Number.parseInt(String(tmdbSeasonEpisodeCount), 10);

  if (!Number.isFinite(expectedEpisodeCount) || expectedEpisodeCount <= 0 || !Array.isArray(imdbSeasonEpisodes)) {
    return null;
  }

  if (imdbSeasonEpisodes.length !== expectedEpisodeCount) {
    return null;
  }

  const exactEpisodeMatches = imdbSeasonEpisodes.filter((episode: EpisodeEntry) => episode.episode === tmdbEpisodeNumber);
  if (exactEpisodeMatches.length !== 1) {
    return null;
  }

  return {
    season: imdbSeasonNum,
    episode: exactEpisodeMatches[0].episode
  };
}

export { resolveOneToOneSeasonEpisodeFallback };
module.exports = { resolveOneToOneSeasonEpisodeFallback };
