import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Bookmark, BookmarkCheck, CalendarPlus, Check, CheckCheck, CheckSquare, ChevronLeft, ChevronRight, Clock, Film, ImageOff, LayoutGrid, Loader2, MoreHorizontal, PencilLine, Play, Plus, Repeat, Rows3, Square, Star, ThumbsDown, Undo2, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useJellyfinTitle, useJellyfinTitleAction, useJellyfinWatchDate, type DashboardTab, type JellyfinTitle, type JellyfinTitleAction, type JellyfinTitleEpisode, type JellyfinTitlePerson, type JellyfinTitleRef } from "@/hooks/useDashboardQueries";
import { sizedArt } from "./art";
import { ActionMenu } from "./JellyfinShared";
import JellyfinPersonView, { CastRow } from "./JellyfinPerson";
import RemoteSheet, { type RemoteTarget } from "./JellyfinRemote";
import WatchDateSheet, { type WatchDateAnchor, type WatchDateTarget } from "./JellyfinWatchDate";
import { anchorOf, duration, ordinal, rewatchLabel, timesWatched, useRemembered, watchedWhen, when } from "./jellyfinUtils";
import { useTrackers } from "./trackers";
import { nameDashboardPage, type DashboardPage } from "@/lib/dashboardRoute";
import { artPalette, inkGround, type ArtPalette } from "./artPalette";
import { cx, code, heroArt, HERO_DESKTOP_SHARE, HERO_DESKTOP_UPSCALE, HERO_PHONE_SHARE, episodeMenuItems, GLASS_PILL, orderedSeasons, PHONE_PLAY_PILL, PLAY_PILL, playLabel, seasonLabel, sizedStill, SOLID_AT, under, useCenteredTab, usePhone, type Anchor, type SeasonItem } from "./titleHelpers";
import { Credits, DesktopTitleActions, EpisodeListRow, FactsBlock, MoodLine, PhoneTitleActions, SeasonPills, StarPicker, type TitleActionSpec } from "./JellyfinTitleParts";

const SECTION_TITLE = "text-xl font-bold sm:text-3xl";


const longDate = (at: number) => new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

// After an edit every dashboard view reads again, but the title page that made it, which has just read itself.
const changedBy = (q: Query, since: number) =>
  q.queryKey[0] === "dashboard" && q.queryKey[1] === "jellyfin" && !(q.queryKey[2] === "title" && q.state.dataUpdatedAt >= since);



function nextUp(title: JellyfinTitle, now: number): JellyfinTitleEpisode | null {
  const regular = title.episodes.filter((ep) => ep.season !== 0);
  const open = (ep: JellyfinTitleEpisode) => !ep.played && !(ep.airsAt && ep.airsAt > now);
  const latest = regular.reduce((at, ep, i) => (ep.played && (ep.lastPlayedAt ?? 0) >= (regular[at]?.lastPlayedAt ?? -1) ? i : at), -1);
  return regular.slice(latest + 1).find(open) ?? regular.find(open) ?? null;
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "brand" }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium", tone === "brand" ? "border-blue-400/40 bg-blue-500/10 text-blue-200" : "border-white/15 text-foreground/80")}>
      {children}
    </span>
  );
}

function Overview({ text, phone }: { text: string; phone: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !expanded) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);
  return (
    <div className="mt-1 max-w-3xl">
      <p ref={ref} onClick={() => clamped && !expanded && setExpanded(true)} className={cx(phone ? "text-[15px] leading-[1.55] text-[#f0eae3]/80" : "text-base leading-relaxed text-foreground/90 sm:text-lg", !expanded && "line-clamp-3")}>{text}</p>
      {clamped && (
        <button type="button" onClick={() => setExpanded((v) => !v)} className={phone ? "mt-2 text-sm font-semibold text-white/75" : "mt-1.5 text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"}>
          {expanded ? "Show less" : phone ? "More" : "Show more"}
        </button>
      )}
    </div>
  );
}





function EpisodeCard({ ep, now, selecting, selected, busy, highlighted, className, onToggleSelect, onAction, onPlayOn, onDate }: {
  ep: JellyfinTitleEpisode;
  now: number;
  selecting: boolean;
  selected: boolean;
  busy: boolean;
  highlighted: boolean;
  className?: string;
  onToggleSelect: () => void;
  onAction: (action: JellyfinTitleAction) => void;
  onPlayOn: (at: Anchor) => void;
  onDate: (anchor: WatchDateAnchor) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [failed, setFailed] = useState(false);
  const unaired = Boolean(ep.airsAt && ep.airsAt > now);
  const progress = ep.played ? 100 : ep.runtimeMs > 0 && ep.positionMs > 0 ? Math.min(100, (ep.positionMs / ep.runtimeMs) * 100) : 0;
  const still = failed ? null : sizedStill(ep.still, 416);
  return (
    <div
      onClick={selecting ? onToggleSelect : undefined}
      onContextMenu={(event) => { if (!selecting) { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); } }}
      data-episode={ep.id}
      className={cx("group relative", selecting && "cursor-pointer", unaired && "opacity-60", className)}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-md bg-white/5">
        {(highlighted || selected) && <span className={cx("pointer-events-none absolute inset-0 z-10 rounded-md ring-2 ring-inset", selected ? "ring-blue-300" : "ring-blue-500")} />}
        {still ? (
          <img src={still} alt={ep.name ?? ""} loading="lazy" onError={() => setFailed(true)} className="h-full w-full rounded-md object-cover transition-[opacity,transform] duration-300 ease-out will-change-transform group-hover:scale-105 group-hover:opacity-75" />
        ) : (
          <div className="flex h-full w-full items-center justify-center"><ImageOff className="size-10 text-muted-foreground/60" /></div>
        )}
        {ep.runtimeMs > 0 && <span className="absolute right-2 top-2 rounded-md bg-black/70 px-2 py-0.5 text-xs font-semibold text-white">{duration(ep.runtimeMs)}</span>}
        {ep.played && !selecting && <span className="absolute left-2 top-2 flex size-6 items-center justify-center rounded-full bg-blue-500 text-white shadow"><Check className="size-3.5" strokeWidth={3} /></span>}
        {selecting && <span className="absolute left-2 top-2 text-white drop-shadow">{selected ? <CheckSquare className="size-6 text-blue-300" /> : <Square className="size-6" />}</span>}
        {!selecting && !unaired && (
          <div className="absolute inset-0 flex items-center justify-center gap-3 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); onPlayOn(under(event.currentTarget)); }}
              title="Play on a device"
              className="rounded-full bg-black/60 p-4 transition hover:bg-black/75"
            >
              <Play className="size-6 fill-white text-white" />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={(event) => { event.stopPropagation(); onAction(ep.played ? "unplayed" : "played"); }}
              title={ep.played ? "Mark unwatched" : "Mark watched"}
              className={cx("rounded-full p-3 transition", ep.played ? "bg-blue-500/90 hover:bg-blue-500" : "bg-black/60 hover:bg-black/75")}
            >
              {busy ? <Loader2 className="size-5 animate-spin text-white" /> : ep.played ? <Undo2 className="size-5 text-white" /> : <Check className="size-5 text-white" strokeWidth={3} />}
            </button>
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 z-20 rounded-md ring-1 ring-inset ring-white/10 transition group-hover:ring-white/25" />
        {progress > 0 && (
          <div className="absolute inset-x-0 bottom-0 z-30 h-1 bg-gray-700"><div className="h-full bg-blue-500 transition-[width]" style={{ width: `${progress}%` }} /></div>
        )}
      </div>
      <div className="relative mt-2 flex items-start gap-1">
        <p className="min-w-0 flex-1 truncate text-base">{ep.name || "No title"}</p>
        {!selecting && (
          <button type="button" onMouseDown={(event) => { if (menu) event.stopPropagation(); }} onClick={(event) => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); setMenu((v) => (v ? null : { x: box.right - 224, y: box.bottom + 4 })); }} aria-label="More" className="-mr-1.5 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-foreground">
            <MoreHorizontal className="size-4" />
          </button>
        )}
        {menu && <ActionMenu at={menu} onClose={closeMenu} items={episodeMenuItems(ep, unaired, menu, onAction, onPlayOn)} />}
      </div>
      {ep.overview && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{ep.overview}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {ep.number !== null && <Badge>{code(ep)}</Badge>}
        {ep.airsAt && <Badge>{unaired ? `Airs ${longDate(ep.airsAt)}` : longDate(ep.airsAt)}</Badge>}
        {ep.played && (selecting ? (
          <Badge tone="brand"><Check className="size-3" strokeWidth={3} /> {ep.watches[0] ? when(ep.watches[0]) : "Watched"}{timesWatched(ep) > 1 ? ` · ×${timesWatched(ep)}` : ""}</Badge>
        ) : (
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); onDate(anchorOf(event.currentTarget)); }}
            title={ep.watches[0] ? "Change when you watched it" : "Add when you watched it"}
            className="group/date inline-flex items-center gap-1 rounded-md border border-blue-400/40 bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-200 transition-colors hover:border-blue-300/70 hover:bg-blue-500/20"
          >
            <Check className="size-3" strokeWidth={3} /> {ep.watches[0] ? when(ep.watches[0]) : "Watched"}{timesWatched(ep) > 1 ? ` · ×${timesWatched(ep)}` : ""}
            <PencilLine className="size-3 opacity-0 transition-opacity group-hover/date:opacity-100" />
          </button>
        ))}
        {ep.played && ep.positionMs > 0 && <Badge><Repeat className="size-3" /> {rewatchLabel(ep.positionMs)}</Badge>}
        {!ep.played && ep.positionMs > 0 && ep.runtimeMs > 0 && <Badge tone="brand">{duration(Math.max(0, ep.runtimeMs - ep.positionMs))} left</Badge>}
      </div>
    </div>
  );
}


function SeasonPoster({ season, shared, number }: { season: SeasonItem; shared: boolean; number: string }) {
  const [failed, setFailed] = useState(false);
  const src = season.poster && season.tag && !failed ? `${season.poster}&maxWidth=300` : null;
  return (
    <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-foreground/[0.08]">
      {src && <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className={cx("absolute inset-0 h-full w-full object-cover", shared && "brightness-[0.45]")} />}
      {(shared || !src) && <span className="absolute inset-0 flex items-center justify-center text-4xl font-bold tracking-tight text-white drop-shadow-lg sm:text-5xl">{number}</span>}
    </div>
  );
}

function SeasonRail({ seasons, watched, selected, onSelect, onMenu }: { seasons: SeasonItem[]; watched: Set<number>; selected: number | null; onSelect: (season: number) => void; onMenu: (season: SeasonItem, at: { x: number; y: number }) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const ordered = useMemo(() => orderedSeasons(seasons), [seasons]);
  const sharedTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const season of seasons) if (season.tag) counts.set(season.tag, (counts.get(season.tag) ?? 0) + 1);
    return new Set([...counts].filter(([, count]) => count > 1).map(([tag]) => tag));
  }, [seasons]);
  useCenteredTab(track, selected);
  useEffect(() => {
    const row = track.current;
    if (!row) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const max = row.scrollWidth - row.clientWidth;
      if (max <= 0) return;
      const atEnd = (event.deltaY < 0 && row.scrollLeft <= 0) || (event.deltaY > 0 && row.scrollLeft >= max - 1);
      if (atEnd) return;
      event.preventDefault();
      row.scrollLeft += event.deltaY;
    };
    row.addEventListener("wheel", onWheel, { passive: false });
    return () => row.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <div ref={track} role="tablist" aria-label="Select a season" className="-mx-4 flex max-w-[calc(100%+2rem)] gap-3 overflow-x-auto px-4 pb-1 pt-2 sm:-mx-1 sm:max-w-full sm:gap-4 sm:px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {ordered.map((season) => {
        const active = season.season === selected;
        return (
          <button
            key={season.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={season.name ?? undefined}
            onClick={() => onSelect(season.season)}
            onContextMenu={(event) => { event.preventDefault(); onMenu(season, { x: event.clientX, y: event.clientY }); }}
            className={cx("group flex w-24 shrink-0 flex-col items-stretch gap-2 text-left outline-none transition-[opacity,transform] duration-200 sm:w-28 md:w-32", active ? "opacity-100" : "opacity-55 hover:opacity-85 active:scale-[0.97]")}
          >
            <div className={cx("relative w-full rounded-xl transition-shadow duration-200", active ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-background" : "group-focus-visible:ring-2 group-focus-visible:ring-ring")}>
              <SeasonPoster season={season} shared={Boolean(season.tag && sharedTags.has(season.tag))} number={season.season === 0 ? "SP" : String(season.season)} />
              {watched.has(season.season) && <span aria-label="Season watched" className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-blue-500 text-white shadow"><Check className="size-3" strokeWidth={3} /></span>}
            </div>
            <span className="w-full min-w-0">
              <span className="block truncate text-sm font-semibold">{seasonLabel(season.season)}</span>
              {season.count ? <span className="block text-xs tabular-nums text-muted-foreground">{season.count} {season.count === 1 ? "episode" : "episodes"}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function EpisodeRow({ focus, children }: { focus: string | null; children: React.ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const [edges, setEdges] = useState({ start: true, end: false });
  const measure = () => {
    const el = track.current;
    if (!el) return;
    const start = el.scrollLeft <= 4;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  };
  useLayoutEffect(() => {
    const el = track.current;
    const card = focus && !focused.current ? el?.querySelector<HTMLElement>(`[data-episode="${CSS.escape(focus)}"]`) : null;
    if (!el || !card) return;
    focused.current = true;
    el.scrollLeft = card.offsetLeft - el.offsetLeft - (Number.parseFloat(getComputedStyle(el).scrollPaddingLeft) || 0);
  }, [focus]);
  useEffect(measure, [children]);
  const page = (dir: 1 | -1) => track.current?.scrollBy({ left: dir * track.current.clientWidth * 0.85, behavior: "smooth" });
  const arrow = "glass absolute top-[22%] z-20 hidden size-11 items-center justify-center rounded-full text-white transition hover:bg-black/60 md:flex";
  return (
    <div className="relative -mx-4 sm:-mx-12">
      <div ref={track} onScroll={measure} className="flex snap-x gap-4 overflow-x-auto scroll-px-4 px-4 pb-2 sm:scroll-px-12 sm:px-12 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{children}</div>
      {!edges.start && <button type="button" aria-label="Scroll back" onClick={() => page(-1)} className={`${arrow} left-3`}><ChevronLeft className="size-5" /></button>}
      {!edges.end && <button type="button" aria-label="Scroll on" onClick={() => page(1)} className={`${arrow} right-3`}><ChevronRight className="size-5" /></button>}
    </div>
  );
}

type HistoryEntry = { key: string; itemId: string; label: string; sub: string; at: number | null; dated: number | null | undefined; image: string | null; again: boolean };

function historyOf(item: { played: boolean; playCount: number; watches: number[]; positionMs: number; lastPlayedAt: number | null }, key: string, label: string, image: string | null): HistoryEntry[] {
  const out: HistoryEntry[] = item.watches.map((at, i) => {
    const n = item.watches.length - i;
    return { key: `${key}|${at}`, itemId: key, label, sub: n > 1 ? `Watched · ${ordinal(n)} time` : "Watched", at, dated: at, image, again: n > 1 };
  });
  if (item.positionMs > 0 && item.lastPlayedAt) {
    out.push({ key: `${key}|now`, itemId: key, label, sub: item.played ? rewatchLabel(item.positionMs) : `${duration(item.positionMs) || "Under a minute"} in`, at: item.lastPlayedAt, dated: undefined, image, again: item.played });
  }
  if (item.played && !item.watches.length) out.push({ key: `${key}|undated`, itemId: key, label, sub: "Watched", at: null, dated: null, image, again: false });
  return out;
}

type Glide = { key: string; from: DOMRect | null };

function History({ title, glide, onDate, onGlided }: { title: JellyfinTitle; glide: Glide | null; onDate: (entry: HistoryEntry, anchor: WatchDateAnchor) => void; onGlided: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  const plays = useMemo(() => {
    const backdrop = sizedArt(title.backdropUrl, 342) ?? title.backdropUrl;
    const rows = title.type === "movie"
      ? historyOf(title, title.id, title.title, backdrop)
      : title.episodes.flatMap((ep) => historyOf(ep, ep.id, `${code(ep)}${ep.name ? ` · ${ep.name}` : ""}`, sizedStill(ep.still, 342) ?? backdrop));
    return rows.sort((a, b) => (b.at ?? -1) - (a.at ?? -1)).slice(0, 80);
  }, [title]);
  const days = useMemo(() => {
    const out: Array<{ day: string; rows: typeof plays }> = [];
    for (const row of plays) {
      const day = row.at === null ? "Date not recorded" : new Date(row.at).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
      const last = out[out.length - 1];
      if (last?.day === day) last.rows.push(row);
      else out.push({ day, rows: [row] });
    }
    return out;
  }, [plays]);
  useLayoutEffect(() => {
    if (!glide) return;
    const row = list.current?.querySelector<HTMLElement>(`[data-play="${CSS.escape(glide.key)}"]`);
    if (!row) return;
    onGlided();
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const day = row.closest("section");
    const pulse = () => {
      day?.querySelector("[data-dot]")?.animate([{ transform: "scale(1)", boxShadow: "0 0 0 0 rgba(59,130,246,.7)" }, { transform: "scale(1.35)", boxShadow: "0 0 0 10px rgba(59,130,246,0)" }, { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(59,130,246,0)" }], { duration: 900, easing: "ease-out" });
      const head = day?.querySelector("h4");
      if (head) {
        head.style.color = "rgb(147 197 253)";
        window.setTimeout(() => { head.style.color = ""; }, 1100);
      }
      row.animate([{ boxShadow: "0 0 0 1px rgba(96,165,250,.6)" }, { boxShadow: "0 0 0 1px rgba(96,165,250,0)" }], { duration: 1400, easing: "ease-out" });
    };
    const box = row.getBoundingClientRect();
    const shown = box.top >= 0 && box.bottom <= window.innerHeight;
    if (glide.from && shown && !calm) {
      row.animate([{ transform: `translate(${glide.from.left - box.left}px, ${glide.from.top - box.top}px)` }, { transform: "none" }], { duration: 650, easing: "cubic-bezier(.2,.8,.2,1)" }).finished.then(pulse, pulse);
      return;
    }
    row.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
    window.setTimeout(pulse, calm ? 0 : 450);
  }, [glide, plays, onGlided]);
  if (!plays.length) return <p className="text-sm text-muted-foreground">Nothing played yet on this profile.</p>;
  return (
    <div ref={list} className="relative max-w-3xl space-y-8 before:absolute before:bottom-2 before:left-[7px] before:top-2 before:w-px before:bg-white/10">
      {days.map((d) => (
        <section key={d.day} className="relative pl-8">
          <span data-dot className={cx("absolute left-0 top-1 size-[15px] rounded-full border-2 bg-background", d.rows[0]?.at === null ? "border-white/25" : "border-blue-500")} />
          <h4 className={cx("mb-3 text-sm font-semibold transition-colors duration-700", d.rows[0]?.at === null ? "text-muted-foreground" : "text-foreground/90")}>{d.day}</h4>
          {d.rows[0]?.at === null && <p className="-mt-2 mb-3 text-xs text-muted-foreground">Marked watched before plays were dated, or imported without a date.</p>}
          <div className="space-y-2">
            {d.rows.map((row) => (
              <div key={row.key} data-play={row.key} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-2">
                {row.image ? <img src={row.image} alt="" loading="lazy" className="aspect-video w-20 shrink-0 rounded-md object-cover sm:w-24" /> : <span className="flex aspect-video w-20 shrink-0 items-center justify-center rounded-md bg-white/5 sm:w-24"><Film className="size-4 text-muted-foreground" /></span>}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium sm:truncate">{row.label}</p>
                  <p className="truncate text-xs text-muted-foreground">{row.sub}</p>
                </div>
                {row.again && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-foreground/80"><Repeat className="size-3" /> Rewatch</span>}
                {row.dated === undefined ? (
                  row.at !== null && <span className="flex h-9 shrink-0 items-center gap-1.5 px-2.5 text-xs tabular-nums text-muted-foreground sm:px-3"><Clock className="size-3.5 max-sm:hidden" />{new Date(row.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
                ) : (
                  <button
                    type="button"
                    onClick={(event) => onDate(row, anchorOf(event.currentTarget))}
                    title={row.dated === null ? "Add when you watched it" : "Change when you watched it"}
                    className={cx(
                      "group/date flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs sm:px-3 font-medium tabular-nums ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60",
                      row.dated === null ? "bg-blue-500/15 text-blue-200 ring-blue-400/40 hover:bg-blue-500/25" : "bg-white/[0.05] text-foreground/80 ring-white/10 hover:bg-white/[0.12] hover:text-foreground"
                    )}
                  >
                    {row.dated === null ? <><CalendarPlus className="size-3.5" /> Add date</> : <><Clock className="size-3.5 text-muted-foreground transition-colors group-hover/date:text-foreground max-sm:hidden" />{new Date(row.dated).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}<PencilLine className="-mr-0.5 size-3.5 w-0 opacity-0 transition-all group-hover/date:w-3.5 group-hover/date:opacity-100 group-focus-visible/date:w-3.5 group-focus-visible/date:opacity-100 [@media(hover:none)]:w-3.5 [@media(hover:none)]:opacity-60" /></>}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Details({ title }: { title: JellyfinTitle }) {
  const facts: Array<[string, string]> = title.type === "series" ? [["Episodes", `${title.aired} aired · ${title.episodes.length} listed`]] : [];
  const links = [
    title.ids.imdb && { label: "IMDb", href: `https://www.imdb.com/title/${title.ids.imdb}/` },
    title.ids.tmdb && { label: "TMDB", href: `https://www.themoviedb.org/${title.type === "movie" ? "movie" : "tv"}/${title.ids.tmdb}` },
    title.ids.tvdb && { label: "TVDB", href: `https://thetvdb.com/dereferrer/${title.type === "movie" ? "movie" : "series"}/${title.ids.tvdb}` },
    title.ids.mal && { label: "MyAnimeList", href: `https://myanimelist.net/anime/${title.ids.mal}` },
    title.ids.anilist && { label: "AniList", href: `https://anilist.co/anime/${title.ids.anilist}` },
    title.ids.kitsu && { label: "Kitsu", href: `https://kitsu.app/anime/${title.ids.kitsu}` },
    title.ids.anidb && { label: "AniDB", href: `https://anidb.net/anime/${title.ids.anidb}` },
  ].filter(Boolean) as Array<{ label: string; href: string }>;
  return (
    <div className="flex flex-wrap gap-2 max-sm:justify-center">
      {facts.map(([label, value]) => (
        <span key={label} className="inline-flex items-center gap-1.5 rounded-full border border-white/5 bg-white/5 px-3 py-1 text-sm"><span className="text-muted-foreground">{label}</span>{value}</span>
      ))}
      {links.map((link) => <a key={link.label} href={link.href} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-full border border-white/5 bg-white/5 px-3 py-1 text-sm transition hover:bg-white/10 hover:underline">{link.label} ↗</a>)}
    </div>
  );
}

function TitleView({ userUUID, profile, profileName, sentTo, titleRef, initialSeason, activeTab, shown, onBack, onCloseAll, onPerson }: {
  userUUID: string;
  profile: string | null;
  profileName: string;
  sentTo: string[];
  titleRef: JellyfinTitleRef;
  initialSeason?: number | null;
  activeTab: DashboardTab;
  shown: boolean;
  onBack: () => void;
  onCloseAll: () => void;
  onPerson: (person: JellyfinTitlePerson) => void;
}) {
  const trackers = useTrackers();
  const queryClient = useQueryClient();
  const act = useJellyfinTitleAction();
  const moveDate = useJellyfinWatchDate();
  const { data, isLoading, isError, isFetching, refetch } = useJellyfinTitle(userUUID, profile, titleRef, { activeTab });
  const [season, setSeason] = useState<number | null | undefined>(initialSeason);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [seasonMenu, setSeasonMenu] = useState<{ season: SeasonItem; at: { x: number; y: number } } | null>(null);
  const closeSeasonMenu = useCallback(() => setSeasonMenu(null), []);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [layout, setLayout] = useRemembered<"row" | "grid">("jellyfin.title.episodes", "row");
  const phone = usePhone();
  const [palette, setPalette] = useState<ArtPalette | null>(null);
  const [solid, setSolid] = useState(false);
  const [now] = useState(() => Date.now());
  const [heroLoaded, setHeroLoaded] = useState(false);
  const [posterLoaded, setPosterLoaded] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const [remote, setRemote] = useState<{ target: RemoteTarget; at: Anchor } | null>(null);
  const closeRemote = useCallback(() => setRemote(null), []);

  const title = useMemo(() => {
    if (!data) return null;
    if (!Object.keys(pending).length) return data;
    const episodes = data.episodes.map((ep) => (ep.id in pending ? { ...ep, played: pending[ep.id], positionMs: pending[ep.id] ? 0 : ep.positionMs } : ep));
    const aired = episodes.filter((ep) => ep.season !== 0 && !(ep.airsAt && ep.airsAt > now));
    return { ...data, episodes, watched: aired.filter((ep) => ep.played).length, played: data.id in pending ? pending[data.id] : data.played };
  }, [data, pending, now]);
  useEffect(() => {
    if (shown && data?.title) nameDashboardPage(`${data.title} ${data.year ?? ""}`, data.linkable ? { kind: "title", ref: { id: data.metaId, type: data.type } } : undefined);
  }, [shown, data?.title, data?.year, data?.linkable, data?.metaId, data?.type]);

  const seasons = useMemo(() => {
    const out = new Map<number | null, JellyfinTitleEpisode[]>();
    for (const ep of title?.episodes ?? []) out.set(ep.season, [...(out.get(ep.season) ?? []), ep]);
    return [...out.entries()].sort(([a], [b]) => (a === 0 ? 1 : b === 0 ? -1 : (a ?? 0) - (b ?? 0)));
  }, [title]);
  const next = title ? nextUp(title, now) : null;
  const shownSeason = season !== undefined && seasons.some(([s]) => s === season) ? season : next?.season ?? seasons[0]?.[0] ?? null;
  const episodes = seasons.find(([s]) => s === shownSeason)?.[1] ?? [];
  const isSeries = title?.type === "series";

  const run = async (action: JellyfinTitleAction, ids: string[], label: string, optimistic?: boolean, value: number | null = null, shownIds: string[] = ids) => {
    const since = Date.now();
    setBusy(ids.length === 1 ? ids[0] + action : action);
    if (optimistic !== undefined) setPending((held) => ({ ...held, ...Object.fromEntries(shownIds.map((id) => [id, optimistic])) }));
    try {
      await act(userUUID, profile, action, ids, value);
      await refetch();
      setPending({});
      void queryClient.invalidateQueries({ predicate: (q) => changedBy(q, since) });
      toast.success(label);
    } catch (error) {
      setPending({});
      toast.error(error instanceof Error ? error.message : "Could not save the change");
    } finally {
      setBusy(null);
    }
  };

  const [dateSheet, setDateSheet] = useState<{ target: WatchDateTarget; anchor: WatchDateAnchor } | null>(null);
  const closeDateSheet = useCallback(() => setDateSheet(null), []);
  const [glide, setGlide] = useState<Glide | null>(null);
  const glided = useCallback(() => setGlide(null), []);
  const openDate = (itemId: string, from: number | null, anchor: WatchDateAnchor) => {
    if (!title) return;
    const ep = title.episodes.find((e) => e.id === itemId);
    const backdrop = sizedArt(title.backdropUrl, 342) ?? title.backdropUrl;
    setDateSheet({
      anchor,
      target: {
        itemId,
        episode: Boolean(ep),
        heading: ep ? `${code(ep)}${ep.name ? ` · ${ep.name}` : ""}` : title.title,
        sub: null,
        still: ep ? sizedStill(ep.still, 320) ?? backdrop : backdrop,
        from,
        releasedAt: ep ? ep.airsAt : title.releasedAt,
        others: ep ? ep.watches : title.watches,
      },
    });
  };
  const redate = async (itemId: string, from: number | null, to: number): Promise<boolean> => {
    const since = Date.now();
    try {
      const before = document.querySelector(`[data-play="${CSS.escape(`${itemId}|${from ?? "undated"}`)}"]`)?.getBoundingClientRect() ?? null;
      await moveDate(userUUID, profile, itemId, from, to);
      await refetch();
      setGlide({ key: `${itemId}|${to}`, from: before });
      void queryClient.invalidateQueries({ predicate: (q) => changedBy(q, since) });
      toast.success(`Watched ${longDate(to)}`);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the date");
      return false;
    }
  };

  const toggleSelect = (id: string) => setSelected((held) => {
    const nextSet = new Set(held);
    if (nextSet.has(id)) nextSet.delete(id); else nextSet.add(id);
    return nextSet;
  });
  const endSelect = () => { setSelecting(false); setSelected(new Set()); };
  const bulk = async (action: JellyfinTitleAction) => {
    const ids = [...selected];
    await run(action, ids, `${ids.length} ${ids.length === 1 ? "episode" : "episodes"} marked ${action === "played" ? "watched" : "unwatched"}`, action === "played");
    endSelect();
  };

  const hero = phone ? heroArt(title?.backdropUrl, HERO_PHONE_SHARE) : heroArt(title?.backdropUrl, HERO_DESKTOP_SHARE, HERO_DESKTOP_UPSCALE);
  const wash = sizedArt(title?.backdropUrl, 342) ?? title?.backdropUrl ?? null;
  const allWatched = Boolean(title && isSeries && title.aired > 0 && title.watched >= title.aired);
  const progress = title && title.aired ? (title.watched / title.aired) * 100 : 0;
  const stateLine = !title ? null : isSeries
    ? allWatched ? (title.status === "Ended" ? "Finished" : "Caught up, waiting for new episodes") : next ? `${title.watched ? "Up next" : "Start with"} ${code(next)}${next.name ? ` · ${next.name}` : ""}` : "Not started"
    : title.played ? [
      title.watches[0] ? `Watched ${watchedWhen(title.watches[0])}` : "Watched",
      timesWatched(title) > 1 ? `${timesWatched(title)} times` : "",
      title.positionMs > 0 ? (title.positionMs < 60_000 ? `started again ${when(title.lastPlayedAt)}` : rewatchLabel(title.positionMs).toLowerCase()) : "",
    ].filter(Boolean).join(" · ") : title.positionMs > 0 ? `${duration(title.positionMs) || "Under a minute"} in` : "Not watched";
  const ready = episodes.filter((ep) => !(ep.airsAt && ep.airsAt > now));
  const seasonDone = ready.length > 0 && ready.every((ep) => ep.played);
  const seasonId = title?.seasons.find((s) => s.season === shownSeason)?.id;
  const watchedSeasons = new Set(seasons.filter(([s, list]) => {
    const aired = list.filter((ep) => !(ep.airsAt && ep.airsAt > now));
    return s !== null && aired.length > 0 && aired.every((ep) => ep.played);
  }).map(([s]) => s as number));

  const episodeTarget = (ep: JellyfinTitleEpisode): RemoteTarget => ({
    itemId: ep.id,
    itemType: "Episode",
    itemName: ep.name ?? code(ep),
    heading: ep.name || code(ep) || "Episode",
    sub: [title?.title, code(ep)].filter(Boolean).join(" · "),
    still: sizedStill(ep.still, 320),
  });
  const titleTarget = (): RemoteTarget | null => {
    if (!title) return null;
    if (isSeries && next) return episodeTarget(next);
    return { itemId: title.id, itemType: isSeries ? "Series" : "Movie", itemName: title.title, heading: title.title, sub: title.year, still: sizedArt(title.backdropUrl, 342) ?? title.backdropUrl };
  };

  const episodeProps = (ep: JellyfinTitleEpisode) => ({
    ep,
    now,
    selecting,
    selected: selected.has(ep.id),
    highlighted: !selecting && ep.id === next?.id,
    busy: busy === ep.id + "played" || busy === ep.id + "unplayed" || busy === ep.id + "playedUpTo",
    onToggleSelect: () => toggleSelect(ep.id),
    onPlayOn: (at: Anchor) => setRemote({ target: episodeTarget(ep), at }),
    onDate: (anchor: WatchDateAnchor) => openDate(ep.id, ep.watches[0] ?? null, anchor),
    onAction: (action: JellyfinTitleAction) => void run(action, [ep.id], action === "playedUpTo" ? `Watched up to ${code(ep)}` : action === "played" ? `${code(ep)} marked watched` : `${code(ep)} marked unwatched`, action === "playedUpTo" ? undefined : action === "played"),
  });
  const card = (ep: JellyfinTitleEpisode, className?: string) => <EpisodeCard key={ep.id} className={className} {...episodeProps(ep)} />;
  const glow = phone && Boolean(hero);
  useEffect(() => {
    if (!glow || !wash) return;
    let live = true;
    void artPalette(wash).then((found) => { if (live) setPalette(found); });
    return () => { live = false; };
  }, [glow, wash]);
  const playOn = (button: Element) => {
    const target = titleTarget();
    if (target) setRemote({ target, at: under(button) });
  };
  const centred = (): WatchDateAnchor => ({ left: window.innerWidth / 2, right: window.innerWidth / 2, top: window.innerHeight / 3, bottom: window.innerHeight / 3 });
  const seasonCount = title?.seasons.filter((s) => s.season > 0).length ?? 0;
  const titleBusy = (...actions: JellyfinTitleAction[]) => Boolean(title && actions.some((action) => busy === title.id + action));
  const titleActions: TitleActionSpec[] = !title ? [] : [
    {
      key: "watchlist",
      label: "Watchlist",
      detail: title.onWatchlist ? "Remove from the watchlist" : "Add to the watchlist",
      placement: "row",
      active: title.onWatchlist,
      busy: titleBusy("watchlist", "unwatchlist"),
      icon: phone ? (title.onWatchlist ? <BookmarkCheck strokeWidth={1.75} className="fill-white/15" /> : <Bookmark strokeWidth={1.75} />) : title.onWatchlist ? <Check className="size-[22px]" strokeWidth={2.5} /> : <Plus className="size-[22px]" />,
      run: () => void run(title.onWatchlist ? "unwatchlist" : "watchlist", [title.id], title.onWatchlist ? "Removed from the watchlist" : "Added to the watchlist"),
    },
    {
      key: "rate",
      label: title.rating !== null ? `${title.rating}/10` : "Rate",
      detail: title.rating !== null ? `Rated ${title.rating}/10` : "Rate",
      placement: "row",
      active: title.rating !== null,
      busy: titleBusy("rate"),
      icon: <Star strokeWidth={phone ? 1.75 : 2} className={cx(!phone && "size-5", title.rating !== null && "!text-amber-400")} fill={title.rating !== null ? "currentColor" : "none"} />,
      panel: (close) => <StarPicker value={title.rating} onPick={(value) => { close(); void run("rate", [title.id], value === null ? "Rating cleared" : `Rated ${value}/10`, undefined, value); }} />,
    },
    {
      key: "played",
      label: isSeries ? (allWatched ? "Mark unwatched" : "Mark all watched") : title.played ? "Mark unwatched" : "Mark watched",
      detail: isSeries && !allWatched ? "Every aired episode" : undefined,
      placement: "more",
      busy: titleBusy("played", "unplayed"),
      icon: (isSeries ? allWatched : title.played) ? <Undo2 className="size-4" /> : isSeries ? <CheckCheck className="size-4" /> : <Check className="size-4" />,
      run: () => isSeries
        ? void run(allWatched ? "unplayed" : "played", [title.id], allWatched ? "Marked unwatched" : "Every aired episode marked watched")
        : void run(title.played ? "unplayed" : "played", [title.id], title.played ? "Marked unwatched" : "Marked watched", !title.played),
    },
    ...(isSeries ? [{
      key: "drop",
      label: title.dropped ? "Pick back up" : "Drop",
      placement: "more" as const,
      busy: titleBusy("drop", "undrop"),
      icon: title.dropped ? <Undo2 className="size-4" /> : <ThumbsDown className="size-4" />,
      run: () => void run(title.dropped ? "undrop" : "drop", [title.id], title.dropped ? "Picked back up" : "Dropped"),
    }] : []),
    ...(!isSeries && title.played ? [{
      key: "date",
      label: title.watches[0] ? "Change when you watched it" : "Add when you watched it",
      placement: "more" as const,
      icon: <CalendarPlus className="size-4" />,
      run: () => openDate(title.id, title.watches[0] ?? null, centred()),
    }] : []),
  ];
  const playText = isSeries && next ? playLabel(next) : "Play on…";

  return createPortal(
    <div onScroll={phone ? (event) => setSolid(event.currentTarget.scrollTop > window.innerHeight * SOLID_AT) : undefined} className={cx("fixed inset-0 z-[100] overflow-y-auto overflow-x-hidden overscroll-contain bg-background animate-fade-in", !shown && "invisible")} aria-hidden={!shown} role="dialog" aria-modal="true" aria-label={title?.title ?? "Title"}>
      <div className="relative isolate min-h-full">
        {glow && <div aria-hidden className="pointer-events-none fixed inset-0 -z-30 select-none" style={inkGround(palette)} />}
        {wash && !glow && (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-20 h-[220vh] max-h-full select-none overflow-hidden [mask-image:linear-gradient(to_bottom,black_25%,transparent)] max-sm:hidden">
            <img src={wash} alt="" className={cx("h-full w-full scale-125 object-cover blur-[100px] saturate-150 transition-opacity duration-1000", heroLoaded ? "opacity-35" : "opacity-0")} />
          </div>
        )}
        <div className={cx("pointer-events-none absolute left-0 top-0 -z-10 w-full select-none overflow-hidden", glow ? "h-[88vh] [mask-image:linear-gradient(to_bottom,black_72%,transparent)]" : "h-[75vh] max-sm:h-[55vh] sm:[mask-image:linear-gradient(to_bottom,black_50%,transparent)] md:h-[85vh]")}>
          {hero && (
            <div className="relative h-full w-full">
              <img src={hero} alt="" onLoad={() => setHeroLoaded(true)} className={cx("h-full w-full object-cover transition-[filter,opacity] duration-700 ease-out", heroLoaded ? (glow ? "opacity-100 blur-0" : "opacity-45 blur-0 max-sm:opacity-80") : "opacity-0 blur-lg")} />
              {!glow && <div className="absolute inset-0 bg-gradient-to-r from-background via-background/75 to-transparent max-sm:hidden" />}
              {glow
                ? <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/70 via-black/35 to-transparent" />
                : <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-background via-background/85 to-transparent sm:hidden" />}
            </div>
          )}
          {!heroLoaded && <div className="absolute inset-0 animate-pulse bg-white/[0.03]" />}
        </div>

        <div className={cx("sticky top-0 z-40 flex items-center justify-between gap-3 px-4 pt-4 sm:px-12 sm:pt-6", phone && "h-14 px-3 pt-0 transition-[background-color,border-color] duration-300", phone && (solid ? "border-b border-white/5 bg-background/95" : "border-b border-transparent"))}>
          <button type="button" onClick={onBack} aria-label="Back" className={cx("flex shrink-0 items-center justify-center rounded-full", phone ? cx("size-10 transition-colors duration-300", solid ? "bg-transparent" : "border border-white/10 bg-black/35 backdrop-blur-md") : "glass size-11 hover:bg-black/50")}><ArrowLeft className="size-5" /></button>
          {phone && (
            <div aria-hidden={!solid} className={cx("flex min-w-0 flex-1 items-center justify-center transition-[opacity,transform] duration-300", solid ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0")}>
              {title?.logoUrl && !logoFailed ? <img src={sizedArt(title.logoUrl, 500) ?? title.logoUrl} alt={title.title} className="max-h-8 max-w-[70%] object-contain" /> : <span className="truncate text-base font-semibold">{title?.title}</span>}
            </div>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {!(phone && solid) && <span className="glass rounded-full px-3.5 py-2 text-xs text-muted-foreground">Viewing as <span className="font-semibold text-foreground">{profileName}</span></span>}
            <button type="button" onClick={onCloseAll} aria-label="Close" className={cx("flex items-center justify-center rounded-full", phone ? cx("size-10", solid ? "bg-transparent" : "border border-white/10 bg-black/35 backdrop-blur-md") : "glass size-11 hover:bg-black/50")}><X className="size-5" /></button>
          </div>
        </div>

        <div className={cx("relative z-10 px-4 pb-32 sm:px-12 transition-opacity", isFetching && !isLoading && "opacity-90")}>
          <div className={cx("mx-auto flex w-full flex-col gap-8 sm:gap-12 sm:pt-20", glow ? "pt-[calc(55vh-10.5rem)]" : "pt-[calc(55vh-11rem)]")}>
            <div className="relative z-10 flex w-full flex-col items-start gap-8 lg:flex-row lg:gap-12">
              {!phone && (
                <div className="mx-auto w-48 shrink-0 sm:w-64 md:w-72 lg:mx-0 lg:w-80">
                  <div className="relative flex aspect-[2/3] w-full items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-muted shadow-2xl shadow-black/85">
                    {title?.posterUrl && !posterFailed ? (
                      <>
                        <Skeleton className="absolute inset-0 h-full w-full rounded-xl" />
                        <img src={sizedArt(title.posterUrl, 500) ?? title.posterUrl} alt="" onLoad={() => setPosterLoaded(true)} onError={() => setPosterFailed(true)} className={cx("relative z-10 h-full w-full rounded-xl object-cover transition-[filter,opacity] duration-700 ease-out", posterLoaded ? "opacity-100 blur-0" : "opacity-0 blur-md")} />
                      </>
                    ) : isLoading ? <Skeleton className="absolute inset-0 rounded-xl" /> : <ImageOff className="size-12 text-muted-foreground" />}
                    {(title?.played || allWatched) && <span className="absolute right-2.5 top-2.5 z-20 flex size-8 items-center justify-center rounded-full bg-blue-500 text-white shadow-lg"><Check className="size-5" strokeWidth={3} /></span>}
                  </div>
                </div>
              )}

              <div className={cx("flex w-full flex-1 flex-col gap-5", phone ? "items-center text-center" : "text-left")}>
                {isLoading && !title ? (
                  <div className="space-y-4"><Skeleton className="h-24 w-80 rounded-xl" /><Skeleton className="h-4 w-96" /><Skeleton className="h-12 w-72 rounded-full" /></div>
                ) : isError && !title ? (
                  <div className="space-y-3">
                    <p className="text-lg font-semibold">Could not load this title.</p>
                    <button type="button" onClick={() => void refetch()} className={GLASS_PILL}>Retry</button>
                  </div>
                ) : title ? (
                  <>
                    {title.logoUrl && !logoFailed
                      ? <img src={sizedArt(title.logoUrl, 500) ?? title.logoUrl} alt={title.title} onError={() => setLogoFailed(true)} className={cx("mb-2 h-16 max-w-[85%] object-contain sm:h-24 md:h-28", phone ? "object-center" : "object-left")} />
                      : <h1 className="mb-2 text-3xl font-bold tracking-tight sm:text-5xl md:text-6xl">{title.title}</h1>}
                    <FactsBlock title={title} seasonCount={seasonCount} phone={phone} />
                    {!phone && <MoodLine title={title} phone={false} />}

                    {(isSeries && title.aired > 0) || (!isSeries && stateLine) ? (
                      <div className={cx("flex w-full flex-col gap-2", phone ? "max-w-xs items-center" : "max-w-xl")}>
                        {isSeries ? (
                          <div className="flex w-full items-center gap-3">
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/15"><div className={cx("h-full rounded-full transition-all duration-500", allWatched ? "bg-emerald-400" : "bg-blue-500")} style={{ width: `${Math.max(1, progress)}%` }} /></div>
                            <span className="text-xs tabular-nums text-muted-foreground">{allWatched ? `${title.status === "Ended" ? "Finished" : "Caught up"} · ` : ""}{title.watched}/{title.aired}</span>
                          </div>
                        ) : title.played && title.watches[0] ? (
                          <p className={cx("font-semibold text-blue-200", phone ? "text-[13px]" : "text-sm")}>
                            <button type="button" onClick={(event) => openDate(title.id, title.watches[0], anchorOf(event.currentTarget))} className="group/date -mx-1 inline-flex items-center gap-1.5 rounded-md px-1 underline decoration-blue-300/30 decoration-dotted underline-offset-4 transition-colors hover:bg-white/10 hover:decoration-blue-200">
                              {`Watched ${watchedWhen(title.watches[0])}`}
                              <PencilLine className="size-3.5 opacity-60 transition-opacity group-hover/date:opacity-100" />
                            </button>
                            {stateLine?.replace(`Watched ${watchedWhen(title.watches[0])}`, "")}
                          </p>
                        ) : <p className={cx("font-semibold text-blue-200", phone ? "text-[13px]" : "text-sm")}>{stateLine}</p>}
                      </div>
                    ) : null}

                    {phone ? (
                      <PhoneTitleActions name={title.title} actions={titleActions} play={<button type="button" className={PHONE_PLAY_PILL} onClick={(event) => playOn(event.currentTarget)}><Play />{playText}</button>} />
                    ) : (
                      <DesktopTitleActions actions={titleActions} play={<button type="button" className={PLAY_PILL} onClick={(event) => playOn(event.currentTarget)}><Play className="fill-current" />{playText}</button>} />
                    )}
                    <p className="text-xs text-muted-foreground">
                      {sentTo.length ? `Changes are saved here and sent to ${sentTo.map(trackers.name).join(", ")}.` : "Changes are saved on this server."}
                    </p>

                    {title.overview && <Overview text={title.overview} phone={phone} />}
                    {phone && <MoodLine title={title} phone />}
                    <Credits title={title} onPerson={onPerson} />
                    <Details title={title} />
                  </>
                ) : null}
              </div>
            </div>

            {title && isSeries && seasons.length > 0 && (
              <section className="flex flex-col gap-4">
                <div className="flex min-w-0 flex-col gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className={SECTION_TITLE}>Episodes</h3>
                    <div className="flex flex-wrap items-center gap-2">
                      {!selecting && ready.length > 0 && (
                        <button type="button" disabled={busy !== null} onClick={() => void run(seasonDone ? "unplayed" : "played", seasonId ? [seasonId] : ready.map((ep) => ep.id), `${seasonLabel(shownSeason)} marked ${seasonDone ? "unwatched" : "watched"}`, !seasonDone, null, ready.map((ep) => ep.id))} className="glass inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-medium hover:bg-white/15 disabled:opacity-60">
                          {seasonDone ? <Undo2 className="size-4" /> : <CheckCheck className="size-4" />} {seasonDone ? "Season unwatched" : "Season watched"}
                        </button>
                      )}
                      <button type="button" onClick={() => (selecting ? endSelect() : setSelecting(true))} className={cx("glass inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-medium hover:bg-white/15", selecting && "!bg-white/20")}>
                        <CheckSquare className="size-4" /> {selecting ? "Done" : "Select"}
                      </button>
                      {!phone && (
                        <div className="glass flex h-10 items-center rounded-full p-1">
                          <button type="button" aria-label="As a row" onClick={() => setLayout("row")} className={cx("flex h-full items-center rounded-full px-3", layout === "row" ? "bg-white/15" : "text-muted-foreground hover:text-foreground")}><Rows3 className="size-4" /></button>
                          <button type="button" aria-label="As a grid" onClick={() => setLayout("grid")} className={cx("flex h-full items-center rounded-full px-3", layout === "grid" ? "bg-white/15" : "text-muted-foreground hover:text-foreground")}><LayoutGrid className="size-4" /></button>
                        </div>
                      )}
                    </div>
                  </div>
                  {title.seasons.length > 1 && (phone
                    ? <SeasonPills seasons={title.seasons} watched={watchedSeasons} selected={shownSeason} onSelect={setSeason} onMenu={(item, at) => setSeasonMenu({ season: item, at })} />
                    : <SeasonRail seasons={title.seasons} watched={watchedSeasons} selected={shownSeason} onSelect={setSeason} onMenu={(item, at) => setSeasonMenu({ season: item, at })} />)}
                  {seasonMenu && (() => {
                    const target = seasonMenu.season;
                    const aired = (seasons.find(([s]) => s === target.season)?.[1] ?? []).filter((ep) => !(ep.airsAt && ep.airsAt > now));
                    const ids = aired.map((ep) => ep.id);
                    const last = aired[aired.length - 1];
                    const label = seasonLabel(target.season);
                    if (aired.length === 0) return null;
                    return (
                      <ActionMenu at={seasonMenu.at} onClose={closeSeasonMenu} items={[
                        { icon: <Check className="size-4" />, label: `Mark ${label} watched`, onSelect: () => void run("played", [target.id], `${label} marked watched`, true, null, ids) },
                        { icon: <Undo2 className="size-4" />, label: `Mark ${label} unwatched`, onSelect: () => void run("unplayed", [target.id], `${label} marked unwatched`, false, null, ids) },
                        ...(target.season !== 0 && last ? [{ icon: <CheckCheck className="size-4" />, label: `Watched up to the end of ${label}`, onSelect: () => void run("playedUpTo", [last.id], `Watched up to the end of ${label}`) }] : []),
                      ]} />
                    );
                  })()}
                </div>
                {phone
                  ? <div key={shownSeason ?? ""} className="flex flex-col gap-1">{episodes.map((ep) => <EpisodeListRow key={ep.id} {...episodeProps(ep)} />)}</div>
                  : layout === "row"
                    ? <EpisodeRow key={shownSeason ?? ""} focus={next?.season === shownSeason ? next.id : null}>{episodes.map((ep) => card(ep, "w-64 shrink-0 snap-start lg:w-72 2xl:w-80"))}</EpisodeRow>
                    : <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">{episodes.map((ep) => card(ep))}</div>}
              </section>
            )}

            {title && title.people.length > 0 && <CastRow people={title.people} onPerson={onPerson} />}
            {dateSheet && <WatchDateSheet target={dateSheet.target} anchor={dateSheet.anchor} sentTo={sentTo} onClose={closeDateSheet} onSave={async (to) => { const saved = await redate(dateSheet.target.itemId, dateSheet.target.from, to); if (saved) setDateSheet(null); return saved; }} />}
            {remote && <RemoteSheet userUUID={userUUID} profile={profile} profileName={profileName} target={remote.target} at={remote.at} activeTab={activeTab} onClose={closeRemote} />}

            {title && (
              <section className="flex flex-col gap-4">
                <h3 className={SECTION_TITLE}>History</h3>
                <History title={title} glide={glide} onGlided={glided} onDate={(entry, anchor) => openDate(entry.itemId, entry.dated ?? null, anchor)} />
              </section>
            )}
          </div>
        </div>
      </div>

      {selecting && (
        <div className="fixed inset-x-0 bottom-6 z-[110] flex justify-center px-4">
          <div className="glass flex items-center gap-2 rounded-full p-1.5 pl-5 shadow-2xl animate-fade-in">
            <span className="mr-2 text-sm tabular-nums">{selected.size} selected</span>
            <button type="button" disabled={!selected.size || busy !== null} onClick={() => void bulk("played")} className="inline-flex h-10 items-center gap-1.5 rounded-full bg-white px-5 text-sm font-semibold text-black disabled:opacity-50"><Check className="size-4" /> Watched</button>
            <button type="button" disabled={!selected.size || busy !== null} onClick={() => void bulk("unplayed")} className="inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-medium hover:bg-white/10 disabled:opacity-50"><Undo2 className="size-4" /> Unwatched</button>
            <button type="button" onClick={endSelect} aria-label="Cancel" className="flex size-10 items-center justify-center rounded-full hover:bg-white/10"><X className="size-4" /></button>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}

export default function JellyfinTitlePage({ userUUID, profile, profileName, sentTo, stack, activeTab, onOpen }: {
  userUUID: string;
  profile: string | null;
  profileName: string;
  sentTo: string[];
  stack: DashboardPage[];
  activeTab: DashboardTab;
  onOpen: (stack: DashboardPage[]) => void;
}) {
  const depth = useRef(stack.length);
  depth.current = stack.length;

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") window.history.back(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const back = useCallback(() => window.history.back(), []);
  const closeAll = useCallback(() => window.history.go(-depth.current), []);
  const openPerson = useCallback((person: JellyfinTitlePerson) => onOpen([...stack, { kind: "person", person }]), [onOpen, stack]);
  const openTitle = useCallback((ref: JellyfinTitleRef) => onOpen([...stack, { kind: "title", ref }]), [onOpen, stack]);

  return (
    <>
      {stack.map((entry, index) => entry.kind === "title" ? (
        <TitleView key={index} userUUID={userUUID} profile={profile} profileName={profileName} sentTo={sentTo} titleRef={entry.ref} initialSeason={entry.season} activeTab={activeTab} shown={index === stack.length - 1} onBack={back} onCloseAll={closeAll} onPerson={openPerson} />
      ) : (
        <JellyfinPersonView key={index} userUUID={userUUID} profile={profile} profileName={profileName} person={entry.person} activeTab={activeTab} shown={index === stack.length - 1} onBack={back} onCloseAll={closeAll} onOpenTitle={openTitle} />
      ))}
    </>
  );
}
