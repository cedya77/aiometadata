import audienceSpilled from "@/assets/ratings/audience-spilled.svg";
import audienceUpright from "@/assets/ratings/audience-upright.svg";
import imdb from "@/assets/ratings/imdb.svg";
import letterboxd from "@/assets/ratings/letterboxd.svg";
import mal from "@/assets/ratings/mal.svg";
import metacritic from "@/assets/ratings/metacritic.svg";
import rogerebert from "@/assets/ratings/rogerebert.svg";
import tmdb from "@/assets/ratings/tmdb.svg";
import tomatoesFresh from "@/assets/ratings/tomatoes-fresh.svg";
import tomatoesRotten from "@/assets/ratings/tomatoes-rotten.svg";
import trakt from "@/assets/ratings/trakt.svg";
import type { JellyfinTitleRating } from "@/hooks/useDashboardQueries";

const SOURCES = ["imdb", "tomatoes", "tomatoesAudience", "metacritic", "letterboxd", "rogerebert", "trakt", "tmdb", "mal"] as const;

export const LABELS: Record<string, string> = {
  imdb: "IMDb",
  tomatoes: "Rotten Tomatoes",
  tomatoesAudience: "Rotten Tomatoes audience",
  metacritic: "Metacritic",
  letterboxd: "Letterboxd",
  rogerebert: "Roger Ebert",
  trakt: "Trakt",
  tmdb: "TMDB",
  mal: "MyAnimeList",
};

const ICONS: Record<string, string> = { imdb, letterboxd, mal, metacritic, rogerebert, tmdb, trakt };

export function iconOf(rating: JellyfinTitleRating): string | null {
  const fresh = rating.value / rating.scale >= 0.6;
  if (rating.source === "tomatoes") return fresh ? tomatoesFresh : tomatoesRotten;
  if (rating.source === "tomatoesAudience") return fresh ? audienceUpright : audienceSpilled;
  return ICONS[rating.source] ?? null;
}

export function textOf(rating: JellyfinTitleRating): { value: string; suffix: string } {
  switch (rating.source) {
    case "tomatoes":
    case "tomatoesAudience":
    case "trakt":
      return { value: `${Math.round(rating.value)}%`, suffix: "" };
    case "metacritic":
      return { value: String(Math.round(rating.value)), suffix: "" };
    case "rogerebert":
      return { value: String(Math.round(rating.value * 2) / 2), suffix: `/${rating.scale}` };
    default:
      return { value: rating.value.toFixed(1), suffix: "" };
  }
}

export function knownRatings(ratings: JellyfinTitleRating[]): JellyfinTitleRating[] {
  return SOURCES.flatMap((source) => ratings.filter((rating) => rating.source === source && Number.isFinite(rating.value) && rating.scale > 0 && iconOf(rating)));
}

export const hasCriticRatings = (ratings: JellyfinTitleRating[]) => knownRatings(ratings).some((rating) => rating.source !== "imdb");
