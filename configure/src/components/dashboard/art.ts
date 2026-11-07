const JELLYFIN_IMAGE = /\/jellyfin\/[^/]+\/Items\/[^/]+\/Images\//;

export function sizedArt(url: string | null | undefined, width: number): string | null {
  if (!url) return null;
  // The Jellyfin image route serves full-size art unless asked for a width.
  if (JELLYFIN_IMAGE.test(url)) return /[?&]maxWidth=/.test(url) ? url : `${url}${url.includes("?") ? "&" : "?"}maxWidth=${width}`;
  return url.replace(/\/poster-cache\/(?!proxy\/|w\d+\/)/, `/poster-cache/w${width}/`);
}

export const tmdbSized = (url: string, size: string): string => url.replace(/(image\.tmdb\.org\/t\/p\/)[^/]+\//, `$1${size}/`);

const MAL_MEDIUM_PX = 225;

// MyAnimeList serves each cover large with an `l` before the extension and 225 px wide without it.
const malSized = (url: string, width: number): string => (width <= MAL_MEDIUM_PX ? url.replace(/(\/images\/(?:anime|manga)\/\d+\/\d+)l(\.\w+)$/, "$1$2") : url);

/** Image pixels a box this many CSS pixels wide needs on this screen. */
export const pixelsFor = (cssWidth: number): number => Math.round(cssWidth * Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));

/** The smallest TMDB poster size at least this many pixels wide. */
export const tmdbPosterFor = (px: number): string => (px <= 92 ? "w92" : px <= 185 ? "w185" : px <= 342 ? "w342" : px <= 500 ? "w500" : "w780");

/** A smaller copy of a piece of art, `width` image pixels wide: a TMDB size name for TMDB art, a width for MyAnimeList covers and the poster cache, anything else as it is. */
export function artAt(url: string | null | undefined, tmdbSize: string, width: number): string | null {
  if (!url) return null;
  if (url.includes("image.tmdb.org/t/p/")) return tmdbSized(url, tmdbSize);
  if (url.includes("cdn.myanimelist.net/images/")) return malSized(url, width);
  return sizedArt(url, width) ?? url;
}
