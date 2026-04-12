const axios = require('axios');
const { cache } = require("../lib/getCache");

const CHECK_INTERVAL_DAYS = 7; // You can adjust as needed
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // Ex: 'mrcanelas/tmdb-addon'

async function getLastChecked(tmdbId) {
  if (!cache) return null;
  return await cache.get(`lastChecked:${tmdbId}`);
}

async function setLastChecked(tmdbId, data) {
  if (!cache) return;
  await cache.set(`lastChecked:${tmdbId}`, data, { ttl: 365 * 24 * 60 * 60 });
}

async function openGithubIssue(title, body, labels = []) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  await axios.post(
    `https://api.github.com/repos/${GITHUB_REPO}/issues`,
    { title, body, labels },
    { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
  );
}

async function issueExistsOnGithub(title) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return false;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/issues?labels=season-mismatch&per_page=100`;
  try {
    const resp = await axios.get(url, {
      headers: { Authorization: `token ${GITHUB_TOKEN}` }
    });
    return resp.data.some(issue => issue.title === title);
  } catch (e) {
    console.error('Error checking existing issues:', e.message);
    return false;
  }
}

async function checkSeasonsAndReport(tmdbId, imdbId, resp, name) {
  // Se não há cache disponível, pula a verificação
  if (!cache) {
    console.log("Cache not available, skipping season check");
    return;
  }

  const cacheData = await getLastChecked(tmdbId);
  const now = new Date();
  const lastChecked = cacheData && cacheData.lastChecked ? new Date(cacheData.lastChecked) : null;
  const diffDays = lastChecked ? (now - lastChecked) / (1000 * 60 * 60 * 24) : Infinity;
  if (diffDays < CHECK_INTERVAL_DAYS) return; // Do not check yet

  // 1. Number of seasons from TMDB (resp)
  let tmdbSeasons = 0;
  if (resp.meta && resp.meta.videos) {
    tmdbSeasons = new Set(resp.meta.videos
      .map(v => v.season)
      .filter(season => season !== 0 && season !== "0")
    ).size;
  } else if (resp.seasons) {
    tmdbSeasons = resp.seasons.filter(s => s.season_number !== 0 && s.season_number !== "0").length;
  }

  // 2. Number of seasons from Stremio
  const stremioUrl = `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`;
  let stremioSeasons;
  let stremioName = name;
  try {
    const stremioResp = await axios.get(stremioUrl);
    const stremioVideos = stremioResp.data.meta.videos || [];
    stremioSeasons = new Set(stremioVideos
      .map(v => v.season)
      .filter(season => season !== 0 && season !== "0")
    ).size;
    if (stremioResp.data.meta && stremioResp.data.meta.name) {
      stremioName = stremioResp.data.meta.name;
    }
  } catch (e) {
    // If unable to access the Stremio API, do nothing
    return;
  }

  // 3. Compare and open issue if necessary
  if (tmdbSeasons !== stremioSeasons) {
    console.log("Mismatch found")
    const tmdbLink = `https://www.themoviedb.org/tv/${tmdbId}`;
    const stremioLink = `https://web.stremio.com/#/detail/series/${imdbId}`;
    const issueTitle = `Season count mismatch in "${stremioName}"`;
    const body = `There is a difference in the number of seasons for this series.\n\n` +
      `**TMDB:** ${tmdbSeasons} seasons\n` +
      `**Stremio:** ${stremioSeasons} seasons\n` +
      `\n` +
      `**TMDB ID:** ${tmdbId}\n` +
      `**IMDB ID:** ${imdbId}\n` +
      `\n` +
      `- [TMDB page](${tmdbLink})\n` +
      `- [Stremio page](${stremioLink})`;
    // Verifica se já existe issue aberta para esse título
    const exists = await issueExistsOnGithub(issueTitle);
    console.log("Exists:", exists)  
    if (!exists) {
      console.log("Creating issue:", issueTitle)
      await openGithubIssue(
        issueTitle,
        body,
        ['season-mismatch']
      );
    }
  }

  await setLastChecked(tmdbId, { lastChecked: now.toISOString() });
  console.log("Last checked updated")
}

module.exports = { checkSeasonsAndReport }; 
