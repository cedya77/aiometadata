import { useMemo } from "react";
import type { JellyfinYearTitle } from "@/hooks/useDashboardQueries";
import { sizedArt } from "./art";
import { duration } from "./jellyfinUtils";
import { FadeScroll, TitleLink, plural } from "./JellyfinYearShared";
import { displayName } from "./yearModel";

const PODIUM = 5;
const PODIUM_PHONE = 3;
const ROW_H = 57;
const ROWS_SHOWN = 6.5;

function Poster({ src, className = "" }: { src: string | null | undefined; className?: string }) {
  return src
    ? <img src={sizedArt(src, 342) ?? src} alt="" loading="lazy" draggable={false} className={`h-full w-full object-cover ${className}`} />
    : <div className={`h-full w-full bg-gradient-to-br from-zinc-700 to-zinc-900 ${className}`} />;
}

/** Titles ranked by time watched: the first few as posters, then every one as a row. */
export function TitleLeaderboard({ titles, timeZone }: { titles: JellyfinYearTitle[]; timeZone: string }) {
  const { ranked, metas } = useMemo(() => {
    const month = new Intl.DateTimeFormat(undefined, { month: "short", timeZone });
    const sorted = [...titles].sort((a, b) => b.watchMs - a.watchMs);
    return {
      ranked: sorted,
      metas: new Map(sorted.map((title) => {
        const first = title.plays.reduce((min, play) => Math.min(min, play[1]), Infinity);
        return [title, [title.kind === "movie" ? "Film" : plural(title.episodes, "episode"), Number.isFinite(first) ? `started ${month.format(first)}` : null].filter(Boolean).join(" · ")];
      })),
    };
  }, [titles, timeZone]);
  const most = ranked[0]?.watchMs || 1;
  const meta = (title: JellyfinYearTitle) => metas.get(title) ?? "";
  const bar = (title: JellyfinYearTitle) => `${Math.max(3, Math.round((title.watchMs / most) * 100))}%`;
  const rows = ranked.slice(PODIUM_PHONE);
  return (
    <div className="mt-5 flex flex-col gap-5">
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 sm:gap-3.5">
        {ranked.slice(0, PODIUM).map((title, i) => (
          <TitleLink key={title.key} title={title} name={displayName(title)} className={`group min-w-0 flex-col gap-1.5 ${i >= PODIUM_PHONE ? "hidden sm:flex" : "flex"}`}>
            <div className="relative aspect-[2/3] overflow-hidden rounded-[10px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]">
              <Poster src={title.facts?.poster} className="transition-transform duration-500 group-hover:scale-105" />
              <span aria-hidden="true" className="absolute bottom-1 left-2 text-[28px] font-extrabold leading-none text-white [text-shadow:0_2px_10px_rgba(0,0,0,0.7)] sm:text-[40px]">{i + 1}</span>
            </div>
            <p className="truncate text-[11px] font-semibold decoration-white/35 underline-offset-4 group-hover:underline sm:text-[13px]">{displayName(title)}</p>
            <p className="text-[11px] font-semibold tabular-nums text-blue-300 sm:text-xs">{duration(title.watchMs)}</p>
          </TitleLink>
        ))}
      </div>
      {rows.length > 0 && (
        <FadeScroll scrolls={rows.length > ROWS_SHOWN} maxHeight={ROWS_SHOWN * ROW_H} label={`${plural(ranked.length, "title")}, scroll for more`} className="flex min-w-0 flex-col">
          {rows.map((title, i) => {
            const rank = i + PODIUM_PHONE + 1;
            return (
              <TitleLink key={title.key} title={title} name={displayName(title)} className={`group grid min-w-0 grid-cols-[22px_26px_minmax(0,1fr)_52px] items-center gap-2.5 rounded-lg border-b border-white/[0.05] px-1 py-1.5 transition-colors hover:bg-white/[0.04] sm:grid-cols-[30px_30px_minmax(0,1fr)_200px_64px] sm:gap-3 ${rank <= PODIUM ? "sm:hidden" : ""}`}>
                <span className="text-right text-[11px] tabular-nums text-muted-foreground sm:text-xs">{rank}</span>
                <div className="aspect-[2/3] overflow-hidden rounded"><Poster src={title.facts?.poster} /></div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium decoration-white/35 underline-offset-4 group-hover:underline sm:text-[13px]">{displayName(title)}</p>
                  <p className="hidden truncate text-[11px] text-muted-foreground sm:block">{meta(title)}</p>
                  <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-white/[0.08] sm:hidden"><div className="h-full rounded-full bg-blue-400" style={{ width: bar(title) }} /></div>
                </div>
                <div className="hidden h-1 overflow-hidden rounded-full bg-white/[0.08] sm:block"><div className="h-full rounded-full bg-blue-400" style={{ width: bar(title) }} /></div>
                <span className="text-right text-[11px] tabular-nums sm:text-xs">{duration(title.watchMs)}</span>
              </TitleLink>
            );
          })}
        </FadeScroll>
      )}
    </div>
  );
}
