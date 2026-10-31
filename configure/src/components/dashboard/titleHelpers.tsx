import { useEffect, useState, type RefObject } from "react";
import { Cast, Check, CheckCheck, Undo2 } from "lucide-react";
import type { JellyfinTitle, JellyfinTitleAction, JellyfinTitleEpisode } from "@/hooks/useDashboardQueries";
import type { MenuItem } from "./JellyfinShared";
import { sizedArt } from "./art";

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export const PLAY_PILL = "inline-flex h-12 items-center gap-2 rounded-full bg-white px-7 text-[15px] font-semibold text-black shadow-lg shadow-black/30 transition hover:bg-white/90 active:scale-[0.98] disabled:opacity-60 [&_svg]:size-[18px]";

export const GLASS_PILL = "inline-flex h-12 shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/10 px-5 text-[15px] font-semibold text-white backdrop-blur-md transition-[background-color,transform] hover:bg-white/[0.18] active:scale-[0.97] disabled:opacity-60 [&_svg]:size-5";

export type Anchor = { x: number; y: number };

const SHEET_WIDTH = 352;

export function under(button: Element): Anchor {
  const box = button.getBoundingClientRect();
  return { x: box.left + box.width / 2 - SHEET_WIDTH / 2, y: box.bottom + 8 };
}

const LARGEST_ART_STEP = 1280;
export const HERO_PHONE_SHARE = 0.88;
export const HERO_DESKTOP_SHARE = 0.85;
export const HERO_DESKTOP_UPSCALE = 1.25;
const BACKDROP_RATIO = 16 / 9;

export function heroArt(url: string | null | undefined, heightShare: number, upscale = 1): string | null {
  if (!url) return null;
  const density = Math.min(3, window.devicePixelRatio || 1);
  const needed = Math.ceil(Math.max(window.innerWidth, window.innerHeight * heightShare * BACKDROP_RATIO) * density);
  return needed <= LARGEST_ART_STEP * upscale ? sizedArt(url, LARGEST_ART_STEP) ?? url : url;
}

export const sizedStill = (src: string | null, width: number) => (src ? `${src}&maxWidth=${width}&quality=85` : null);

export function seasonLabel(season: number | null): string {
  if (season === null) return "Episodes";
  return season === 0 ? "Specials" : `Season ${season}`;
}

export function code(ep: JellyfinTitleEpisode): string {
  if (ep.number === null) return "";
  return ep.season === null ? `E${ep.number}` : `S${ep.season} E${ep.number}`;
}

export type SeasonItem = JellyfinTitle["seasons"][number];

export const orderedSeasons = (seasons: SeasonItem[]): SeasonItem[] => [...seasons.filter((s) => s.season !== 0), ...seasons.filter((s) => s.season === 0)];

export function useCenteredTab(track: RefObject<HTMLDivElement | null>, selected: unknown): void {
  useEffect(() => {
    const row = track.current;
    const active = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row || !active) return;
    row.scrollTo({ left: Math.max(0, active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2), behavior: "smooth" });
  }, [track, selected]);
}

export function episodeMenuItems(ep: JellyfinTitleEpisode, unaired: boolean, at: Anchor, onAction: (action: JellyfinTitleAction) => void, onPlayOn: (at: Anchor) => void): MenuItem[] {
  return [
    ...(unaired ? [] : [{ icon: <Cast className="size-4" />, label: "Play on a device", onSelect: () => onPlayOn(at) }]),
    { icon: <Check className="size-4" />, label: "Mark watched", onSelect: () => onAction("played") },
    { icon: <Undo2 className="size-4" />, label: "Mark unwatched", onSelect: () => onAction("unplayed") },
    ...(ep.season === 0 ? [] : [{ icon: <CheckCheck className="size-4" />, label: "Watched up to here", onSelect: () => onAction("playedUpTo") }]),
  ];
}

export const GLASS_ROUND = "flex size-12 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white backdrop-blur-md transition-[background-color,transform] hover:bg-white/[0.18] active:scale-95 disabled:opacity-50";

export const PHONE_PLAY_PILL = "inline-flex h-[52px] w-full min-w-0 items-center justify-center gap-2 rounded-full bg-[#f6f2ed] text-base font-semibold text-[#121110] shadow-lg shadow-black/30 transition active:scale-[0.98] disabled:opacity-60 [&_svg]:size-[18px] [&_svg]:fill-current";

export const PHONE_ACTION = "relative flex min-w-0 flex-1 flex-col items-center gap-1.5 py-1 text-xs font-medium text-white/[0.72] transition-transform active:scale-95 disabled:opacity-50 [&_svg]:size-[23px] [&_svg]:text-white";

export const CHIP = "inline-flex h-6 items-center gap-1 rounded-full bg-white/[0.08] px-2.5 text-xs font-semibold text-[#ece6df] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]";

export const PHONE_QUERY = "(max-width: 767px)";

export const SOLID_AT = 0.42;

export const CREDIT_LIMIT = 4;

const DAY_MS = 24 * 60 * 60 * 1000;

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return phone;
}

export function untilAir(at: number): string {
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(new Date(at)) - midnight(new Date())) / DAY_MS);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (days < 14) return format.format(days, "day");
  if (days < 60) return format.format(Math.round(days / 7), "week");
  return format.format(Math.round(days / 30), "month");
}

export function playLabel(ep: JellyfinTitleEpisode | null): string {
  if (!ep || ep.number === null) return "Play on…";
  if (ep.season === 0) return `Play Special ${ep.number} on…`;
  return ep.season === null ? `Play Episode ${ep.number} on…` : `Play Season ${ep.season}, Episode ${ep.number} on…`;
}

export function titleFacts(title: JellyfinTitle, seasonCount: number): string[] {
  const start = /\d{4}/.exec(title.year ?? "")?.[0] ?? null;
  const end = /\d{4}\s*[-\u2013]\s*(\d{4})/.exec(title.year ?? "")?.[1] ?? null;
  const year = start && title.status === "Ended" && end && end > start ? `${start}-${end}` : start;
  return [
    year,
    title.status === "Continuing" ? "Continuing" : title.status === "Ended" ? "Ended" : null,
    title.type === "series" && seasonCount > 0 ? `${seasonCount} ${seasonCount === 1 ? "Season" : "Seasons"}` : null,
    title.type === "movie" ? title.runtime : null,
  ].filter((part): part is string => Boolean(part));
}
