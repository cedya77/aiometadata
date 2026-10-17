import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, RefreshCw, Loader2 } from "lucide-react";
import {
  useJellyfinShowRefresh,
  useJellyfinShows,
  type DashboardTab,
  type JellyfinEpisodeRef,
  type JellyfinShowRow,
} from "@/hooks/useDashboardQueries";
import { Art, Shelf } from "./JellyfinShared";
import { when, useFolded, useOpenTitle } from "./jellyfinUtils";

const episodeRef = (ref: JellyfinEpisodeRef | null): string => {
  if (!ref || ref.number === null) return "";
  const e = `E${ref.number}`;
  return ref.season === null ? e : `S${ref.season} ${e}`;
};
type ShowFilter = "all" | "next" | "waiting" | "done" | "problems";
const SHOW_FILTERS: Array<{ key: ShowFilter; label: string; outcomes: string[] }> = [
  { key: "all", label: "All", outcomes: [] },
  { key: "next", label: "Up next", outcomes: ["shown"] },
  { key: "waiting", label: "Waiting", outcomes: ["caught-up", "airs-later"] },
  { key: "done", label: "Finished", outcomes: ["finished", "dropped"] },
  { key: "problems", label: "Not shown", outcomes: ["missing-episode", "no-meta", "no-air-date", "not-anime", "rating-cap"] },
];
function showStatus(row: JellyfinShowRow): { text: string; tone: string; fixable: boolean } {
  const next = episodeRef(row.next);
  switch (row.outcome) {
    case "shown": return { text: `Up next ${next}${row.next?.name ? ` · ${row.next.name}` : ""}`, tone: "text-blue-300", fixable: false };
    case "caught-up": return { text: "Caught up, waiting for new episodes", tone: "text-sky-300", fixable: false };
    case "airs-later": return { text: `${next} airs ${row.airsAt ? new Date(row.airsAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "later"}`, tone: "text-sky-300", fixable: false };
    case "finished": return { text: "Finished", tone: "text-emerald-400", fixable: false };
    case "dropped": return { text: "Dropped", tone: "text-muted-foreground", fixable: false };
    case "missing-episode": return { text: `Last watched ${episodeRef(row.last) || "episode"} is not among its ${row.episodes ?? 0} episodes`, tone: "text-red-400", fixable: true };
    case "no-meta": return { text: "No metadata for this show", tone: "text-red-400", fixable: true };
    case "no-air-date": return { text: `${next} has no air date`, tone: "text-amber-400", fixable: true };
    case "not-anime": return { text: "Left out: this profile's shelf keeps anime only", tone: "text-muted-foreground", fixable: false };
    case "rating-cap": return { text: "Left out: above this profile's age rating", tone: "text-muted-foreground", fixable: false };
    default: return { text: row.outcome, tone: "text-muted-foreground", fixable: false };
  }
}
const SOURCE_LABELS: Record<string, string> = { server: "played here", tracker: "from the tracker", sequel: "sequel" };
function ShowCard({ row, onRefresh, refreshing }: { row: JellyfinShowRow; onRefresh: () => void; refreshing: boolean }) {
  const status = showStatus(row);
  const pct = row.total ? Math.min(100, Math.round(((row.watched ?? 0) / row.total) * 100)) : null;
  const open = useOpenTitle();
  return (
    <div role={open ? "button" : undefined} tabIndex={open ? 0 : undefined} onClick={open ? () => open({ id: row.metaId, type: "series" }) : undefined} onKeyDown={open ? (event) => { if (event.key === "Enter") open({ id: row.metaId, type: "series" }); } : undefined} className={`flex gap-3 rounded-lg bg-muted/30 p-2.5 ring-1 ring-white/[0.06] transition hover:bg-muted/50 ${open ? "cursor-pointer" : ""}`}>
      <div className="w-12 shrink-0"><Art src={row.posterUrl} title={row.title} wide={false} /></div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-sm font-semibold leading-tight" title={row.title}>{row.title}</p>
          {status.fixable && (
            <Button size="sm" variant="ghost" className="-mr-1 -mt-1 h-6 gap-1 px-1.5 text-[11px]" onClick={(event) => { event.stopPropagation(); onRefresh(); }} disabled={refreshing} title="Read this show's episodes again and rebuild its shelves">
              <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} /> Refresh
            </Button>
          )}
        </div>
        <p className={`truncate text-[11px] leading-tight ${status.tone}`} title={status.text}>{status.text}</p>
        {pct !== null && (
          <div className="flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
              <div className={`h-full rounded-full ${pct >= 100 ? "bg-emerald-500" : "bg-gradient-to-r from-blue-600 to-blue-400"}`} style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">{row.watched}/{row.total}</span>
          </div>
        )}
        <p className="truncate text-[10px] text-muted-foreground">{SOURCE_LABELS[row.source] ?? row.source}{row.lastWatchedAt ? ` · ${when(row.lastWatchedAt)}` : ""}</p>
      </div>
    </div>
  );
}
const SHOWS_CAP = 12;
export function Shows({ userUUID, profile, profileName, activeTab }: { userUUID: string; profile: string | null; profileName: string; activeTab: DashboardTab }) {
  const [fresh, setFresh] = useState(0);
  const [filter, setFilter] = useState<ShowFilter>("all");
  const [all, setAll] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const refreshShow = useJellyfinShowRefresh();
  const [folded, fold] = useFolded("jellyfin.fold.shows");
  const { data, isLoading, isError, isFetching } = useJellyfinShows(userUUID, profile, fresh, { activeTab, enabled: !folded });
  const rows = data?.rows ?? [];
  const counts = Object.fromEntries(SHOW_FILTERS.map((f) => [f.key, f.outcomes.length ? rows.filter((r) => f.outcomes.includes(r.outcome)).length : rows.length])) as Record<ShowFilter, number>;
  const picked = SHOW_FILTERS.find((f) => f.key === filter)!;
  const shown = picked.outcomes.length ? rows.filter((r) => picked.outcomes.includes(r.outcome)) : rows;
  const visible = all ? shown : shown.slice(0, SHOWS_CAP);

  const refresh = async (row: JellyfinShowRow) => {
    setRefreshing(row.metaId);
    try {
      await refreshShow(userUUID, row.metaId);
      setFresh((n) => n + 1);
      toast.success(`${row.title} read again`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Refresh failed");
    } finally {
      setRefreshing(null);
    }
  };

  return (
    <Shelf
      title={`Shows, ${profileName}'s Next Up`}
      count={data ? rows.length : null}
      folded={folded}
      onFold={fold}
      action={
        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {data && !isFetching && <span className="tabular-nums">built in {(data.ms / 1000).toFixed(1)} s</span>}
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => setFresh((n) => n + 1)} disabled={isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} /> Rebuild
          </Button>
        </span>
      }
    >
      {isLoading && !data ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Building Next Up the way a client would…</p>
      ) : isError || !data ? (
        <p className="text-xs text-red-500">Could not build this profile's Next Up.</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No shows in progress.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {SHOW_FILTERS.map((f) => (
              <button key={f.key} type="button" onClick={() => { setFilter(f.key); setAll(false); }} className={`h-7 rounded-full px-3 text-xs ring-1 transition-colors ${filter === f.key ? "bg-foreground text-background ring-transparent" : "bg-muted/30 ring-white/[0.1] hover:bg-muted/50"}`}>
                {f.label} <span className="tabular-nums opacity-60">{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <div className={`grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 transition-opacity ${isFetching ? "opacity-60" : ""}`}>
            {visible.map((row) => <ShowCard key={row.metaId} row={row} onRefresh={() => { void refresh(row); }} refreshing={refreshing === row.metaId} />)}
          </div>
          {shown.length > SHOWS_CAP && (
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setAll((v) => !v)}>
              {all ? <>Show fewer <ChevronUp className="h-3.5 w-3.5" /></> : <>View all {shown.length} <ChevronDown className="h-3.5 w-3.5" /></>}
            </Button>
          )}
        </div>
      )}
    </Shelf>
  );
}
