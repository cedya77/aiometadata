require('dotenv').config();
const fanart = require('../utils/fanart');
const moviedb = require('./getTmdb');

const TARGET_ASPECT_RATIO = 4.0;

const SKIP_LOGO_ERROR_MESSAGES = new Set([
  'TMDB_API_KEY_MISSING',
  'TMDB_API_KEY_INVALID',
  'TMDB API key is required.',
  'TMDB API key not found in config or environment.',
]);

function shouldSkipLogoError(message) {
  if (!message) return false;
  if (SKIP_LOGO_ERROR_MESSAGES.has(message)) return true;
  if (/invalid.*api.*key/i.test(message)) return true;
  return false;
}

/**
 * @param {object} tmdbLogo - Raw logo from TMDB images API.
 * @returns {string} Normalized language key for matching (e.g. pt-BR, pt, en).
 */
function tmdbLogoLang(tmdbLogo) {
  const iso = tmdbLogo.iso_639_1;
  const region = tmdbLogo.iso_3166_1;
  if (iso && region) return `${iso}-${region}`;
  if (iso) return iso;
  return 'en';
}

/**
 * @param {Array} logos - Combined list from Fanart + TMDB (with source, scores metadata).
 * @param {string} language - User language (e.g. pt-BR).
 * @param {string} originalLanguage - Original audio language (e.g. ja).
 * @returns {object|undefined} Best logo object.
 */
function pickLogo(logos, language, originalLanguage) {
  if (!logos || logos.length === 0) return undefined;

  const fullLang = language;
  const baseLang = (language || 'en').split('-')[0];

  const sortedLogos = logos
    .map((logo) => {
      let score = 0;
      const logoLang = logo.lang || 'en';
      if (logoLang === fullLang) {
        score = 4;
      } else if (logoLang.startsWith(`${baseLang}-`)) {
        score = 3;
      } else if (logoLang === baseLang) {
        score = 2;
      } else if (logoLang === 'en') {
        score = 1;
      } else if (logoLang === originalLanguage && logoLang !== 'en') {
        score = 0.5;
      }

      let aspectRatioDiff = 999;
      if (logo.source === 'tmdb' && logo.aspect_ratio != null) {
        aspectRatioDiff = Math.abs(logo.aspect_ratio - TARGET_ASPECT_RATIO);
      }

      return {
        ...logo,
        score,
        fanartLikes: logo.source === 'fanart' ? parseInt(logo.likes, 10) || 0 : 0,
        tmdbVotes: logo.source === 'tmdb' ? logo.vote_average || 0 : 0,
        aspectRatioDiff,
      };
    })
    .sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      if (a.source === 'tmdb' && b.source === 'tmdb') {
        if (a.aspectRatioDiff !== b.aspectRatioDiff) {
          return a.aspectRatioDiff - b.aspectRatioDiff;
        }
        return b.tmdbVotes - a.tmdbVotes;
      }
      if (a.source === 'fanart' && b.source === 'fanart') {
        return b.fanartLikes - a.fanartLikes;
      }
      if (a.source === 'fanart' && b.source !== 'fanart') return -1;
      if (a.source !== 'fanart' && b.source === 'fanart') return 1;

      return 0;
    });

  return sortedLogos[0];
}

/**
 * @param {'movie'|'series'} type - Media type.
 * @param {{tmdbId: string, tvdbId?: string}} ids - IDs for Fanart/TMDB.
 * @param {string} language - User language.
 * @param {string} originalLanguage - Original language code.
 * @param {object} config - Addon config (API keys, etc.).
 * @returns {Promise<string>} Logo URL or empty string.
 */
async function getLogo(type, ids, language, originalLanguage, config) {
  try {
    const { tmdbId, tvdbId } = ids;

    let fanartPromise;
    let tmdbPromise;

    if (type === 'movie' && tmdbId) {
      fanartPromise = fanart.getMovieImages(tmdbId, config);
      tmdbPromise = moviedb.movieImages({ id: tmdbId }, config);
    } else if (type === 'series' && (tmdbId || tvdbId)) {
      fanartPromise = tvdbId ? fanart.getShowImages(tvdbId, config) : Promise.resolve({});
      tmdbPromise = tmdbId ? moviedb.tvImages({ id: tmdbId }, config) : Promise.resolve({});
    } else {
      return '';
    }

    const [fanartRes, tmdbRes] = await Promise.all([
      fanartPromise.catch(() => ({})),
      tmdbPromise.catch(() => ({})),
    ]);

    const raw = fanartRes || {};
    const fanartLogosSource =
      type === 'movie'
        ? raw.hdmovielogo || []
        : raw.hdtvlogo || [];

    const fanartLogos = fanartLogosSource.map((l) => ({
      url: l.url,
      lang: l.lang || 'en',
      likes: l.likes,
      source: 'fanart',
    }));

    const tmdbLogosSource = (tmdbRes && tmdbRes.logos) || [];
    const tmdbLogos = tmdbLogosSource.map((l) => ({
      url: `https://image.tmdb.org/t/p/original${l.file_path}`,
      lang: tmdbLogoLang(l),
      vote_average: l.vote_average,
      aspect_ratio: l.aspect_ratio,
      source: 'tmdb',
    }));

    const combined = [...fanartLogos, ...tmdbLogos];

    if (combined.length === 0) return '';

    const picked = pickLogo(combined, language, originalLanguage);
    return picked?.url || '';
  } catch (error) {
    if (!shouldSkipLogoError(error.message)) {
      console.error(
        `Error fetching clear logo for type=${type}, ids=${JSON.stringify(ids)}:`,
        error.message
      );
    }
    return '';
  }
}

module.exports = { getLogo };
