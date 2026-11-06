import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Film, GripVertical, Layers, List, ListVideo, Loader2, PencilLine, Plus, Trash2, Tv, X } from "lucide-react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  JELLYFIN_PLAYLIST_PAGE,
  useJellyfinPlaylist,
  useJellyfinPlaylistChange,
  useJellyfinPlaylistPreview,
  useJellyfinPlaylists,
  useJellyfinFind,
  useJellyfinTitle,
  type DashboardTab,
  type JellyfinTitleRef,
  type JellyfinPlaylistEntry,
  type JellyfinPlaylistPreview,
  type JellyfinPlaylistSummary,
} from "@/hooks/useDashboardQueries";
import { Ambient } from "./JellyfinShared";
import { duration, useOpenTitle, when } from "./jellyfinUtils";
import { Deck, DeckDetail, Fan, ListRow, Poster, ViewToggle, type DeckDetailInfo, type DeckItem } from "./JellyfinDeck";
import { remember, remembered, usePagedRows, useSwipe } from "./deckState";
import { cx } from "./titleHelpers";

const failed = (error: unknown, fallback: string) => toast.error(error instanceof Error ? error.message : fallback);

const titlesLabel = (n: number) => `${n.toLocaleString()} ${n === 1 ? "title" : "titles"}`;

const addedNote = (added: number, left: number, playlistName: string) =>
  !added ? `${playlistName} already has these` : left ? `Added ${titlesLabel(added)} to ${playlistName}, which is now full; ${titlesLabel(left)} left out` : `Added ${titlesLabel(added)} to ${playlistName}`;

/** What a choice adds: a film, a whole show, a season, or the episodes picked. */
export interface PlaylistChoice {
  key: string;
  label: string;
  detail?: string;
  itemIds: string[];
}

/** Picks a playlist for some titles, or makes one, showing what each would gain first. */
export function AddToPlaylistPanel({ userUUID, profile, choices, onDone }: { userUUID: string; profile: string | null; choices: PlaylistChoice[]; onDone: () => void }) {
  const [picked, setPicked] = useState(0);
  const [preview, setPreview] = useState<JellyfinPlaylistPreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const readPreview = useJellyfinPlaylistPreview();
  const change = useJellyfinPlaylistChange();
  const choice = choices[Math.min(picked, choices.length - 1)];

  useEffect(() => {
    let live = true;
    setPreview(null);
    setPreviewFailed(false);
    readPreview(userUUID, profile, choice.itemIds)
      .then((read) => { if (live) setPreview(read); })
      .catch(() => { if (live) setPreviewFailed(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userUUID, profile, choice.key, attempt]);

  const add = async (id: string, playlistName: string) => {
    setBusy(id);
    try {
      const { added = 0, left = 0 } = await change(userUUID, profile, { op: "add", id, itemIds: choice.itemIds });
      toast.success(addedNote(added, left, playlistName));
      onDone();
    } catch (error) {
      failed(error, "Could not add to the playlist");
    } finally {
      setBusy(null);
    }
  };
  const create = async () => {
    const wanted = name.trim();
    if (!wanted) return;
    setBusy("new");
    try {
      const { added = 0 } = await change(userUUID, profile, { op: "create", name: wanted, itemIds: choice.itemIds });
      toast.success(`Made ${wanted} with ${titlesLabel(added)}`);
      onDone();
    } catch (error) {
      failed(error, "Could not make the playlist");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 p-2">
      {choices.length > 1 && (
        <div className="space-y-1" role="radiogroup" aria-label="What to add">
          {choices.map((option, i) => (
            <button key={option.key} type="button" role="radio" aria-checked={i === picked} onClick={() => setPicked(i)} className={cx("flex w-full flex-col items-start rounded-xl px-3 py-2 text-left transition", i === picked ? "bg-white/10 ring-1 ring-blue-400/50" : "hover:bg-white/5")}>
              <span className="text-sm">{option.label}</span>
              {option.detail && <span className="text-xs text-muted-foreground">{option.detail}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="max-h-72 space-y-0.5 overflow-y-auto [scrollbar-width:thin]">
        <p className="px-3 text-[11px] uppercase tracking-wide text-muted-foreground">{preview ? `To a playlist · ${titlesLabel(preview.titles)}` : "To a playlist"}</p>
        {previewFailed ? (
          <p className="px-3 py-1 text-xs text-muted-foreground">Could not read the playlists. <button type="button" onClick={() => setAttempt((n) => n + 1)} className="text-blue-300 hover:text-blue-200">Retry</button></p>
        ) : !preview ? (
          <div className="space-y-1 px-1">{[0, 1].map((i) => <Skeleton key={i} className="h-9 w-full rounded-xl" />)}</div>
        ) : preview.playlists.length === 0 ? (
          <p className="px-3 py-1 text-xs text-muted-foreground">No playlists yet. Name one below.</p>
        ) : preview.playlists.map((playlist) => {
          const fresh = preview.titles - playlist.has;
          const note = !playlist.fits ? "Too full" : !playlist.adds ? "Has all of these" : playlist.adds < fresh ? `Room for ${playlist.adds} of ${fresh}` : playlist.has ? `Has ${playlist.has}, adds ${playlist.adds}` : `Adds ${playlist.adds}`;
          return (
            <button key={playlist.id} type="button" disabled={Boolean(busy) || !playlist.adds || !playlist.fits} onClick={() => void add(playlist.id, playlist.name)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition hover:bg-white/10 disabled:opacity-50 disabled:hover:bg-transparent">
              <span className="min-w-0 flex-1 truncate">{playlist.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{busy === playlist.id ? <Loader2 className="size-3.5 animate-spin" /> : note}</span>
            </button>
          );
        })}
      </div>
      <form className="flex items-center gap-2 px-1" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label htmlFor="new-playlist" className="sr-only">New playlist name</label>
        <input id="new-playlist" value={name} onChange={(event) => setName(event.target.value)} maxLength={200} placeholder="New playlist" className="h-9 min-w-0 flex-1 rounded-xl border border-white/10 bg-background/60 px-3 text-sm outline-none focus:border-blue-400/60" />
        <Button type="submit" size="sm" className="h-9 rounded-xl" disabled={!name.trim() || Boolean(busy) || (!preview && !previewFailed)}>
          {busy === "new" ? <Loader2 className="size-4 animate-spin" /> : "Make"}
        </Button>
      </form>
    </div>
  );
}

const stateOf = (entry: JellyfinPlaylistEntry): string | null =>
  entry.played ? "Watched" : entry.positionMs > 0 && entry.runtimeMs > entry.positionMs ? `${duration(entry.runtimeMs - entry.positionMs) || "A minute"} left` : null;

const itemOf = (entry: JellyfinPlaylistEntry): DeckItem => ({
  key: entry.id,
  title: entry.title,
  posterUrl: entry.image,
  meta: [entry.subtitle, stateOf(entry)].filter(Boolean).join(" · ") || (entry.kind === "movie" ? "Movie" : "Episode"),
  rating: null,
});

const PILL = "glass inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium hover:bg-white/15 disabled:opacity-50";

/** The entry in focus on the deck, told as the library tells a title, with its still and its place in the playlist. */
function EntryDetail({ entry, total, busy, onMove, onRemove }: { entry: JellyfinPlaylistEntry; total: number; busy: boolean; onMove: (to: number) => void; onRemove: () => void }) {
  const open = useOpenTitle();
  const pct = entry.played ? 100 : entry.runtimeMs > 0 ? Math.min(100, (entry.positionMs / entry.runtimeMs) * 100) : 0;
  const info: DeckDetailInfo = {
    key: entry.id,
    title: entry.title,
    logoUrl: entry.logoUrl,
    kind: entry.kind,
    kindLabel: entry.kind === "movie" ? "Movie" : "Episode",
    part: entry.kind === "episode" ? entry.subtitle : null,
    year: entry.year,
    score: entry.score,
    scoreLabel: "★",
    genres: entry.genres,
    overview: entry.overview,
    rating: null,
    note: [`${entry.position + 1} of ${total}`, stateOf(entry)].filter(Boolean).join(" · "),
  };
  const aside = entry.wide ? (
    <div className="relative hidden w-48 shrink-0 self-start overflow-hidden rounded-xl ring-1 ring-white/10 sm:block">
      <img src={entry.wide} alt="" className="aspect-video w-full object-cover" />
      {pct > 0 && <span className="absolute inset-x-0 bottom-0 h-1 bg-black/50"><span className={cx("block h-full", entry.played ? "bg-emerald-400" : "bg-blue-400")} style={{ width: `${pct}%` }} /></span>}
    </div>
  ) : undefined;
  const action = (
    <>
      <button type="button" disabled={busy || entry.position === 0} onClick={() => onMove(0)} className={PILL}>Move to start</button>
      <button type="button" disabled={busy || entry.position === 0} onClick={() => onMove(entry.position - 1)} className={PILL} aria-label="Move up"><ChevronUp className="size-3.5" /></button>
      <button type="button" disabled={busy || entry.position === total - 1} onClick={() => onMove(entry.position + 1)} className={PILL} aria-label="Move down"><ChevronDown className="size-3.5" /></button>
      <button type="button" disabled={busy} onClick={onRemove} className={cx(PILL, "text-red-300")}><X className="size-3.5" /> Remove</button>
    </>
  );
  return <DeckDetail info={info} aside={aside} onOpen={open ? () => open({ item: entry.open }) : undefined} action={action} />;
}

type PlaylistView = "deck" | "list";
const PLAYLIST_VIEWS: ReadonlyArray<readonly [PlaylistView, typeof Layers, string]> = [["deck", Layers, "Deck"], ["list", List, "List"]];

/** One entry of the list, dragged by its handle to a new place. */
function SortableEntry({ entry, number, busy, onRemove }: { entry: JellyfinPlaylistEntry; number: number; busy: boolean; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.id, disabled: busy });
  const open = useOpenTitle();
  const state = stateOf(entry);
  const name = entry.kind === "episode" && entry.subtitle ? `${entry.title} ${entry.subtitle}` : entry.title;
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cx("relative flex items-center gap-3 rounded-xl bg-white/[0.03] p-2 ring-1 ring-white/[0.06]", isDragging && "z-10 bg-background shadow-2xl ring-blue-400/50")}>
      <button type="button" {...attributes} {...listeners} aria-label={`Drag ${name} to a new place`} className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:text-foreground active:cursor-grabbing">
        <GripVertical className="size-4" />
      </button>
      <span className="w-7 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{number}</span>
      <button type="button" disabled={!open} onClick={() => open?.({ item: entry.open })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <Poster item={itemOf(entry)} label={false} width={185} className="aspect-[2/3] w-9 shrink-0 rounded-md" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{entry.title}</span>
          {entry.subtitle && <span className="block truncate text-xs text-muted-foreground">{entry.subtitle}</span>}
        </span>
      </button>
      {state && <span className={cx("shrink-0 text-xs", entry.played ? "text-emerald-400" : "text-muted-foreground")}>{state}</span>}
      <Button size="icon" variant="ghost" className="size-8 shrink-0" disabled={busy} onClick={onRemove} aria-label={`Remove ${name}`}><X className="size-4" /></Button>
    </li>
  );
}

/** Finds titles to add: a film as it is, a show whole or one season at a time. */
function AddTitles({ userUUID, profile, playlistId, playlistName }: { userUUID: string; profile: string | null; playlistId: string; playlistName: string }) {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [picked, setPicked] = useState<JellyfinTitleRef | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const change = useJellyfinPlaylistChange();
  useEffect(() => {
    const wait = setTimeout(() => setAsked(query.trim()), 300);
    return () => clearTimeout(wait);
  }, [query]);
  useEffect(() => setPicked(null), [asked]);
  const found = useJellyfinFind(userUUID, profile, asked, null, { activeTab: "jellyfin" });
  const title = useJellyfinTitle(userUUID, profile, picked, { activeTab: "jellyfin" });
  const shown = picked && !title.isPlaceholderData ? title.data : undefined;
  const choices: PlaylistChoice[] = !shown ? [] : shown.type === "movie"
    ? [{ key: "film", label: [shown.title, shown.year].filter(Boolean).join(" · "), itemIds: [shown.id] }]
    : [
      { key: "show", label: `${shown.title}, whole show (${shown.aired} episodes)`, itemIds: [shown.id] },
      ...shown.seasons.filter((season) => season.season > 0).map((season) => ({ key: `season:${season.season}`, label: `Season ${season.season} (${season.count} episodes)`, itemIds: [season.id] })),
    ];
  const add = async (choice: PlaylistChoice) => {
    setBusy(choice.key);
    try {
      const { added = 0, left = 0 } = await change(userUUID, profile, { op: "add", id: playlistId, itemIds: choice.itemIds });
      toast.success(addedNote(added, left, playlistName));
    } catch (error) {
      failed(error, "Could not add to the playlist");
    } finally {
      setBusy(null);
    }
  };
  const CHIP = "inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm transition hover:bg-white/[0.08] disabled:opacity-50";
  const results = found.data?.query === asked ? found.data.results.slice(0, 8) : [];
  return (
    <div className="space-y-2">
      <label htmlFor="add-titles" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Add titles</label>
      <input id="add-titles" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a film or a show" className="h-9 w-full rounded-lg border border-white/10 bg-background/60 px-3 text-sm outline-none focus:border-blue-400/60" />
      {picked ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setPicked(null)} className="inline-flex h-9 items-center rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground">‹ Results</button>
          {!shown && title.isError ? (
            <span className="text-xs text-muted-foreground">Could not load this title. <button type="button" onClick={() => void title.refetch()} className="text-blue-300 hover:text-blue-200">Retry</button></span>
          ) : !shown ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : choices.map((choice) => (
            <button key={choice.key} type="button" disabled={Boolean(busy)} onClick={() => void add(choice)} className={CHIP}>
              {busy === choice.key ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} {choice.label}
            </button>
          ))}
        </div>
      ) : asked.length >= 2 && (
        <div className="flex flex-wrap gap-2">
          {found.isFetching && !results.length ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : found.isError && found.data?.query !== asked ? (
            <span className="text-xs text-muted-foreground">The search failed. <button type="button" onClick={() => void found.refetch()} className="text-blue-300 hover:text-blue-200">Retry</button></span>
          ) : results.length === 0 ? <span className="text-xs text-muted-foreground">Nothing found for “{asked}”.</span> : results.map((result) => (
            <button key={`${result.type}:${result.id}`} type="button" onClick={() => setPicked({ id: result.id, type: result.type })} className={CHIP}>
              {result.type === "movie" ? <Film className="size-3.5" /> : <Tv className="size-3.5" />} {result.title}{result.year ? <span className="text-muted-foreground">{result.year}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A user's playlists, as every Jellyfin app signed in as them shows them: on the library's deck, or as a list to edit. */
export default function JellyfinPlaylists({ userUUID, profile, profileName, activeTab }: { userUUID: string; profile: string | null; profileName: string; activeTab: DashboardTab }) {
  const list = useJellyfinPlaylists(userUUID, profile, { activeTab });
  const change = useJellyfinPlaylistChange();
  const [view, setView] = useState<PlaylistView>(() => remembered("jellyfin.playlists.view", "deck", ["deck", "list"] as const));
  const [selected, setSelected] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [naming, setNaming] = useState<{ mode: "new" | "rename"; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const playlists: JellyfinPlaylistSummary[] = list.data?.playlists ?? [];
  const current = playlists.find((playlist) => playlist.id === selected) ?? playlists[0] ?? null;
  const [offset, setOffset] = useState(0);
  const page = useJellyfinPlaylist(userUUID, profile, current?.id ?? null, offset, { activeTab });
  const pageData = page.data && page.data.id === current?.id ? page.data : undefined;
  const [entries] = usePagedRows(pageData, (held) => held.entries, ["dashboard", "jellyfin", "playlists", userUUID, profile, current?.id ?? null], current?.id ?? "");
  const items = useMemo(() => entries.map(itemOf), [entries]);
  const total = pageData?.count ?? current?.count ?? 0;
  const more = entries.length < total;
  const loadMore = () => {
    if (more && !page.isFetching && entries.length > offset) setOffset(entries.length);
  };
  const keepLoading = useRef(loadMore);
  keepLoading.current = loadMore;
  const listSentinel = useRef<HTMLDivElement>(null);
  const pageSentinel = useRef<HTMLDivElement>(null);
  const listBox = useRef<HTMLDivElement>(null);
  const at = Math.min(index, Math.max(0, entries.length - 1));
  const focus = entries[at];
  const pick = (i: number) => {
    setIndex(i);
    if (i >= entries.length - 4) loadMore();
  };
  const swipe = useSwipe(at, entries.length, pick);
  const open = useOpenTitle();
  useEffect(() => { setIndex(0); setOffset(0); setConfirmDelete(false); }, [current?.id]);
  useEffect(() => {
    const targets: Array<[HTMLDivElement | null, Element | null]> = [[listSentinel.current, listBox.current], [pageSentinel.current, null]];
    const observers = targets.filter(([el]) => el).map(([el, root]) => {
      const observer = new IntersectionObserver((seen) => seen.some((e) => e.isIntersecting) && keepLoading.current(), { root, rootMargin: "400px" });
      observer.observe(el!);
      return observer;
    });
    return () => observers.forEach((o) => o.disconnect());
  }, [view, entries.length, more]);

  const run = async (work: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      failed(error, fallback);
    } finally {
      setBusy(false);
    }
  };
  const pickView = (next: PlaylistView) => {
    setView(next);
    remember("jellyfin.playlists.view", next);
  };
  const saveName = () => {
    const name = naming?.name.trim();
    if (!naming || !name) return;
    if (naming.mode === "rename" && current) {
      void run(async () => { await change(userUUID, profile, { op: "rename", id: current.id, name }); setNaming(null); }, "Could not rename it");
    } else {
      void run(async () => { const { id } = await change(userUUID, profile, { op: "create", name, itemIds: [] }); setNaming(null); if (id) setSelected(id); }, "Could not make the playlist");
    }
  };
  const move = (entry: JellyfinPlaylistEntry, to: number) => {
    if (!current) return;
    void run(async () => { await change(userUUID, profile, { op: "move", id: current.id, itemId: entry.id, to }); setIndex(to); }, "Could not move it");
  };
  const removeEntry = (entry: JellyfinPlaylistEntry) => {
    if (!current) return;
    void run(async () => {
      await change(userUUID, profile, { op: "remove", id: current.id, itemIds: [entry.id] });
      toast.success(`Removed ${entry.kind === "episode" && entry.subtitle ? entry.subtitle : entry.title}`);
    }, "Could not remove it");
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  // A drop shows at once, and holds until the pages read again after the move.
  const [arranged, setArranged] = useState<JellyfinPlaylistEntry[] | null>(null);
  useEffect(() => setArranged(null), [entries]);
  const listed = arranged ?? entries;
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = listed.findIndex((held) => held.id === active.id);
    const to = listed.findIndex((held) => held.id === over.id);
    if (from < 0 || to < 0) return;
    const entry = listed[from];
    setArranged(arrayMove(listed, from, to));
    if (!current) return;
    void run(async () => {
      try {
        await change(userUUID, profile, { op: "move", id: current.id, itemId: entry.id, to });
      } catch (error) {
        setArranged(null);
        throw error;
      }
    }, "Could not move it");
  };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); pick(Math.min(entries.length - 1, at + 1)); }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); setIndex(Math.max(0, at - 1)); }
  };
  const loading = !list.data || Boolean(current && !pageData && entries.length === 0);
  const listFailed = !list.data && list.isError && !list.isFetching;
  const pageFailed = Boolean(current && !pageData && entries.length === 0) && page.isError && !page.isFetching;
  const failedPanel = (
    <div className="flex h-[260px] flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm text-muted-foreground">{listFailed ? "Could not load the playlists." : "Could not load this playlist."}</p>
      <button type="button" onClick={() => void (listFailed ? list.refetch() : page.refetch())} className="glass h-8 rounded-full px-4 text-xs font-medium hover:bg-white/15">Retry</button>
    </div>
  );
  const nameForm = naming && (
    <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); saveName(); }}>
      <label htmlFor="playlist-name" className="sr-only">{naming.mode === "new" ? "New playlist name" : "Playlist name"}</label>
      <input id="playlist-name" autoFocus value={naming.name} maxLength={200} onChange={(event) => setNaming({ ...naming, name: event.target.value })} placeholder="Name" className="h-8 w-48 min-w-0 flex-1 rounded-full border border-white/10 bg-background/60 px-3 text-xs outline-none focus:border-blue-400/60" />
      <Button type="submit" size="sm" className="h-8 rounded-full" disabled={busy || !naming.name.trim()}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : naming.mode === "new" ? "Make" : "Save"}</Button>
      <Button type="button" size="sm" variant="ghost" className="h-8 rounded-full" onClick={() => setNaming(null)}>Cancel</Button>
    </form>
  );
  const footer = (
    <div className="flex h-10 items-center justify-center text-xs text-muted-foreground">
      {page.isFetching && offset > 0 ? <span className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading more…</span> : page.isError ? <button type="button" onClick={() => void page.refetch()} className="text-red-400 hover:text-red-300">Could not load more. Retry</button> : more ? <button type="button" onClick={loadMore} className="hover:text-foreground">Load more</button> : total > JELLYFIN_PLAYLIST_PAGE ? `All ${total} shown` : null}
    </div>
  );

  return (
    <section className="relative isolate overflow-hidden">
      <Ambient src={view === "deck" ? focus?.wide ?? focus?.image ?? null : null} />
      <div className="relative px-4 py-6 sm:px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <Fan items={items} />
            <div className="min-w-0">
              <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{profileName}'s playlists</span>
              <h2 className="truncate text-3xl font-bold tracking-tight">{current?.name ?? "Playlists"}</h2>
              <p className="truncate text-xs text-muted-foreground">{current ? `${titlesLabel(current.count)} · changed ${when(current.updatedAt)}` : list.data ? "None yet" : "…"}</p>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {current && naming === null && (
              <>
                <button type="button" onClick={() => setNaming({ mode: "rename", name: current.name })} className={PILL}><PencilLine className="size-3.5" /> Rename</button>
                {confirmDelete ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => void run(async () => { await change(userUUID, profile, { op: "delete", id: current.id }); toast.success(`Deleted ${current.name}`); setSelected(null); }, "Could not delete it")} className={cx(PILL, "bg-red-500/20 text-red-200")}>Delete for good</button>
                    <button type="button" onClick={() => setConfirmDelete(false)} className={PILL}>Keep</button>
                  </>
                ) : (
                  <button type="button" onClick={() => setConfirmDelete(true)} className={cx(PILL, "text-red-300")}><Trash2 className="size-3.5" /> Delete</button>
                )}
              </>
            )}
            <ViewToggle view={view} onView={pickView} options={PLAYLIST_VIEWS} />
          </div>
        </div>

        {view === "list" ? (
          <div className="grid gap-5 md:grid-cols-[20rem_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{profileName}'s playlists</span>
                {naming?.mode !== "new" && <button type="button" onClick={() => setNaming({ mode: "new", name: "" })} className={PILL}><Plus className="size-3.5" /> New playlist</button>}
              </div>
              {naming && nameForm}
              {listFailed
                ? failedPanel
                : !list.data
                ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[84px] rounded-xl" />)
                : playlists.map((playlist) => (
                  <button key={playlist.id} type="button" aria-pressed={playlist.id === current?.id} onClick={() => setSelected(playlist.id)} className={cx("flex items-center gap-3 rounded-xl p-2.5 text-left ring-1 transition", playlist.id === current?.id ? "bg-blue-500/10 ring-blue-400/50" : "bg-white/[0.03] ring-white/[0.06] hover:bg-white/[0.06]")}>
                    <Poster item={{ key: playlist.id, title: playlist.name, posterUrl: playlist.image, meta: "", rating: null }} label={false} width={185} className="aspect-[2/3] w-11 shrink-0 rounded-md" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{playlist.name}</span>
                      <span className="block text-xs text-muted-foreground">{titlesLabel(playlist.count)} · changed {when(playlist.updatedAt)}</span>
                    </span>
                  </button>
                ))}
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">These are the playlists every Jellyfin app shows for {profileName}. Each person has their own; switch profile above to see another's.</p>
            </div>
            <div className="glass flex min-w-0 flex-col gap-4 rounded-2xl p-4 sm:p-5">
              {!current ? (
                <p className="py-10 text-center text-sm text-muted-foreground">{list.data ? "No playlists yet. Make one on the left, or open any title and use Add to playlist." : listFailed ? "The playlists could not be loaded. Retry on the left." : ""}</p>
              ) : (
                <>
                  <AddTitles key={current.id} userUUID={userUUID} profile={profile} playlistId={current.id} playlistName={current.name} />
                  {pageFailed ? failedPanel : loading ? (
                    <div className="space-y-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[66px] rounded-xl" />)}</div>
                  ) : entries.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-white/10 p-4 text-sm text-muted-foreground">Nothing in it yet. Add titles above, or open any title and use Add to playlist.</p>
                  ) : (
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                      <SortableContext items={listed.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
                        <ol className="space-y-2">
                          {listed.map((entry, i) => <SortableEntry key={entry.id} entry={entry} number={i + 1} busy={busy} onRemove={() => removeEntry(entry)} />)}
                        </ol>
                      </SortableContext>
                    </DndContext>
                  )}
                  <div ref={pageSentinel} />
                  {entries.length > 0 && footer}
                </>
              )}
            </div>
          </div>
        ) : (
        <>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {playlists.map((playlist) => (
            <button key={playlist.id} type="button" aria-pressed={playlist.id === current?.id} onClick={() => setSelected(playlist.id)} className={cx("glass flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors", playlist.id === current?.id ? "bg-white/15 text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {playlist.name} <span className="tabular-nums opacity-60">{playlist.count}</span>
            </button>
          ))}
          {naming ? nameForm : (
            <button type="button" onClick={() => setNaming({ mode: "new", name: "" })} className={PILL}><Plus className="size-3.5" /> New playlist</button>
          )}
        </div>

        {listFailed || pageFailed ? failedPanel : loading ? (
          <div className={cx("grid gap-5", view === "deck" && "lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]")}>
            {view === "deck" && <div className="flex flex-col gap-1">{Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-[60px] rounded-xl" />)}</div>}
            <div className="flex h-[330px] items-center justify-center sm:h-[470px]"><Skeleton className="aspect-[2/3] w-40 rounded-xl sm:w-56" /></div>
          </div>
        ) : !current ? (
          <div className="flex h-[260px] flex-col items-center justify-center gap-2 text-center">
            <ListVideo className="size-8 text-muted-foreground/50" />
            <p className="max-w-md text-sm text-muted-foreground">No playlists yet. Make one here, or open any title and use Add to playlist. Every Jellyfin app signed in as {profileName} shows them.</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-[260px] flex-col items-center justify-center gap-2 text-center">
            <ListVideo className="size-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">Nothing in it yet. Open any title and use Add to playlist.</p>
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
            <div ref={listBox} data-deck-list tabIndex={0} onKeyDown={onKey} className="-mx-1 flex max-h-[480px] min-w-0 flex-col gap-1 overflow-y-auto px-1 py-1 outline-none [scrollbar-width:thin]">
              {entries.map((entry, i) => (
                <ListRow
                  key={entry.id}
                  item={items[i]}
                  number={i + 1}
                  active={i === at}
                  onPick={() => pick(i)}
                  onOpen={() => { pick(i); open?.({ item: entry.open }); }}
                  trailing={(
                    <>
                      <Button size="icon" variant="ghost" className="size-7" disabled={busy || i === 0} onClick={() => move(entry, i - 1)} aria-label={`Move ${entry.title} up`}><ChevronUp className="size-4" /></Button>
                      <Button size="icon" variant="ghost" className="size-7" disabled={busy || i === total - 1} onClick={() => move(entry, i + 1)} aria-label={`Move ${entry.title} down`}><ChevronDown className="size-4" /></Button>
                      <Button size="icon" variant="ghost" className="size-7" disabled={busy} onClick={() => removeEntry(entry)} aria-label={`Remove ${entry.title}`}><X className="size-4" /></Button>
                    </>
                  )}
                />
              ))}
              <div ref={listSentinel} />
              {footer}
            </div>
            <div {...swipe} className="order-first flex min-w-0 cursor-grab touch-pan-y select-none flex-col gap-4 active:cursor-grabbing lg:order-none">
              <Deck items={items} index={at} onPick={pick} onOpen={(i) => open?.({ item: entries[i].open })} />
              {focus && <EntryDetail entry={focus} total={total} busy={busy} onMove={(to) => move(focus, to)} onRemove={() => removeEntry(focus)} />}
            </div>
          </div>
        )}
        </>
        )}
      </div>
    </section>
  );
}
