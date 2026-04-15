function resolveOneToOneSeasonEpisodeFallback(mappedImdbSeasons, tmdbEpisodeNumber, tmdbSeasonEpisodeCount) {
  if (!Array.isArray(mappedImdbSeasons) || mappedImdbSeasons.length !== 1) {
    return null;
  }

  const [imdbSeasonNum, imdbSeasonEpisodes] = mappedImdbSeasons[0];
  const expectedEpisodeCount = Number.parseInt(tmdbSeasonEpisodeCount, 10);

  if (!Number.isFinite(expectedEpisodeCount) || expectedEpisodeCount <= 0 || !Array.isArray(imdbSeasonEpisodes)) {
    return null;
  }

  if (imdbSeasonEpisodes.length !== expectedEpisodeCount) {
    return null;
  }

  const exactEpisodeMatches = imdbSeasonEpisodes.filter(episode => episode.episode === tmdbEpisodeNumber);
  if (exactEpisodeMatches.length !== 1) {
    return null;
  }

  return {
    season: imdbSeasonNum,
    episode: exactEpisodeMatches[0].episode
  };
}

module.exports = {
  resolveOneToOneSeasonEpisodeFallback
};
