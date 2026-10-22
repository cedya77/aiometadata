export const TRACKER_NAMES: Record<string, string> = { simkl: "Simkl", mdblist: "MDBList", publicmetadb: "PublicMetaDB", anilist: "AniList", mal: "MyAnimeList" };
export const TRACKER_TILES: Record<string, string> = { simkl: "bg-[#0d0d0f]", mdblist: "bg-[#4a86d0]", publicmetadb: "bg-[#ebebeb]", anilist: "bg-[#152232]", mal: "bg-[#2e51a2]" };
export const ANIME_ONLY = new Set(["anilist", "mal"]);
export const COPY_FROM = new Set(["simkl", "mdblist", "publicmetadb"]);
export const nameOf = (service: string) => TRACKER_NAMES[service] ?? service;
