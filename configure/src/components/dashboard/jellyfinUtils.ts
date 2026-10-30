import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useJellyfinPlays, type JellyfinTitleRef, type DashboardTab, type JellyfinPlayKind, type JellyfinPlayRow, type JellyfinProfileSummary } from "@/hooks/useDashboardQueries";

export function when(value: number | null | undefined): string {
  if (!value) return "—";
  const diff = Date.now() - value;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  return new Date(value).toLocaleDateString();
}
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
export const percentOf = (row: JellyfinPlayRow): number | null =>
  row.runtimeMs > 0 ? Math.round((row.positionMs / row.runtimeMs) * 100) : null;
export function watchedWhen(at: number): string {
  if (Date.now() - at < 7 * 86_400_000) return when(at);
  return `on ${new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`;
}
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}
export function rewatchLabel(positionMs: number): string {
  return positionMs < 60_000 ? "Started again" : `Rewatching, ${duration(positionMs)} in`;
}
export const timesWatched = (item: { played: boolean; playCount: number; watches: number[] }): number =>
  item.played ? Math.max(1, item.playCount, item.watches.length) : 0;
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes <= 0) return "";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
export function recall<T>(key: string, initial: T): T {
  try {
    const stored = sessionStorage.getItem(key);
    return stored === null ? initial : (JSON.parse(stored) as T);
  } catch {
    return initial;
  }
}
export function remember<T>(key: string, value: T, initial: T): void {
  try {
    if (value === initial) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
export function useRemembered<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => recall(key, initial));
  const set = (next: T) => {
    setValue(next);
    remember(key, next, initial);
  };
  return [value, set];
}
export const SELECTED_KEY = "jellyfin.selected";
export const profileKey = (userUUID: string) => `jellyfin.profile.${userUUID}`;
export const dayKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export interface Activity {
  days: Record<string, number>;
  total: number;
  active: number;
  streak: number;
  best: number;
}
export function activityOf(profiles: JellyfinProfileSummary[]): Activity {
  const days: Record<string, number> = {};
  for (const p of profiles) for (const [day, n] of Object.entries(p.days)) days[day] = (days[day] ?? 0) + n;
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);
  if (!days[dayKey(cursor)]) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days[dayKey(cursor)]) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  let best = 0;
  let run = 0;
  const walk = new Date();
  walk.setHours(12, 0, 0, 0);
  walk.setDate(walk.getDate() - 370);
  for (let i = 0; i <= 370; i += 1, walk.setDate(walk.getDate() + 1)) {
    run = days[dayKey(walk)] ? run + 1 : 0;
    best = Math.max(best, run);
  }
  const counts = Object.values(days);
  return { days, total: counts.reduce((a, n) => a + n, 0), active: counts.filter((n) => n > 0).length, streak, best };
}
/**
 * A list paged by hand keeps only its newest page's query active, so an edit made elsewhere refreshes that page alone.
 * When a page already shown comes back changed, every loaded page is read again and the list is built from them.
 */
export async function reloadPages<R>(queryClient: QueryClient, base: readonly unknown[], offsets: number[]): Promise<R[][] | null> {
  await queryClient.refetchQueries({ queryKey: base, type: "inactive" });
  const pages: R[][] = [];
  for (const at of offsets) {
    const page = queryClient.getQueryData<{ rows?: R[] }>([...base, at]);
    if (!page?.rows) return null;
    pages.push(page.rows);
  }
  return pages;
}

export function usePagedPlays(userUUID: string, profile: string | null, kind: JellyfinPlayKind, base: JellyfinPlayRow[], total: number, activeTab: DashboardTab) {
  const [offset, setOffset] = useState(0);
  const [pages, setPages] = useState<Array<{ offset: number; rows: JellyfinPlayRow[] }>>([]);
  const [done, setDone] = useState(false);
  const { data, isFetching, isError, refetch } = useJellyfinPlays(userUUID, profile, kind, offset, { activeTab });
  const queryClient = useQueryClient();
  const loaded = useRef<number[]>([]);
  // A re-read still out when the profile changes is of the list that was there before.
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setOffset(0);
    setPages([]);
    setDone(false);
    loaded.current = [];
  }, [profile]);
  useEffect(() => {
    if (!data || data.offset !== offset || offset === 0 || data.profile !== profile) return;
    if (data.done) setDone(true);
    if (!loaded.current.includes(data.offset)) {
      loaded.current = [...loaded.current, data.offset];
      setPages((held) => [...held, { offset: data.offset, rows: data.rows }]);
      return;
    }
    const offsets = [...loaded.current];
    const started = generation.current;
    void reloadPages<JellyfinPlayRow>(queryClient, ["dashboard", "jellyfin", "plays", userUUID, profile, kind], offsets).then((reread) => {
      if (reread && started === generation.current) setPages(offsets.map((at, i) => ({ offset: at, rows: reread[i] })));
    });
  }, [data, offset, profile, userUUID, kind, queryClient]);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: JellyfinPlayRow[] = [];
    for (const row of [...base, ...pages.flatMap((p) => p.rows)]) {
      const key = `${row.profile}|${row.videoId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    return out;
  }, [base, pages]);
  const more = !done && rows.length < total && base.length > 0;
  const loading = isFetching && offset > 0;
  const loadMore = () => {
    if (more && !isFetching && rows.length > offset) setOffset(rows.length);
  };
  const failed = isError && !isFetching && offset > 0;
  return { rows, more, loading, loadMore, failed, retry: () => void refetch() };
}

export const OpenTitleContext = createContext<((ref: JellyfinTitleRef, season?: number | null) => void) | null>(null);

export function useOpenTitle(): ((ref: JellyfinTitleRef, season?: number | null) => void) | null {
  return useContext(OpenTitleContext);
}

export function titleRefOf(row: { seriesId: string | null; videoId: string }): JellyfinTitleRef {
  return row.seriesId ? { id: row.seriesId, type: "series" } : { id: row.videoId.split(":").slice(0, row.videoId.startsWith("tt") ? 1 : 2).join(":"), type: "movie" };
}

export function anchorOf(element: Element): { left: number; right: number; top: number; bottom: number } {
  const box = element.getBoundingClientRect();
  return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
}
