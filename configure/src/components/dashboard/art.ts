export function sizedArt(url: string | null | undefined, width: number): string | null {
  if (!url) return null;
  return url.replace(/\/poster-cache\/(?!proxy\/|w\d+\/)/, `/poster-cache/w${width}/`);
}

export const tmdbSized = (url: string, size: string): string => url.replace(/(image\.tmdb\.org\/t\/p\/)[^/]+\//, `$1${size}/`);
