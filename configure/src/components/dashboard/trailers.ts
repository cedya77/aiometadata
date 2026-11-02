export type Trailer = { name: string; url: string };

export type TrailerKind = "direct" | "youtube";

export interface RemoteTrailer {
  kind: TrailerKind;
  url: string;
  name: string;
  /** The video's id, for a YouTube trailer. */
  youtubeId?: string;
}

// A link's id can carry more after it, such as "?si=" pasted in with it.
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}(?![A-Za-z0-9_-])/;

/** The id of a YouTube video link, in any of the forms a server writes. */
export function youtubeId(url: string): string | undefined {
  try {
    const parsed = new URL(url.replace(/^youtube:\/\//i, "https://"));
    const host = parsed.hostname.replace(/^www\.|^m\./, "");
    const id = host === "youtu.be"
      ? parsed.pathname.slice(1)
      : host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")
        ? parsed.searchParams.get("v") || parsed.pathname.match(/\/(?:embed|shorts|v)\/([^/?]+)/)?.[1]
        : undefined;
    return id?.match(YOUTUBE_ID)?.[0];
  } catch {
    return undefined;
  }
}

/** An HLS playlist, which the page has no player for. */
export function isHls(url: string): boolean {
  return /\.m3u8(?:$|[?#])/i.test(url);
}

/** The title's trailers from the server, in its order, as YouTube videos or direct links; anything else is left out. */
export function remoteTrailers(trailers: Trailer[] | undefined): RemoteTrailer[] {
  return (trailers ?? []).flatMap((trailer): RemoteTrailer[] => {
    const id = youtubeId(trailer.url);
    if (id) return [{ kind: "youtube", url: trailer.url, name: trailer.name, youtubeId: id }];
    if (!/^https?:\/\//i.test(trailer.url)) return [];
    return [{ kind: "direct", url: trailer.url, name: trailer.name }];
  });
}

/** The trailer the page plays: the server's first, or past an HLS playlist, the first direct link it can open, else YouTube. */
export function playableTrailer(trailers: RemoteTrailer[]): RemoteTrailer | undefined {
  const first = trailers[0];
  if (first && !(first.kind === "direct" && isHls(first.url))) return first;
  return trailers.find((t) => t.kind === "direct" && !isHls(t.url)) ?? trailers.find((t) => t.kind === "youtube");
}

/** YouTube's embedded player with its controls, leaving full screen to the page around it. */
export function youtubeEmbedUrl(id: string): string {
  const params = new URLSearchParams({
    autoplay: "1",
    playsinline: "1",
    rel: "0",
    modestbranding: "1",
    enablejsapi: "1",
    origin: window.location.origin,
    fs: "0",
  });
  return `https://www.youtube-nocookie.com/embed/${id}?${params}`;
}
