const crypto = require('crypto');

function hashMarker(value) {
  const normalized = typeof value === 'string'
    ? value.trim()
    : value === null || value === undefined
      ? ''
      : String(value);
  if (!normalized) return 'none';
  return crypto.createHash('sha1').update(normalized).digest('hex').substring(0, 16);
}

function getMergedChildAuthFingerprint(childCatalog, fullConfig = {}) {
  const childId = String(childCatalog?.id || '');
  const apiKeys = fullConfig?.apiKeys || {};

  if (childId === 'tmdb.watchlist' || childId === 'tmdb.favorites') {
    return `tmdb:${hashMarker(fullConfig?.sessionId || '')}`;
  }

  if (childId.startsWith('trakt.')) {
    return `trakt:${hashMarker(apiKeys.traktTokenId || '')}`;
  }

  if (childId.startsWith('simkl.watchlist.')) {
    return `simkl:${hashMarker(apiKeys.simklTokenId || '')}`;
  }

  if (childId.startsWith('anilist.') && childId !== 'anilist.trending') {
    return `anilist:${hashMarker(apiKeys.anilistTokenId || '')}`;
  }

  if (childId.startsWith('mdblist.')) {
    return `mdblist:${hashMarker(apiKeys.mdblist || process.env.MDBLIST_API_KEY || '')}`;
  }

  return 'none';
}

module.exports = {
  getMergedChildAuthFingerprint,
};
