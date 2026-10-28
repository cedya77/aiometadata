import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleCheck, CircleDashed, CircleX, Film, Layers, Loader2, MoreHorizontal, Play, Repeat, ThumbsDown, Tv } from "lucide-react";
import { type JellyfinPlayRow } from "@/hooks/useDashboardQueries";
import { ActionMenu, Art, Sentinel, type MenuItem } from "./JellyfinShared";
import { when, clock, percentOf, duration, useOpenTitle, titleRefOf } from "./jellyfinUtils";

export type ProgressAction = "played" | "unplayed" | "clear" | "drop";

export function ProgressCard({ row, onAction, onPlayOn }: { row: JellyfinPlayRow; onAction?: (action: ProgressAction) => Promise<void>; onPlayOn?: (at: { x: number; y: number }) => void }) {
  const pct = percentOf(row);
  const left = row.runtimeMs > row.positionMs ? duration(row.runtimeMs - row.positionMs) : "";
  const code = episodeCode(row, true);
  const subtitle = code ? `${code}${row.episodeTitle ? ` · ${row.episodeTitle}` : ""}` : row.episode;
  const open = useOpenTitle();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const closeMenu = useCallback(() => setMenu(null), []);
  const run = (action: ProgressAction) => {
    if (!onAction) return;
    setBusy(true);
    void onAction(action).finally(() => setBusy(false));
  };
  const isEpisode = row.seriesId !== null;
  const items: MenuItem[] = menu ? [
    ...(onPlayOn ? [{ icon: <Play className="size-4" />, label: "Play on a device", onSelect: () => onPlayOn(menu) }] : []),
    ...(open ? [{ icon: isEpisode ? <Tv className="size-4" /> : <Film className="size-4" />, label: isEpisode ? "Go to series" : "Go to film", onSelect: () => open(titleRefOf(row)) }] : []),
    ...(open && isEpisode && row.season !== null ? [{ icon: <Layers className="size-4" />, label: row.season === 0 ? "Go to specials" : "Go to season", onSelect: () => open(titleRefOf(row), row.season) }] : []),
    ...(onAction ? [
      { icon: <CircleCheck className="size-4" />, label: "Mark as watched", onSelect: () => run("played"), divider: true },
      { icon: <CircleDashed className="size-4" />, label: "Mark unwatched and reset progress", onSelect: () => run("unplayed") },
      { icon: <CircleX className="size-4" />, label: "Clear resume position", onSelect: () => run("clear") },
      ...(isEpisode ? [{ icon: <ThumbsDown className="size-4" />, label: "Drop show", onSelect: () => run("drop") }] : []),
    ] : []),
  ] : [];
  const showMenu = (at: { x: number; y: number }) => { if (onAction || onPlayOn) setMenu(at); };
  return (
    <div role={open ? "button" : undefined} tabIndex={open ? 0 : undefined} onClick={open ? () => open(titleRefOf(row)) : undefined} onKeyDown={open ? (event) => { if (event.key === "Enter") open(titleRefOf(row)); } : undefined} onContextMenu={onAction || onPlayOn ? (event) => { event.preventDefault(); showMenu({ x: event.clientX, y: event.clientY }); } : undefined} className={`group relative overflow-hidden rounded-lg bg-muted/40 ring-1 ring-white/[0.06] transition hover:ring-white/20 ${open ? "cursor-pointer" : ""}`} title={`${row.title}${row.episode ? ` · ${row.episode}` : ""}`}>
      <div className="transition-transform duration-500 group-hover:scale-[1.03]"><Art src={row.backdropUrl && !row.seriesId ? row.backdropUrl : row.imageUrl ?? row.backdropUrl} title="" wide /></div>
      <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/45 to-black/0" />
      <span className="glass absolute top-2 left-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] text-white/85">{row.rewatch && <><Repeat className="size-2.5" /> Rewatching ·</>} {row.profile} · {when(row.lastPlayedAt ?? row.updatedAt)}</span>
      {(onAction || onPlayOn) && (
        <button
          type="button"
          disabled={busy}
          onMouseDown={(event) => { if (menu) event.stopPropagation(); }}
          onClick={(event) => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); if (menu) setMenu(null); else showMenu({ x: box.right - 224, y: box.bottom + 4 }); }}
          onKeyDown={(event) => event.stopPropagation()}
          aria-label="More"
          className={`glass absolute top-2 right-2 z-10 flex size-7 items-center justify-center rounded-full text-white/90 transition hover:bg-black/70 focus-visible:opacity-100 ${menu || busy ? "opacity-100" : "md:opacity-0 md:group-hover:opacity-100"}`}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-4" />}
        </button>
      )}
      {menu && (
        <span className="contents" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
        <ActionMenu
          at={menu}
          onClose={closeMenu}
          items={items}
          header={(
            <div className="flex max-w-72 items-center gap-3">
              <div className="w-20 shrink-0 overflow-hidden rounded-md"><Art src={row.imageUrl ?? row.backdropUrl} title="" wide /></div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{row.title}</p>
                {(subtitle || left) && <p className="truncate text-xs text-muted-foreground">{subtitle || `${left} left`}</p>}
              </div>
            </div>
          )}
        />
        </span>
      )}
      <div className="absolute inset-x-0 bottom-0 space-y-1.5 p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight text-white">{row.title}</p>
          {subtitle && <p className="truncate text-[11px] leading-tight text-white/65">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/20">
            {pct !== null
              ? <div className="h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400" style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
              : row.positionMs > 0 && <div className="h-full w-1/4 rounded-full bg-gradient-to-r from-blue-500 to-blue-500/0" />}
          </div>
          <span className="whitespace-nowrap text-[10px] tabular-nums text-white/75">{left ? `${left} left` : row.positionMs > 0 ? `${clock(row.positionMs)} in` : clock(row.positionMs)}</span>
        </div>
      </div>
    </div>
  );
}
export function MoreFooter({ paged }: { paged: { more: boolean; loading: boolean; loadMore: () => void; failed: boolean; retry: () => void } }) {
  if (!paged.more && !paged.loading && !paged.failed) return null;
  return (
    <div className="flex h-10 items-center justify-center text-xs text-muted-foreground">
      {paged.loading
        ? <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading more…</span>
        : paged.failed
          ? <button type="button" onClick={paged.retry} className="text-red-400 hover:text-red-300">Could not load more. Retry</button>
          : <button type="button" onClick={paged.loadMore} className="hover:text-foreground">Load more</button>}
    </div>
  );
}
export function Row({ children, onEnd, loading }: { children: React.ReactNode; onEnd?: () => void; loading?: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const measure = () => {
    const el = track.current;
    if (!el) return;
    const start = el.scrollLeft <= 4;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  };
  useEffect(measure, [children]);
  const page = (dir: 1 | -1) => track.current?.scrollBy({ left: dir * track.current.clientWidth * 0.85, behavior: "smooth" });
  const arrow = "glass absolute top-1/2 z-10 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-white transition hover:bg-black/60 md:flex";
  return (
    <div className="group/row relative -mx-4 sm:-mx-6">
      <div ref={track} onScroll={measure} className="flex snap-x gap-3 overflow-x-auto scroll-px-4 px-4 pb-2 sm:scroll-px-6 sm:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
        {loading && <div className="flex w-24 shrink-0 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
        {onEnd && <Sentinel key={React.Children.count(children)} onVisible={onEnd} root={track} margin="0px 800px 0px 0px" />}
      </div>
      {!edges.start && <button type="button" aria-label="Scroll back" onClick={() => page(-1)} className={`${arrow} left-2`}><ChevronLeft className="h-5 w-5" /></button>}
      {!edges.end && <button type="button" aria-label="Scroll on" onClick={() => page(1)} className={`${arrow} right-2`}><ChevronRight className="h-5 w-5" /></button>}
    </div>
  );
}
function stamp(value: number | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}
function episodeCode(row: JellyfinPlayRow, spaced = false): string {
  if (row.number === null) return "";
  const e = `E${String(row.number).padStart(2, "0")}`;
  if (row.season === null) return e;
  return `S${String(row.season).padStart(2, "0")}${spaced ? " " : ""}${e}`;
}
const playedAt = (row: JellyfinPlayRow): number => row.watchedAt ?? row.lastPlayedAt ?? row.updatedAt;
function RewatchChip() {
  return <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground/80"><Repeat className="size-2.5" /> Rewatch</span>;
}
interface DayTile {
  key: string;
  title: string;
  posterUrl: string | null;
  profile: string;
  show: boolean;
  rows: JellyfinPlayRow[];
  runtimeMs: number;
  at: number;
}
interface DayGroup {
  key: string;
  date: Date;
  tiles: DayTile[];
  movies: number;
  shows: number;
  episodes: number;
  runtimeMs: number;
}
function groupByDay(rows: JellyfinPlayRow[]): DayGroup[] {
  const days = new Map<string, DayGroup>();
  for (const row of rows) {
    const at = playedAt(row);
    const date = new Date(at);
    const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    let day = days.get(dayKey);
    if (!day) {
      day = { key: dayKey, date: new Date(date.getFullYear(), date.getMonth(), date.getDate()), tiles: [], movies: 0, shows: 0, episodes: 0, runtimeMs: 0 };
      days.set(dayKey, day);
    }
    const show = row.seriesId !== null;
    const tileKey = `${row.profile}|${show ? row.seriesId : row.videoId}`;
    let tile = day.tiles.find((t) => t.key === tileKey);
    if (!tile) {
      tile = { key: tileKey, title: row.title, posterUrl: row.posterUrl, profile: row.profile, show, rows: [], runtimeMs: 0, at: 0 };
      day.tiles.push(tile);
      if (show) day.shows += 1; else day.movies += 1;
    }
    tile.rows.push(row);
    tile.runtimeMs += row.runtimeMs;
    tile.at = Math.max(tile.at, at);
    day.runtimeMs += row.runtimeMs;
    if (show) day.episodes += 1;
  }
  for (const day of days.values()) {
    for (const tile of day.tiles) {
      tile.rows.sort((a, b) => (a.season ?? -1) - (b.season ?? -1) || (a.number ?? 0) - (b.number ?? 0));
    }
    day.tiles.sort((a, b) => b.at - a.at);
  }
  return [...days.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
}
function EpisodeLine({ row }: { row: JellyfinPlayRow }) {
  return (
    <div className="flex gap-3 rounded-md border border-white/[0.06] bg-muted/20 p-2">
      <div className="w-24 shrink-0"><Art src={row.imageUrl ?? row.posterUrl} title={row.title} wide /></div>
      <div className="min-w-0 flex-1">
        <p className="text-xs leading-tight truncate"><span className="text-primary font-medium">{episodeCode(row, true)}</span>{row.episodeTitle ? ` ${row.episodeTitle}` : ""}</p>
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">{stamp(playedAt(row))}{row.rewatch && <RewatchChip />}</p>
      </div>
      {row.runtimeMs > 0 && <span className="self-end rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white">{duration(row.runtimeMs)}</span>}
    </div>
  );
}
function DayTileCard({ tile }: { tile: DayTile }) {
  const [open, setOpen] = useState(false);
  const openTitle = useOpenTitle();
  const many = tile.rows.length > 1;
  const first = tile.rows[0];
  const last = tile.rows[tile.rows.length - 1];
  return (
    <div className={`rounded-lg border border-white/[0.06] bg-muted/30 ${open ? "sm:col-span-2 lg:col-span-3" : ""}`}>
      <div className="flex gap-3 p-3">
        <button type="button" disabled={!openTitle} onClick={() => openTitle?.(titleRefOf(tile.rows[0]))} className="w-16 shrink-0 transition hover:opacity-80" aria-label={`Open ${tile.title}`}><Art src={tile.posterUrl} title={tile.title} wide={false} /></button>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight truncate" title={tile.title}>{tile.title}</p>
          <p className="text-[11px] text-muted-foreground">{tile.profile}</p>
          {tile.show && many && (
            <p className="mt-1 text-xs"><span className="text-primary font-medium">{tile.rows.length} episodes</span> <span className="text-muted-foreground">{episodeCode(first)} - {episodeCode(last)}</span></p>
          )}
          {tile.show && !many && (
            <p className="mt-1 text-xs truncate"><span className="text-primary font-medium">{episodeCode(first, true)}</span>{first.episodeTitle ? ` ${first.episodeTitle}` : ""}</p>
          )}
          {!many && <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">{stamp(playedAt(first))}{first.rewatch && <RewatchChip />}</p>}
          {many && tile.rows.some((row) => row.rewatch) && <p className="mt-1"><RewatchChip /></p>}
        </div>
        <div className="flex flex-col items-end justify-between shrink-0">
          {many
            ? <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setOpen((v) => !v)} aria-label={open ? "Hide episodes" : "Show episodes"}>{open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</Button>
            : <span className="rounded-full bg-black/60 p-1 text-white"><Check className="h-3 w-3" /></span>}
          {tile.runtimeMs > 0 && <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white">{duration(tile.runtimeMs)}</span>}
        </div>
      </div>
      {open && (
        <div className="grid grid-cols-1 gap-2 border-t border-white/[0.06] p-3 sm:grid-cols-2 lg:grid-cols-3">
          {[...tile.rows].reverse().map((row) => <EpisodeLine key={`${row.profile}|${row.videoId}`} row={row} />)}
        </div>
      )}
    </div>
  );
}
const DAY_TILE_CAP = 6;
function PlayedDay({ day }: { day: DayGroup }) {
  const [all, setAll] = useState(false);
  const hidden = day.tiles.slice(DAY_TILE_CAP - 1);
  const capped = !all && day.tiles.length > DAY_TILE_CAP;
  const shown = capped ? day.tiles.slice(0, DAY_TILE_CAP - 1) : day.tiles;
  const rest = capped ? hidden : [];
  const restMovies = rest.filter((t) => !t.show).length;
  const restShows = rest.length - restMovies;
  const restEpisodes = rest.reduce((n, t) => n + (t.show ? t.rows.length : 0), 0);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-semibold">
          {day.date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })} · {day.date.toLocaleDateString(undefined, { weekday: "long" })}
          {day.runtimeMs > 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">{duration(day.runtimeMs)}</span>}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {day.movies > 0 && <span className="mr-3"><span className="text-foreground">{day.movies}</span> {day.movies === 1 ? "movie" : "movies"}</span>}
          {day.shows > 0 && <span className="mr-3"><span className="text-foreground">{day.shows}</span> {day.shows === 1 ? "show" : "shows"}</span>}
          {day.episodes > 0 && <span><span className="text-foreground">{day.episodes}</span> eps</span>}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((tile) => <DayTileCard key={tile.key} tile={tile} />)}
        {capped && (
          <button type="button" onClick={() => setAll(true)} className="flex items-center gap-3 rounded-lg border border-dashed border-white/[0.15] p-3 text-left hover:bg-muted/30">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-muted/60 text-lg font-semibold tabular-nums">{rest.length}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">Show {rest.length} more</span>
              <span className="block text-[11px] text-muted-foreground">
                {[restMovies ? `${restMovies} ${restMovies === 1 ? "movie" : "movies"}` : "", restShows ? `${restShows} ${restShows === 1 ? "show" : "shows"}` : "", restEpisodes ? `${restEpisodes} eps` : ""].filter(Boolean).join(" · ")}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </button>
        )}
        {all && day.tiles.length > DAY_TILE_CAP && (
          <button type="button" onClick={() => setAll(false)} className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-white/[0.15] p-3 text-xs text-muted-foreground hover:bg-muted/30">
            Show less <ChevronUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
export function PlayedByDay({ rows }: { rows: JellyfinPlayRow[] }) {
  const days = groupByDay(rows);
  return <div className="space-y-5">{days.map((day) => <PlayedDay key={day.key} day={day} />)}</div>;
}
export function PlayTable({ rows, kind }: { rows: JellyfinPlayRow[]; kind: "progress" | "played" }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-medium py-2 pr-3">Title</th>
            <th className="text-left font-medium py-2 pr-3">Profile</th>
            <th className="text-left font-medium py-2 pr-3 font-mono">Id</th>
            <th className="text-right font-medium py-2 pr-3">{kind === "progress" ? "Position" : "Played"}</th>
            <th className="text-right font-medium py-2">{kind === "progress" ? "Last played" : "Runtime"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const pct = percentOf(row);
            return (
              <tr key={`${row.profile}|${row.videoId}`} className="border-t border-white/[0.06]">
                <td className="py-2 pr-3">
                  <span className="font-medium">{row.title}</span>
                  {row.episode && <span className="text-muted-foreground"> · {row.episode}</span>}
                </td>
                <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">{row.profile}</td>
                <td className="py-2 pr-3 font-mono text-muted-foreground whitespace-nowrap">{row.videoId}</td>
                <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                  {kind === "progress"
                    ? <>{clock(row.positionMs)}{pct !== null && <span className="text-muted-foreground"> · {pct}%</span>}</>
                    : <>{when(row.watchedAt ?? row.lastPlayedAt)}{row.rewatch && <span className="text-muted-foreground"> · rewatch</span>}</>}
                </td>
                <td className="py-2 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                  {kind === "progress" ? when(row.lastPlayedAt ?? row.updatedAt) : row.runtimeMs > 0 ? clock(row.runtimeMs) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
