export const TRACKER_NAMES: Record<string, string> = { simkl: "Simkl", mdblist: "MDBList", publicmetadb: "PublicMetaDB", anilist: "AniList", mal: "MyAnimeList" };
export const TRACKER_TILES: Record<string, string> = { simkl: "bg-[#0d0d0f]", mdblist: "bg-[#4a86d0]", publicmetadb: "bg-[#ebebeb]", anilist: "bg-[#152232]", mal: "bg-[#2e51a2]" };
export const ANIME_ONLY = new Set(["anilist", "mal"]);
export const COPY_FROM = new Set(["simkl", "mdblist", "publicmetadb"]);
export const COPY_ROUTES: Record<string, { from: Set<string>; to: Set<string> | null }> = {
  watches: { from: COPY_FROM, to: null },
  ratings: { from: new Set(["simkl", "mdblist"]), to: new Set(["simkl", "mdblist", "publicmetadb"]) },
  watchlist: { from: COPY_FROM, to: new Set(["simkl", "mdblist", "publicmetadb", "anilist", "mal"]) },
  dropped: { from: COPY_FROM, to: COPY_FROM },
};
export const nameOf = (service: string) => TRACKER_NAMES[service] ?? service;
