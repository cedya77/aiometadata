import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bookmark, Loader2, Star, ThumbsDown, Undo2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { reloadPages, useOpenTitle } from "./jellyfinUtils";
import { Ambient } from "./JellyfinShared";
import { Deck, DeckDetail, Fan, ListRow, TiltCard, ViewToggle, type DeckDetailInfo, type DeckItem, type ShelfView } from "./JellyfinDeck";
import { remember, remembered, useSwipe } from "./deckState";
import { cx } from "./titleHelpers";
import { JELLYFIN_LIBRARY_PAGE, useJellyfinLibrary, useJellyfinUndrop, type DashboardTab, type JellyfinLibraryKind, type JellyfinLibraryRow, type JellyfinLibraryTab } from "@/hooks/useDashboardQueries";

const TABS: Array<{ key: JellyfinLibraryTab; label: string; icon: typeof Bookmark }> = [
  { key: "watchlist", label: "Watchlist", icon: Bookmark },
  { key: "ratings", label: "Ratings", icon: Star },
  { key: "dropped", label: "Dropped", icon: ThumbsDown },
];

const SOURCE_LABELS: Record<string, string> = { mdblist: "MDBList", simkl: "Simkl", anilist: "AniList", mal: "MyAnimeList", publicmetadb: "PublicMetaDB", server: "this server" };

function ago(value: number | null): string {
  if (!value) return "";
  const diff = Date.now() - value;
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const metaLine = (row: JellyfinLibraryRow) => [row.type === "movie" ? "Movie" : "Show", row.year, row.score ? `★ ${row.score}` : null].filter(Boolean).join(" · ");

const itemOf = (row: JellyfinLibraryRow): DeckItem => ({ key: row.metaId, title: row.title, posterUrl: row.posterUrl, meta: metaLine(row), rating: row.rating });

function Detail({ row, tab, action }: { row: JellyfinLibraryRow; tab: JellyfinLibraryTab; action?: React.ReactNode }) {
  const open = useOpenTitle();
  const info: DeckDetailInfo = {
    key: row.metaId,
    title: row.title,
    logoUrl: row.logoUrl,
    kind: row.type,
    kindLabel: row.type === "movie" ? "Movie" : "Show",
    year: row.year,
    score: row.score,
    scoreLabel: "IMDb",
    genres: row.genres,
    overview: row.overview,
    rating: row.rating,
    note: row.at ? `${tab === "watchlist" ? "Added" : tab === "ratings" ? "Rated" : "Dropped"} ${ago(row.at)}` : null,
  };
  return <DeckDetail info={info} onOpen={open ? () => open({ id: row.metaId, type: row.type }) : undefined} action={action} />;
}

export default function JellyfinLibrary({ userUUID, profile, profileName, activeTab }: { userUUID: string; profile: string | null; profileName: string; activeTab: DashboardTab }) {
  const [tab, setTab] = useState<JellyfinLibraryTab>(() => remembered("jellyfin.library.tab", "watchlist", ["watchlist", "ratings", "dropped"] as const));
  const [view, setView] = useState<ShelfView>(() => remembered("jellyfin.library.view", "deck", ["deck", "wall"] as const));
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

  const items = useMemo(() => rows.map(itemOf), [rows]);
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
  const pickView = (next: ShelfView) => {
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
            <Fan items={items} />
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
            <ViewToggle view={view} onView={pickView} />
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
                  : rows.map((row, i) => <ListRow key={row.metaId} item={items[i]} number={i + 1} active={i === at} onPick={() => pick(i)} onOpen={() => { pick(i); openRow(row); }} />)}
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
                  <Deck items={items} index={at} onPick={pick} onOpen={(i) => openRow(rows[i])} />
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
                  : rows.map((row, i) => <TiltCard key={row.metaId} item={items[i]} active={false} action={tab === "dropped" ? pickUpButton(row, true) : undefined} onPick={() => { setIndex(i); openRow(row); }} />)}
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
