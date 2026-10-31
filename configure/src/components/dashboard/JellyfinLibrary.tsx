import { memo, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Bookmark, Film, LayoutGrid, Layers, Loader2, Star, ThumbsDown, Tv, Undo2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { sizedArt } from "./art";
import { reloadPages, useOpenTitle } from "./jellyfinUtils";
import { Ambient } from "./JellyfinShared";
import { JELLYFIN_LIBRARY_PAGE, useJellyfinLibrary, useJellyfinUndrop, type DashboardTab, type JellyfinLibraryKind, type JellyfinLibraryRow, type JellyfinLibraryTab } from "@/hooks/useDashboardQueries";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

const TABS: Array<{ key: JellyfinLibraryTab; label: string; icon: typeof Bookmark }> = [
  { key: "watchlist", label: "Watchlist", icon: Bookmark },
  { key: "ratings", label: "Ratings", icon: Star },
  { key: "dropped", label: "Dropped", icon: ThumbsDown },
];

const SOURCE_LABELS: Record<string, string> = { mdblist: "MDBList", simkl: "Simkl", anilist: "AniList", mal: "MyAnimeList", publicmetadb: "PublicMetaDB", server: "this server" };

type View = "deck" | "wall";

function ago(value: number | null): string {
  if (!value) return "";
  const diff = Date.now() - value;
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function remembered<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const held = localStorage.getItem(key) as T | null;
    return held && allowed.includes(held) ? held : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function Poster({ row, className, label = true, width = 342 }: { row: JellyfinLibraryRow; className?: string; label?: boolean; width?: number }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (!row.posterUrl || failed) {
    return (
      <div className={cx("flex items-end bg-gradient-to-br from-zinc-700 to-zinc-900 p-3", className)}>
        {label && <span className="line-clamp-3 text-sm font-semibold leading-tight text-white/90">{row.title}</span>}
      </div>
    );
  }
  return (
    <img
      src={sizedArt(row.posterUrl, width) ?? row.posterUrl}
      alt=""
      loading="lazy"
      draggable={false}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
      className={cx("object-cover", loaded ? "image-in" : "opacity-0", className)}
    />
  );
}


function Stars({ value }: { value: number }) {
  const out = Math.max(0, Math.min(10, value));
  return (
    <span className="inline-flex items-center gap-0.5" title={`${out}/10`}>
      {Array.from({ length: 5 }, (_, i) => {
        const fill = Math.max(0, Math.min(1, out / 2 - i));
        return (
          <span key={i} className="relative inline-block size-3.5">
            <Star className="absolute inset-0 size-3.5 text-white/20" strokeWidth={0} fill="currentColor" />
            <span className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
              <Star className="size-3.5 text-amber-400" strokeWidth={0} fill="currentColor" />
            </span>
          </span>
        );
      })}
    </span>
  );
}

const metaLine = (row: JellyfinLibraryRow) => [row.type === "movie" ? "Movie" : "Show", row.year, row.score ? `★ ${row.score}` : null].filter(Boolean).join(" · ");

function ListRow({ row, number, active, onPick, onOpen }: { row: JellyfinLibraryRow; number: number; active: boolean; onPick: () => void; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!active || !el || !box) return;
    const row = el.getBoundingClientRect();
    const view = box.getBoundingClientRect();
    if (row.top < view.top) box.scrollBy({ top: row.top - view.top - 4, behavior: "smooth" });
    else if (row.bottom > view.bottom) box.scrollBy({ top: row.bottom - view.bottom + 4, behavior: "smooth" });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      onMouseEnter={onPick}
      onFocus={onPick}
      className={cx(
        "group relative isolate flex w-full shrink-0 items-center gap-3 overflow-hidden rounded-xl py-2 pl-2 pr-3 text-left transition-all duration-300",
        active ? "ring-1 ring-blue-400/50 shadow-[0_10px_40px_-12px_rgba(59,130,246,0.55)]" : "hover:bg-white/[0.05]"
      )}
    >
      {active && row.posterUrl && (
        <span aria-hidden className="absolute inset-0 -z-10">
          <img src={sizedArt(row.posterUrl, 185) ?? row.posterUrl} alt="" className="size-full scale-150 object-cover opacity-40 blur-xl saturate-150" />
          <span className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/40 to-black/10" />
        </span>
      )}
      <span className={cx("w-7 shrink-0 text-right font-mono text-sm tabular-nums transition-colors", active ? "text-blue-300" : "text-muted-foreground/50")}>{String(number).padStart(2, "0")}</span>
      <Poster row={row} label={false} width={185} className={cx("aspect-[2/3] w-9 shrink-0 rounded-md transition-transform duration-300", active && "scale-110 shadow-lg")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold leading-tight">{row.title}</span>
        <span className={cx("block truncate text-[11px]", active ? "text-white/70" : "text-muted-foreground")}>{metaLine(row)}</span>
      </span>
      {row.rating !== null && <span className="shrink-0 rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-amber-300">{row.rating}/10</span>}
    </button>
  );
}

function Fan({ rows }: { rows: JellyfinLibraryRow[] }) {
  const shown = rows.slice(0, 4);
  return (
    <span className="relative block h-16 w-24 shrink-0" style={{ perspective: "500px" }}>
      {shown.length === 0 && <span className="absolute inset-y-0 left-6 w-11 rounded-md bg-white/5 ring-1 ring-white/10" />}
      {shown.map((row, i) => (
        <span
          key={row.metaId}
          className="absolute top-0 w-11 overflow-hidden rounded-md shadow-lg ring-1 ring-white/15 transition-transform duration-500"
          style={{ left: i * 14, zIndex: 10 - i, transform: `rotateY(${-22 - i * 6}deg) translateZ(${-i * 12}px)`, filter: `brightness(${1 - i * 0.15})` }}
        >
          <Poster row={row} label={false} width={185} className="aspect-[2/3] w-full" />
        </span>
      ))}
    </span>
  );
}

function useSwipe(index: number, count: number, onPick: (i: number) => void) {
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const current = useRef(index);
  current.current = index;
  return {
    onPointerDown: (event: React.PointerEvent) => { drag.current = { x: event.clientX, moved: false }; },
    onPointerMove: (event: React.PointerEvent) => {
      const held = drag.current;
      if (!held) return;
      const dx = event.clientX - held.x;
      if (Math.abs(dx) < 48) return;
      held.x = event.clientX;
      held.moved = true;
      current.current = Math.max(0, Math.min(count - 1, current.current - Math.sign(dx)));
      onPick(current.current);
    },
    onPointerUp: () => { setTimeout(() => { drag.current = null; }, 0); },
    onPointerCancel: () => { drag.current = null; },
    onPointerLeave: () => { if (drag.current && !drag.current.moved) drag.current = null; },
    onClickCapture: (event: React.MouseEvent) => { if (drag.current?.moved) { event.preventDefault(); event.stopPropagation(); } },
  };
}

function Deck({ rows, index, onPick, onOpen }: { rows: JellyfinLibraryRow[]; index: number; onPick: (i: number) => void; onOpen: (row: JellyfinLibraryRow) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const wheel = useRef(0);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const now = Date.now();
      if (now - wheel.current < 140) return;
      wheel.current = now;
      const step = Math.sign(event.deltaX);
      onPick(Math.max(0, Math.min(rows.length - 1, index + step)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [index, rows.length, onPick]);

  const reach = width < 520 ? 3 : 5;
  const card = width < 520 ? 160 : 230;
  const first = Math.max(card * 0.62, Math.min(width * 0.2, card * 0.95));
  const step = Math.max(36, Math.min(90, (width / 2 - first - card * 0.35) / Math.max(1, reach - 2)));
  return (
    <div ref={stage} className="relative h-[330px] select-none sm:h-[470px]" style={{ perspective: "1400px" }}>
      {rows.map((row, i) => {
        const d = i - index;
        if (Math.abs(d) > reach) return null;
        const side = Math.sign(d);
        const depth = Math.abs(d);
        const transform = d === 0
          ? "translate(-50%, -50%) translateZ(90px) rotateY(0deg)"
          : `translate(-50%, -50%) translateX(${side * (first + (depth - 1) * step)}px) translateZ(${-140 - depth * 70}px) rotateY(${-side * 58}deg)`;
        return (
          <button
            key={row.metaId}
            type="button"
            onClick={() => (d === 0 ? onOpen(row) : onPick(i))}
            title={d === 0 ? `Open ${row.title}` : row.title}
            aria-label={row.title}
            className="absolute left-1/2 top-1/2 transition-[transform,opacity,filter] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{ width: card, transform, zIndex: 20 - depth, opacity: depth === reach ? 0 : 1 - depth * 0.12, filter: d === 0 ? "none" : `brightness(${1 - depth * 0.16})`, transformStyle: "preserve-3d" }}
          >
            <div className={cx("relative overflow-hidden rounded-xl ring-1 ring-white/10", d === 0 && "shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)] ring-white/25")}>
              <Poster row={row} width={500} className="aspect-[2/3] w-full" />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-transparent via-transparent to-white/15" />
            </div>
            <div
              aria-hidden
              className="pointer-events-none mt-1 h-16 overflow-hidden rounded-xl opacity-30"
              style={{ transform: "scaleY(-1)", maskImage: "linear-gradient(to top, black, transparent 80%)", WebkitMaskImage: "linear-gradient(to top, black, transparent 80%)" }}
            >
              <Poster row={row} width={500} className="aspect-[2/3] w-full object-bottom" />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function TiltCard({ row, onPick, active, action }: { row: JellyfinLibraryRow; onPick: () => void; active: boolean; action?: React.ReactNode }) {
  const [tilt, setTilt] = useState({ x: 0, y: 0, glare: 50 });
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(event) => { if (event.key === "Enter") onPick(); }}
      onMouseMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const px = (event.clientX - box.left) / box.width;
        const py = (event.clientY - box.top) / box.height;
        setTilt({ x: (0.5 - py) * 14, y: (px - 0.5) * 18, glare: px * 100 });
      }}
      onMouseLeave={() => setTilt({ x: 0, y: 0, glare: 50 })}
      className="group relative cursor-pointer text-left outline-none [perspective:900px]"
    >
      <div
        className={cx("relative overflow-hidden rounded-xl ring-1 transition-transform duration-200 ease-out", active ? "ring-2 ring-blue-400" : "ring-white/10")}
        style={{ transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg) scale(${tilt.x || tilt.y ? 1.04 : 1})` }}
      >
        <Poster row={row} className="aspect-[2/3] w-full" />
        <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100" style={{ background: `radial-gradient(circle at ${tilt.glare}% 0%, rgba(255,255,255,0.28), transparent 55%)` }} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2.5 pt-10 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <p className="truncate text-xs font-semibold text-white">{row.title}</p>
          <p className="truncate text-[10px] text-white/70">{metaLine(row)}</p>
        </div>
        {row.rating !== null && <span className="glass absolute right-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-300">{row.rating}</span>}
      </div>
      {action && <div className="absolute inset-x-1.5 top-1.5 z-10 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">{action}</div>}
    </div>
  );
}

function Detail({ row, tab, action }: { row: JellyfinLibraryRow; tab: JellyfinLibraryTab; action?: React.ReactNode }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const open = useOpenTitle();
  useEffect(() => setLogoFailed(false), [row.metaId]);
  return (
    <div key={row.metaId} className="glass animate-fade-in rounded-2xl p-4 sm:p-5">
      {row.logoUrl && !logoFailed
        ? <img src={sizedArt(row.logoUrl, 500) ?? row.logoUrl} alt={row.title} onError={() => setLogoFailed(true)} className="mb-2 max-h-14 max-w-[70%] object-contain object-left drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]" />
        : <h3 className="mb-1 text-2xl font-bold leading-tight tracking-tight">{row.title}</h3>}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">{row.type === "movie" ? <Film className="size-3.5" /> : <Tv className="size-3.5" />}{row.type === "movie" ? "Movie" : "Show"}</span>
        {row.year && <span>· {row.year}</span>}
        {row.score && <span>· IMDb {row.score}</span>}
        {row.genres.length > 0 && <span>· {row.genres.join(", ")}</span>}
      </div>
      {row.overview && <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-foreground/85">{row.overview}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {row.rating !== null && <span className="inline-flex items-center gap-2"><Stars value={row.rating} /><span className="tabular-nums text-foreground">{row.rating}/10</span></span>}
        {row.at && <span>{tab === "watchlist" ? "Added" : tab === "ratings" ? "Rated" : "Dropped"} {ago(row.at)}</span>}
        <span className="ml-auto flex items-center gap-2">
          {open && <button type="button" onClick={() => open({ id: row.metaId, type: row.type })} className="glass inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium hover:bg-white/15">Open <ArrowRight className="size-3.5" /></button>}
          {action}
        </span>
      </div>
    </div>
  );
}

export default function JellyfinLibrary({ userUUID, profile, profileName, activeTab }: { userUUID: string; profile: string | null; profileName: string; activeTab: DashboardTab }) {
  const [tab, setTab] = useState<JellyfinLibraryTab>(() => remembered("jellyfin.library.tab", "watchlist", ["watchlist", "ratings", "dropped"] as const));
  const [view, setView] = useState<View>(() => remembered("jellyfin.library.view", "deck", ["deck", "wall"] as const));
  const [kind, setKind] = useState<JellyfinLibraryKind>("all");
  const [index, setIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<JellyfinLibraryRow[]>([]);
  const { data, isLoading, isFetching, isPlaceholderData, isError, refetch } = useJellyfinLibrary(userUUID, profile, tab, kind, offset, { activeTab });
  const current = Boolean(data) && !isPlaceholderData && data!.tab === tab && data!.kind === kind;
  const queryClient = useQueryClient();
  const undrop = useJellyfinUndrop();
  const [picking, setPicking] = useState<string | null>(null);
  const listSentinel = useRef<HTMLDivElement>(null);
  const wallSentinel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const loaded = useRef<number[]>([]);
  // A re-read still out when the tab or filter changes is of the list that was there before.
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setOffset(0);
    setRows([]);
    setIndex(0);
    loaded.current = [];
  }, [tab, kind]);
  useEffect(() => {
    if (!current || !data) return;
    if (data.offset === 0 || !loaded.current.includes(data.offset)) {
      loaded.current = data.offset === 0 ? [0] : [...loaded.current, data.offset];
      setRows((held) => (data.offset === 0 ? data.rows : [...held.slice(0, data.offset), ...data.rows]));
      return;
    }
    const offsets = [...loaded.current];
    const started = generation.current;
    void reloadPages<JellyfinLibraryRow>(queryClient, ["dashboard", "jellyfin", "library", userUUID, profile, tab, kind], offsets).then((pages) => {
      if (pages && started === generation.current) setRows(pages.flat());
    });
  }, [current, data]);

  const total = current ? data!.total : rows.length;
  const more = rows.length < total;
  const loadingMore = isFetching && offset > 0;
  const failed = isError && !isFetching;
  const firstPage = rows.length === 0 && !failed && (isLoading || isFetching || !current);
  const firstFailed = rows.length === 0 && failed;
  const loadMore = () => {
    if (more && !isFetching && rows.length > offset) setOffset(rows.length);
  };
  const keepLoading = useRef(loadMore);
  keepLoading.current = loadMore;

  useEffect(() => {
    const targets: Array<[HTMLDivElement | null, Element | null]> = [[listSentinel.current, list.current], [wallSentinel.current, null]];
    const observers = targets.filter(([el]) => el).map(([el, root]) => {
      const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && keepLoading.current(), { root, rootMargin: "400px" });
      observer.observe(el!);
      return observer;
    });
    return () => observers.forEach((o) => o.disconnect());
  }, [view, rows.length, more]);

  const at = Math.min(index, Math.max(0, rows.length - 1));
  const focus = rows[at];
  const meta = TABS.find((t) => t.key === tab)!;
  const sources = (data?.sources ?? []).map((s) => SOURCE_LABELS[s] ?? s);
  const kinds = data?.kinds ?? { movie: 0, series: 0 };
  const count = data?.counts[tab] ?? 0;

  const pickUp = async (row: JellyfinLibraryRow) => {
    setPicking(row.metaId);
    try {
      const done = await undrop(userUUID, profile, row.metaId);
      if (!done) throw new Error(`${row.title} was not dropped here`);
      setRows((held) => held.filter((r) => r.metaId !== row.metaId));
      toast.success(`${row.title} picked back up`, { description: "It can come back to Next Up and the calendar." });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", "jellyfin", "library", userUUID] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", "jellyfin", "calendar", userUUID] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", "jellyfin", "shows", userUUID] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not pick it back up");
    } finally {
      setPicking(null);
    }
  };
  const pickUpButton = (row: JellyfinLibraryRow, compact = false) => (
    <button
      type="button"
      disabled={picking === row.metaId}
      onClick={(event) => { event.stopPropagation(); void pickUp(row); }}
      className={cx("glass inline-flex items-center justify-center gap-1.5 rounded-full font-medium text-foreground transition-colors hover:bg-white/15 disabled:opacity-60", compact ? "h-7 w-full px-2 text-[11px]" : "h-8 px-3 text-xs")}
    >
      {picking === row.metaId ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />} Pick back up
    </button>
  );

  const pick = (i: number) => {
    setIndex(i);
    if (i >= rows.length - 6) loadMore();
  };
  const swipe = useSwipe(at, rows.length, pick);
  const openTitle = useOpenTitle();
  const openRow = (row: JellyfinLibraryRow) => openTitle?.({ id: row.metaId, type: row.type });
  const pickTab = (next: JellyfinLibraryTab) => {
    setTab(next);
    remember("jellyfin.library.tab", next);
  };
  const pickView = (next: View) => {
    setView(next);
    remember("jellyfin.library.view", next);
  };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); pick(Math.min(rows.length - 1, at + 1)); }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); pick(Math.max(0, at - 1)); }
  };

  const Icon = meta.icon;
  const failedPanel = (
    <div className="flex h-[330px] flex-col items-center justify-center gap-3 text-center sm:h-[470px]">
      <p className="text-sm text-muted-foreground">Could not load this list.</p>
      <button type="button" onClick={() => void refetch()} className="glass h-8 rounded-full px-4 text-xs font-medium hover:bg-white/15">Retry</button>
    </div>
  );
  const more_ = (
    <div className="flex h-10 items-center justify-center text-xs text-muted-foreground">
      {loadingMore ? <span className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading more…</span> : failed ? <button type="button" onClick={() => void refetch()} className="text-red-400 hover:text-red-300">Could not load more. Retry</button> : more ? <button type="button" onClick={loadMore} className="hover:text-foreground">Load more</button> : rows.length > JELLYFIN_LIBRARY_PAGE ? `All ${total} shown` : null}
    </div>
  );
  return (
    <section className="relative isolate overflow-hidden">
      <Ambient src={view === "deck" ? focus?.backdropUrl ?? focus?.posterUrl ?? null : null} />
      <div className="relative px-4 py-6 sm:px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <Fan rows={rows} />
            <div className="min-w-0">
              <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{profileName}'s library</span>
              <h2 className="text-3xl font-bold tracking-tight">{meta.label}</h2>
              <p className="truncate text-xs text-muted-foreground">
                {data ? `${count.toLocaleString()} ${count === 1 ? "title" : "titles"}` : "…"}
                {tab === "watchlist" && sources.length > 0 && ` · from ${sources.join(", ")}`}
                {tab === "watchlist" && data && !data.complete && " · partly read"}
              </p>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="glass flex h-9 w-full items-center rounded-full p-0.5 sm:w-auto">
              {TABS.map((t) => (
                <button key={t.key} type="button" onClick={() => pickTab(t.key)} className={cx("flex h-full flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium transition-colors sm:flex-none sm:px-3 sm:text-sm", tab === t.key ? "bg-white/15 text-foreground" : "text-muted-foreground hover:text-foreground")}>
                  <t.icon className="hidden size-3.5 sm:block" /> {t.label}
                  {data && <span className="text-xs tabular-nums opacity-60">{data.counts[t.key]}</span>}
                </button>
              ))}
            </div>
            <div className="glass flex h-9 items-center rounded-full p-0.5">
              {([["deck", Layers, "Deck"], ["wall", LayoutGrid, "Wall"]] as const).map(([key, ViewIcon, label]) => (
                <button key={key} type="button" onClick={() => pickView(key)} aria-label={label} className={cx("flex h-full items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors", view === key ? "bg-white/15 text-foreground" : "text-muted-foreground hover:text-foreground")}>
                  <ViewIcon className="size-3.5" /> <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mb-4 flex items-center gap-4 text-xs">
          {([["all", "Everything", kinds.movie + kinds.series], ["movie", "Movies", kinds.movie], ["series", "Shows", kinds.series]] as const).map(([key, label, n]) => (
            <button key={key} type="button" onClick={() => setKind(key)} className={cx("relative pb-1 font-medium transition-colors", kind === key ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {label} <span className="tabular-nums opacity-60">{n}</span>
              <span className={cx("absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-blue-400 transition-transform duration-300", kind === key ? "scale-x-100" : "scale-x-0")} />
            </button>
          ))}
        </div>

        <div className={cx("grid gap-5", view === "deck" && "lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]")}>
          {view === "deck" && (
            <div ref={list} tabIndex={0} onKeyDown={onKey} className="-mx-1 flex max-h-[480px] min-w-0 flex-col gap-1 overflow-y-auto px-1 py-1 outline-none [scrollbar-width:thin]">
              {firstPage
                ? Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-[60px] shrink-0 rounded-xl" />)
                : rows.length === 0
                  ? <p className="py-10 text-center text-sm text-muted-foreground">{firstFailed ? "" : "Nothing here yet."}</p>
                  : rows.map((row, i) => <ListRow key={row.metaId} row={row} number={i + 1} active={i === at} onPick={() => pick(i)} onOpen={() => { pick(i); openRow(row); }} />)}
              <div ref={listSentinel} />
              {rows.length > 0 && more_}
            </div>
          )}

          {view === "deck" ? (
            <div {...swipe} className="order-first flex min-w-0 cursor-grab touch-pan-y select-none flex-col gap-4 active:cursor-grabbing lg:order-none">
              {firstPage ? (
                <div className="flex h-[330px] items-center justify-center sm:h-[470px]"><Skeleton className="aspect-[2/3] w-40 rounded-xl sm:w-56" /></div>
              ) : focus ? (
                <>
                  <Deck rows={rows} index={at} onPick={pick} onOpen={openRow} />
                  <Detail row={focus} tab={tab} action={tab === "dropped" ? pickUpButton(focus) : undefined} />
                </>
              ) : firstFailed ? (
                failedPanel
              ) : (
                <div className="flex h-[330px] flex-col items-center justify-center gap-2 text-center sm:h-[470px]">
                  <Icon className="size-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">{tab === "watchlist" ? "The watchlist is empty." : tab === "ratings" ? "Nothing rated yet." : "Nothing dropped."}</p>
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8">
                {firstPage
                  ? Array.from({ length: 16 }, (_, i) => <Skeleton key={i} className="aspect-[2/3] rounded-xl" />)
                  : rows.map((row, i) => <TiltCard key={row.metaId} row={row} active={false} action={tab === "dropped" ? pickUpButton(row, true) : undefined} onPick={() => { setIndex(i); openRow(row); }} />)}
              </div>
              {firstFailed && failedPanel}
              <div ref={wallSentinel} />
              {rows.length > 0 && more_}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
