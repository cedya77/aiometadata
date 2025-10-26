const axios = require('axios');
const cheerio = require('cheerio');
const { httpGet } = require('../utils/httpClient.js');
const { cacheWrapGlobal } = require('./getCache.js');

const imdbAxiosInstance = axios.create();

const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/126.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
];

function getRandomUserAgent() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

imdbAxiosInstance.interceptors.request.use(config => {
    config.metadata = { startTime: new Date() };
    return config;
});

imdbAxiosInstance.interceptors.response.use(response => {
    const endTime = new Date();
    const duration = endTime - response.config.metadata.startTime;
    console.log(`[imdb-scraper] Response time for ${response.config.url}: ${duration} ms`);
    return response;
}, error => {
    if (error.config && error.config.metadata) {
        const endTime = new Date();
        const duration = endTime - error.config.metadata.startTime;
        console.log(`[imdb-scraper] Response time for ${error.config.url}: ${duration} ms (error)`);
    }
    return Promise.reject(error);
});

async function getMetaFromImdb(imdbId, type, stremioId) {
    if (!imdbId) {
        return undefined;
    }

    const cacheKey = `cinemeta-meta:${type}:${imdbId}`;
    const TTL_24H = 24 * 60 * 60; // 24 hours in seconds
    
    return await cacheWrapGlobal(cacheKey, async () => {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
        try {
            const response = await httpGet(url);
            const meta = response.data?.meta;
            if (meta) {
                if(stremioId) {
                    meta.id = stremioId;
                }
                return meta;
            }
            return undefined;
        } catch (error) {
            console.warn(
                `Could not fetch meta for ${imdbId} from Cinemeta for type ${type}. Error: ${error.message}`
            );
            return undefined;
        }
    }, TTL_24H);
}

async function getMetaFromImdbIo(imdbId, type, stremioId) {
    if (!imdbId) {
        return undefined;
    }

    const cacheKey = `cinemeta-live-meta:${type}:${imdbId}`;
    const TTL_24H = 24 * 60 * 60; // 24 hours in seconds
    
    return await cacheWrapGlobal(cacheKey, async () => {
        const url = `https://cinemeta-live.strem.io/meta/${type}/${imdbId}.json`;
        try {
            const response = await httpGet(url);
            const meta = response.data?.meta;
            if (meta) {
                if(stremioId) {
                    meta.id = stremioId;
                }
                return meta;
            }
            return undefined;
        } catch (error) {
            console.warn(
                `Could not fetch meta for ${imdbId} from Cinemeta for type ${type}. Error: ${error.message}`
            );
            return undefined;
        }
    }, TTL_24H);
}

function getLogoFromImdb(imdbId) {
    if (!imdbId) {
        return null;
    }
    return `https://images.metahub.space/logo/medium/${imdbId}/img`;
}

function getBackgroundFromImdb(imdbId) {
    if (!imdbId) {
        return null;
    }
    return `https://images.metahub.space/background/medium/${imdbId}/img`;
}

function getPosterFromImdb(imdbId) {
    if (!imdbId) {
        return null;
    }
    return `https://images.metahub.space/poster/medium/${imdbId}/img`;
}




async function fetchHtml(url, headers = {}) {
    console.log(`[imdb-scraper] Connecting to: ${url}`);
    try {
        const response = await imdbAxiosInstance.get(url, {
            headers: {
                'User-Agent': headers['user-agent'] || getRandomUserAgent(),
                ...headers
            },
            maxRedirects: 5,
            responseType: 'text',
            timeout: 10000
        });

        if (response.status >= 400) {
            throw new Error(
                `HTTP Error: ${response.status} ${response.statusText} for URL: ${url}`
            );
        }

        console.log(`[imdb-scraper] Response status code: ${response.status}`);
        return response.data;
    } catch (error) {
        if (axios.isCancel(error)) {
            console.error(
                `[imdb-scraper] Request for ${url} was canceled:`,
                error.message
            );
        } else if (axios.isAxiosError(error)) {
            if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                console.error(
                    `[imdb-scraper] Request for ${url} timed out after 10000ms.`
                );
            } else if (error.response) {
                console.error(
                    `[imdb-scraper] HTTP error for ${url}: ${error.response.status} - ${error.response.statusText}`
                );
            } else if (error.request) {
                console.error(
                    `[imdb-scraper] No response received for ${url}:`,
                    error.message
                );
            } else {
                console.error(`[imdb-scraper] Axios error for ${url}:`, error.message);
            }
        } else {
            console.error(
                `[imdb-scraper] Failed to fetch HTML for ${url}:`,
                error.message
            );
        }
        throw error;
    }
}

function createImdbResult(name, href) {
    const idMatch = href.match(/\/title\/(tt\d+)\//);
    if (idMatch) {
        return {
            imdbId: idMatch[1],
            name,
            href: `https://www.imdb.com${href}`
        };
    }
    return null;
}

function getMatchScore(
    resultNameFromLink,
    resultNameWithContext,
    originalSearchTitle
) {
    const isCosmResult = resultNameWithContext.toLowerCase().includes('cosm shared reality');
    const searchIsForCosmReality = originalSearchTitle.toLowerCase().includes('cosm shared reality');

    let currentScore = 0;
    let matchType = 'No Relevant Match';

    const lowerResultFromLink = resultNameFromLink.toLowerCase();
    const normalizedResultFromLink = lowerResultFromLink.replace(/[^a-z0-9]/g, '');
    const originalSearchLower = originalSearchTitle.toLowerCase();
    const originalSearchNormalized = originalSearchLower.replace(/[^a-z0-9]/g, '');

    if (lowerResultFromLink === originalSearchLower) {
        currentScore = 1000;
        matchType = 'Absolute Exact Match (Clean Title)';
    } else if (normalizedResultFromLink === originalSearchNormalized) {
        currentScore = 950;
        matchType = 'Normalized Exact Match (Clean Title)';
    } else if (searchIsForCosmReality) {
        if (isCosmResult && normalizedResultFromLink.includes(originalSearchNormalized)) {
            currentScore = 900;
            matchType = 'COSM-Specific Match';
        }
    } else {
        if (isCosmResult) {
            currentScore = 0;
            matchType = 'Standard Search, COSM Penalized';
        } else if (
            normalizedResultFromLink.startsWith(originalSearchNormalized) &&
            normalizedResultFromLink.length - originalSearchNormalized.length < 25
        ) {
            currentScore = 800;
            matchType = 'Standard Prefix Match';
        } else if (normalizedResultFromLink.includes(originalSearchNormalized)) {
            currentScore = 700;
            matchType = 'Standard Contains Match';
        }

        const lowerResultContextName = resultNameWithContext.toLowerCase();

        const variantKeywords = [
            'prelims',
            'fight pass',
            'weigh-ins',
            'countdown',
            'free fights',
            'podcast',
            'episode',
            'predictions',
            'highlights',
            'recap',
            'analysis',
            'review',
            'preview',
            'trailer',
            'teaser',
            'bonus',
            'behind the scenes',
            'clip',
            'shorts',
            'aftermath',
            'reaction',
            'scene',
            'kindagood'
        ];

        let penalizeForVariant = false;
        for (const term of variantKeywords) {
            if (
                lowerResultContextName.includes(term) &&
                !originalSearchLower.includes(term)
            ) {
                penalizeForVariant = true;
                break;
            }
        }

        if (currentScore > 0 && penalizeForVariant) {
            currentScore -= 100;
            matchType += ' (Penalized for Variant Keyword)';
            if (currentScore < 600) currentScore = 600;
        }
    }

    return { score: currentScore, nameLength: resultNameFromLink.length, type: matchType };
}

function processSearchResults($, searchResults, originalSearchTitle) {
    let bestFoundResult = null;
    let highestScore = 0;
    let shortestNameLengthAtHighestScore = Infinity;

    console.log(
        `[imdb-scraper] Found ${searchResults.length} potential title results to process.`
    );

    for (let i = 0; i < searchResults.length; i++) {
        const listItem = $(searchResults[i]);
        // Target a.ipc-metadata-list-summary-item__t which contains the main title text
        const linkElement = listItem.find('a.ipc-metadata-list-summary-item__t').first();

        if (linkElement && linkElement.length) {
            const href = linkElement.attr('href');
            const nameFromLink = linkElement.text().trim();
            // Get the full text of the list item for context, this often includes years, directors, etc.
            const nameWithContext = listItem.text().trim();

            if (nameFromLink && href) {
                const currentResult = createImdbResult(nameFromLink, href);

                if (!currentResult) {
                    console.log(`[imdb-scraper] Skipped candidate (no IMDb ID): "${nameFromLink}"`);
                    continue;
                }

                const { score, nameLength, type } = getMatchScore(
                    nameFromLink,
                    nameWithContext,
                    originalSearchTitle
                );

                console.log(
                    `[imdb-scraper] Candidate: "${nameFromLink}" (Score: ${score}, Length: ${nameLength}, Type: ${type})`
                );

                if (score > highestScore) {
                    highestScore = score;
                    shortestNameLengthAtHighestScore = nameLength;
                    bestFoundResult = currentResult;
                    console.log(
                        `[imdb-scraper] New best candidate selected: "${nameFromLink}" (Score: ${score}, Type: ${type})`
                    );
                } else if (score === highestScore) {
                    if (nameLength < shortestNameLengthAtHighestScore) {
                        shortestNameLengthAtHighestScore = nameLength;
                        bestFoundResult = currentResult;
                        console.log(
                            `[imdb-scraper] Improved candidate selected (same score, shorter name): "${nameFromLink}" (Score: ${score}, Type: ${type})`
                        );
                    }
                }
            }
        }
    }

    if (bestFoundResult) {
        console.log(
            `[imdb-scraper] Final best result selected with score ${highestScore}: "${bestFoundResult.name}"`
        );
    } else {
        console.log(`[imdb-scraper] No relevant IMDb results found after scoring.`);
    }

    return bestFoundResult;
}

async function scrapeSingleImdbResultByTitle(title, type) {
    let title_type;
    if (type === 'movie') {
        title_type = 'feature';
    } else {
        title_type = 'tv_series';
    }
    const searchUrl = `https://www.imdb.com/find?q=${encodeURIComponent(title)}&s=all&ref_=fn_al_all&title_type=${title_type}`;
    console.log(`[imdb-scraper] Fetching IMDb search results for: "${title}"`);

    try {
        const html = await fetchHtml(searchUrl);
        const $ = cheerio.load(html);

        let foundResult = null;

        const topCandidates = $(
            'section[data-testid="find-results-section-all-results"] a.ipc-metadata-list-summary-item__t[href^="/title/tt"], ' +
            'section[data-testid="find-results-section-title"] a.ipc-metadata-list-summary-item__t[href^="/title/tt"], ' +
            'a.ipc-metadata-list-summary-item__t[href^="/title/tt"]'
        );

        console.log(
            `[imdb-scraper] Found ${topCandidates.length} initial direct link candidates across the page.`
        );

        if (topCandidates.length > 0) {
            for (let i = 0; i < topCandidates.length; i++) {
                const linkElement = $(topCandidates[i]);
                const href = linkElement.attr('href');
                const nameFromLink = linkElement.text().trim();
                const normalizedResultFromLink = nameFromLink
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, '');
                const originalSearchNormalized = title.toLowerCase().replace(/[^a-z0-9]/g, '');

                if (nameFromLink && href) {
                    if (normalizedResultFromLink === originalSearchNormalized) {
                        foundResult = createImdbResult(nameFromLink, href);
                        if (foundResult) {
                            console.log(
                                `[imdb-scraper] Exact match found: "${nameFromLink}"`
                            );
                            return foundResult;
                        }
                    }
                   
                    if (!foundResult) {
                        const { score, type } = getMatchScore(
                            nameFromLink,
                            linkElement.parent().text().trim(),
                            title
                        );
                        if (score >= 800) {
                            foundResult = createImdbResult(nameFromLink, href);
                            if (foundResult) {
                                console.log(
                                    `[imdb-scraper] Setting initial strong candidate from direct links: "${nameFromLink}" (Score: ${score}, Type: ${type})`
                                );
                            }
                        }
                    }
                }
            }
        }


        let searchResultListItems = $();

        const titleResultsSection = $('section[data-testid="find-results-section-title"]').first();

        if (titleResultsSection.length) {
            searchResultListItems = titleResultsSection.find('ul.ipc-metadata-list li.ipc-metadata-list-summary-item');
        } else {
            console.log(
                `[imdb-scraper] Could not find the main 'Titles' result section (data-testid). Attempting fallback method for list items.`
            );
            const titlesHeading = $('h3.ipc-title:contains("Titles")').first();
            if (titlesHeading.length) {
                const siblingList = titlesHeading.next('ul.ipc-metadata-list');
                if (siblingList.length) {
                    searchResultListItems = siblingList.find('li.ipc-metadata-list-summary-item');
                }
            }
        }

        if (searchResultListItems.length > 0) {
            const resultFromList = processSearchResults($, searchResultListItems, title);
            if (resultFromList) {
                const listScore = getMatchScore(resultFromList.name, resultFromList.name, title)
                    .score;
                const currentFoundScore = foundResult ?
                    getMatchScore(foundResult.name, foundResult.name, title).score :
                    0;

                if (listScore > currentFoundScore) {
                    foundResult = resultFromList;
                    console.log(
                        `[imdb-scraper] List item processing found a BETTER candidate: "${foundResult.name}" (Score: ${listScore})`
                    );
                } else if (!foundResult && listScore > 0) {
                    // If no initial direct link candidate, and list gave something good
                    foundResult = resultFromList;
                    console.log(
                        `[imdb-scraper] List item processing found initial candidate: "${foundResult.name}" (Score: ${listScore})`
                    );
                }
            }
        } else {
            console.log(
                `[imdb-scraper] No general list items found for "${title}" to process with detailed scoring.`
            );
        }

        if (!foundResult) {
            console.log(
                `[imdb-scraper] No relevant IMDb results found for "${title}" after all checks.`
            );
        }
        return foundResult;
    } catch (error) {
        console.error(
            `[imdb-scraper] Failed to get IMDb result for "${title}" due to: ${error.message}`
        );
        return null;
    }
}


module.exports = {
    getMetaFromImdb,
    scrapeSingleImdbResultByTitle,
    getMetaFromImdbIo,
    getLogoFromImdb,
    getBackgroundFromImdb,
    getPosterFromImdb
};