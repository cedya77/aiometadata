export function sizedArt(url: string | null | undefined, width: number): string | null {
  if (!url) return null;
  return url.replace(/\/poster-cache\/(?!proxy\/|w\d+\/)/, `/poster-cache/w${width}/`);
}

export const tmdbSized = (url: string, size: string): string => url.replace(/(image\.tmdb\.org\/t\/p\/)[^/]+\//, `$1${size}/`);

/** A smaller copy of a piece of art: a TMDB size name for TMDB art, a width for the poster cache, anything else as it is. */
export function artAt(url: string | null | undefined, tmdbSize: string, width: number): string | null {
  if (!url) return null;
  return url.includes("image.tmdb.org/t/p/") ? tmdbSized(url, tmdbSize) : sizedArt(url, width) ?? url;
}
