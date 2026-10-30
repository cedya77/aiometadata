import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import JellyfinCalendar from "./JellyfinCalendar";
import JellyfinLibrary from "./JellyfinLibrary";
import JellyfinTitlePage from "./JellyfinTitle";
import JellyfinSearch, { type LocalTitle } from "./JellyfinSearch";
import JellyfinImport from "./JellyfinImport";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity as ActivityIcon, Bookmark, CalendarDays, History, LayoutGrid, Loader2, Network, Search, TableProperties, Tv, Upload, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useJellyfinClearResume,
  useJellyfinConfiguration,
  useJellyfinExport,
  useJellyfinOverview,
  useJellyfinSearch,
  useJellyfinTitleAction,
  type DashboardTab,
  type JellyfinPlayRow,
  type JellyfinTitleRef,
} from "@/hooks/useDashboardQueries";
import { ActivityMap, Hero } from "./JellyfinHero";
import JellyfinSync from "./JellyfinSync";
import { MoreFooter, PlayTable, PlayedByDay, ProgressCard, Row, type ProgressAction } from "./JellyfinPlays";
import RemoteSheet, { type RemoteTarget } from "./JellyfinRemote";
import { Sentinel, Shelf, Stat } from "./JellyfinShared";
import { Shows } from "./JellyfinShows";
import { when, useRemembered, activityOf, usePagedPlays, OpenTitleContext, titleRefOf, recall, remember, SELECTED_KEY, profileKey } from "./jellyfinUtils";
import { navigateDashboard, useDashboardRoute, type DashboardLocation, type DashboardPage, type JellyfinSection } from "@/lib/dashboardRoute";


type View = "cards" | "table";

const SECTIONS: Array<{ key: JellyfinSection; label: string; icon: typeof Tv }> = [
  { key: "overview", label: "Overview", icon: ActivityIcon },
  { key: "library", label: "Library", icon: Bookmark },
  { key: "shows", label: "Shows", icon: Tv },
  { key: "calendar", label: "Calendar", icon: CalendarDays },
  { key: "history", label: "History", icon: History },
  { key: "trackers", label: "Trackers", icon: Network },
];

function SectionBar({ section, onSection }: { section: JellyfinSection; onSection: (next: JellyfinSection) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = scroller.current;
    const active = strip?.querySelector<HTMLElement>("[aria-current=page]");
    if (!strip || !active) return;
    const left = active.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + active.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollTo({ left: left - (strip.clientWidth - active.offsetWidth) / 2, behavior: "smooth" });
    }
  }, [section]);
  return (
    <nav aria-label="Sections" className="sticky top-[57px] z-20 border-t border-white/[0.06] bg-background/80 backdrop-blur-lg">
      <div ref={scroller} className="flex gap-1 overflow-x-auto px-4 py-2 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden">
        {SECTIONS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => onSection(key)}
            aria-current={key === section ? "page" : undefined}
            className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors ${key === section ? "bg-foreground text-background" : "text-muted-foreground hover:bg-white/10 hover:text-foreground"}`}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>
    </nav>
  );
}
function ShelfSkeleton() {
  return (
    <section className="space-y-3 px-4 py-4 sm:px-6">
      <Skeleton className="h-3 w-36" />
      <div className="flex gap-3 overflow-hidden">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="aspect-video w-64 shrink-0 rounded-lg sm:w-80" />)}
      </div>
    </section>
  );
}
function ConfigurationSkeleton() {
  return (
    <div className="border-t border-white/[0.06]">
      <div className="space-y-5 px-4 pt-14 pb-6 sm:px-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-14 w-14 rounded-full" />
          <div className="space-y-2"><Skeleton className="h-6 w-44" /><Skeleton className="h-3 w-56" /></div>
        </div>
        <div className="grid max-w-2xl grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="space-y-2"><Skeleton className="h-8 w-20" /><Skeleton className="h-3 w-16" /></div>)}
        </div>
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading playback…</p>
      </div>
      <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
        <section className="flex gap-2 px-4 py-3 sm:px-6">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-7 w-36 rounded-full" />)}</section>
        <ShelfSkeleton />
      </div>
    </div>
  );
}
const EMPTY_PLAYS: JellyfinPlayRow[] = [];
function Configuration({ userUUID, route, activeTab, onClose }: { userUUID: string; route: DashboardLocation; activeTab: DashboardTab; onClose: () => void }) {
  const profile = route.profile;
  const section = route.section ?? "overview";
  const sectionsTop = useRef<HTMLDivElement>(null);
  const setSection = (next: JellyfinSection) => {
    navigateDashboard({ tab: "jellyfin", config: userUUID, profile, page: null, section: next });
    const top = sectionsTop.current ? sectionsTop.current.getBoundingClientRect().top + window.scrollY - 57 : 0;
    if (window.scrollY > top) requestAnimationFrame(() => window.scrollTo({ top, behavior: "instant" }));
  };
  useEffect(() => remember(profileKey(userUUID), profile, null), [userUUID, profile]);
  const setProfile = (next: string | null) => navigateDashboard({ tab: "jellyfin", config: userUUID, profile: next, page: null }, { replace: true });
  const [view, setView] = useRemembered<View>("jellyfin.view", "cards");
  const [exporting, setExporting] = useState(false);
  const [allProgress, setAllProgress] = useRemembered<boolean>("jellyfin.allProgress", false);
  const exportJson = useJellyfinExport();
  const { data, isLoading, isError, isFetching, isPlaceholderData } = useJellyfinConfiguration(userUUID, profile, null, { activeTab });
  const pagedProgress = usePagedPlays(userUUID, profile, "progress", data?.inProgress ?? EMPTY_PLAYS, data?.totals?.progress ?? 0, activeTab);
  const clearResume = useJellyfinClearResume();
  const queryClient = useQueryClient();
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const progress = useMemo(() => (removed.size ? { ...pagedProgress, rows: pagedProgress.rows.filter((row) => !removed.has(`${row.profileKey}|${row.videoId}`)) } : pagedProgress), [pagedProgress, removed]);
  // A removed row stays hidden only until the server stops listing it, so playing it again brings it back.
  useEffect(() => {
    if (!removed.size) return;
    const listed = new Set(pagedProgress.rows.map((row) => `${row.profileKey}|${row.videoId}`));
    if ([...removed].some((key) => !listed.has(key))) setRemoved((held) => new Set([...held].filter((key) => listed.has(key))));
  }, [pagedProgress.rows, removed]);
  const titleAction = useJellyfinTitleAction();
  const [remote, setRemote] = useState<{ target: RemoteTarget; at: { x: number; y: number }; profile: string | null; profileName: string } | null>(null);
  const closeRemote = useCallback(() => setRemote(null), []);
  // A profile deleted since it was picked, here or remembered from before, goes back to everyone.
  useEffect(() => {
    if (profile === null || !data?.viewers || data.userUUID !== userUUID || data.profile !== profile) return;
    if (!data.viewers.some((p) => p.key === profile)) setProfile(null);
  }, [data, profile, userUUID]);
  const progressAction = useCallback(async (row: JellyfinPlayRow, action: ProgressAction) => {
    try {
      if (action === "clear") await clearResume(userUUID, row.profileKey, row.videoId);
      else await titleAction(userUUID, row.profileKey || null, action, [row.itemId]);
      if (action !== "drop") setRemoved((prev) => new Set(prev).add(`${row.profileKey}|${row.videoId}`));
      toast.success(action === "played" ? `Marked ${row.title} watched` : action === "unplayed" ? `Marked ${row.title} unwatched` : action === "clear" ? `Cleared the resume position of ${row.title}` : `Dropped ${row.title}`);
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "dashboard" && q.queryKey[1] === "jellyfin" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the change");
    }
  }, [clearResume, titleAction, userUUID, queryClient]);
  // In the All view a row is another profile's, whose devices are the ones to play it on.
  const playOn = useCallback((row: JellyfinPlayRow, at: { x: number; y: number }) => setRemote({
    at,
    profile: row.profileKey || null,
    profileName: row.profile,
    target: {
      itemId: row.itemId,
      itemType: row.seriesId ? "Episode" : "Movie",
      itemName: row.episodeTitle ?? row.title,
      heading: row.seriesId ? row.episodeTitle || row.episode || row.title : row.title,
      sub: row.seriesId ? [row.title, row.episode].filter(Boolean).join(" · ") : null,
      still: row.imageUrl ?? row.backdropUrl,
    },
  }), []);
  const played = usePagedPlays(userUUID, profile, "played", data?.recentlyPlayed ?? EMPTY_PLAYS, data?.totals?.played ?? 0, activeTab);
  const localTitles = useMemo<LocalTitle[]>(() => {
    const out = new Map<string, LocalTitle>();
    for (const row of [...progress.rows, ...played.rows]) {
      const ref = titleRefOf(row);
      if (!("id" in ref) || out.has(ref.id)) continue;
      out.set(ref.id, { id: ref.id, type: ref.type, title: row.title, posterUrl: row.posterUrl, state: row.positionMs > 0 && !row.played ? "In progress" : row.played ? "Watched" : null });
    }
    return [...out.values()];
  }, [progress.rows, played.rows]);
  const openTitle = useCallback((ref: JellyfinTitleRef, season?: number | null) => navigateDashboard({ tab: "jellyfin", config: userUUID, profile, page: season === undefined ? { kind: "title", ref } : { kind: "title", ref, season } }), [userUUID, profile]);
  const openStack = useCallback((stack: DashboardPage[]) => navigateDashboard({ tab: "jellyfin", config: userUUID, profile, page: stack[stack.length - 1] }, { stack }), [userUUID, profile]);

  const runExport = async () => {
    setExporting(true);
    try {
      await exportJson(userUUID);
      toast.success("Exported");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  if (isLoading && !data) return <ConfigurationSkeleton />;
  if (isError || !data) return <p className="text-xs text-red-500 px-4 py-3">Could not load this configuration's playback.</p>;

  const switching = isPlaceholderData && (data.userUUID !== userUUID || data.profile !== profile);
  const history = data.history === undefined ? data.profile : data.history;
  const shown = history === null ? data.profiles : data.profiles.filter((p) => p.key === history);
  const activity = activityOf(shown);
  const profileName = (profile === null ? data.profiles[0]?.name : (data.viewers ?? data.profiles).find((p) => p.key === profile)?.name) ?? data.label;
  const historyName = (history === null ? data.profiles[0]?.name : data.profiles.find((p) => p.key === history)?.name) ?? profileName;
  const controls = (
    <>
      <JellyfinSearch userUUID={userUUID} profile={profile} profileName={profileName} local={localTitles} activeTab={activeTab} />
      {(section === "overview" || section === "history") && <div className="glass inline-flex rounded-full p-0.5">
        <Button size="sm" variant={view === "cards" ? "secondary" : "ghost"} className="h-7 rounded-full px-2.5" onClick={() => setView("cards")} aria-label="Cards"><LayoutGrid className="h-3.5 w-3.5" /></Button>
        <Button size="sm" variant={view === "table" ? "secondary" : "ghost"} className="h-7 rounded-full px-2.5" onClick={() => setView("table")} aria-label="Table"><TableProperties className="h-3.5 w-3.5" /></Button>
      </div>}
      {isFetching && !isLoading && !switching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      <Button size="sm" variant="ghost" className="glass h-8 gap-1 rounded-full px-3" onClick={runExport} disabled={exporting}>
        {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Export
      </Button>
      <JellyfinImport userUUID={userUUID} />
      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClose} aria-label="Close"><X className="h-3.5 w-3.5" /></Button>
    </>
  );

  const watched = shown.reduce((sum, p) => sum + p.movies + p.episodes, 0);
  const sentTo = data.sync.filter((row) => row.profiles.includes(historyName)).map((row) => row.service);
  return (
    <OpenTitleContext.Provider value={openTitle}>
    <div className="border-t border-white/[0.06]">
      {remote && <RemoteSheet userUUID={userUUID} profile={remote.profile} profileName={remote.profileName} target={remote.target} at={remote.at} activeTab={activeTab} onClose={closeRemote} />}
      {route.stack.length > 0 && <JellyfinTitlePage userUUID={userUUID} profile={profile} profileName={profileName} sentTo={sentTo} stack={route.stack} activeTab={activeTab} onOpen={openStack} />}
      <Hero data={data} profile={profile} onProfile={setProfile} activity={activity} controls={controls} switching={switching} />
      <JellyfinImport userUUID={userUUID} notice />
      <div ref={sectionsTop} />
      <SectionBar section={section} onSection={setSection} />
      {switching ? (
        <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
          <section className="flex gap-2 px-4 py-3 sm:px-6">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-7 w-36 rounded-full" />)}</section>
          <ShelfSkeleton />
          <ShelfSkeleton />
        </div>
      ) : (
      <div className={`min-h-screen divide-y divide-white/[0.06] border-t border-white/[0.06] transition-opacity ${isFetching && !isLoading ? "opacity-60" : "opacity-100"}`}>
        {section === "overview" && (
          <>
            <JellyfinSync key={`sync:${profile ?? ""}`} compact onOpen={() => setSection("trackers")} userUUID={userUUID} profile={profile} profileName={profileName} watched={watched} rows={data.sync} activeTab={activeTab} />
            <Shelf
              title="Continue watching"
              count={progress.more ? data.totals?.progress ?? progress.rows.length : progress.rows.length}
              action={view === "cards" && progress.rows.length > 3 && (
                <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => setAllProgress(!allProgress)}>
                  {allProgress ? "Show as a row" : "View all"}
                </Button>
              )}
            >
              {progress.rows.length === 0
                ? <p className="text-xs text-muted-foreground">Nothing in progress.</p>
                : view === "table"
                  ? <><PlayTable rows={progress.rows} kind="progress" /><Sentinel key={progress.rows.length} onVisible={progress.loadMore} /><MoreFooter paged={progress} /></>
                  : allProgress
                    ? <><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{progress.rows.map((row) => <ProgressCard key={`${row.profile}|${row.videoId}`} row={row} onAction={(action) => progressAction(row, action)} onPlayOn={(at) => playOn(row, at)} />)}</div><Sentinel key={progress.rows.length} onVisible={progress.loadMore} /><MoreFooter paged={progress} /></>
                    : (
                      <>
                        <Row onEnd={progress.more && !progress.failed ? progress.loadMore : undefined} loading={progress.loading}>
                          {progress.rows.map((row) => <div key={`${row.profile}|${row.videoId}`} className="w-64 shrink-0 snap-start sm:w-80"><ProgressCard row={row} onAction={(action) => progressAction(row, action)} onPlayOn={(at) => playOn(row, at)} /></div>)}
                        </Row>
                        {progress.failed && <MoreFooter paged={progress} />}
                      </>
                    )}
            </Shelf>
            <ActivityMap activity={activity} />
          </>
        )}
        {section === "library" && <JellyfinLibrary key={`library:${profile ?? ""}`} userUUID={userUUID} profile={profile} profileName={profileName} activeTab={activeTab} />}
        {section === "shows" && <Shows key={`shows:${profile ?? ""}`} userUUID={userUUID} profile={profile} profileName={profileName} activeTab={activeTab} />}
        {section === "calendar" && <JellyfinCalendar key={`calendar:${profile ?? ""}`} userUUID={userUUID} profile={profile} profileName={profileName} activeTab={activeTab} />}
        {section === "history" && (
          <Shelf title="Recently played" count={played.more ? data.totals?.played ?? played.rows.length : played.rows.length}>
            {played.rows.length === 0
              ? <p className="text-xs text-muted-foreground">Nothing played yet.</p>
              : view === "table"
                ? <PlayTable rows={played.rows} kind="played" />
                : <PlayedByDay rows={played.rows} />}
            {played.rows.length > 0 && <><Sentinel key={played.rows.length} onVisible={played.loadMore} /><MoreFooter paged={played} /></>}
          </Shelf>
        )}
        {section === "trackers" && <JellyfinSync key={`sync:${profile ?? ""}`} userUUID={userUUID} profile={profile} profileName={profileName} watched={watched} rows={data.sync} activeTab={activeTab} />}
      </div>
      )}
    </div>
    </OpenTitleContext.Provider>
  );
}
export default function DashboardJellyfin({ activeTab }: { activeTab: DashboardTab }) {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const route = useDashboardRoute();
  const selected = route.tab === "jellyfin" ? route.config : null;
  useEffect(() => {
    if (selected) remember(SELECTED_KEY, selected, null);
  }, [selected]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const overview = useJellyfinOverview({ activeTab });
  const search = useJellyfinSearch(query, { activeTab });
  const o = overview.data;
  const sync = o?.sync;
  const syncHint = !sync ? "" : sync.running
    ? "running now"
    : sync.finishedAt
      ? `${sync.added} imported across ${sync.configurations} configuration${sync.configurations === 1 ? "" : "s"}`
      : "not yet run";

  const pick = (userUUID: string) => {
    navigateDashboard({ tab: "jellyfin", config: userUUID, profile: recall<string | null>(profileKey(userUUID), null), page: null });
    setTyped("");
  };
  const close = () => {
    remember<string | null>(SELECTED_KEY, null, null);
    navigateDashboard({ tab: "jellyfin", config: null, profile: null, page: null });
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Playing now" value={o?.playingNow ?? "…"} hint={o ? `${o.pausedNow} paused, ${o.sessions} session${o.sessions === 1 ? "" : "s"} open` : undefined} />
        <Stat label="Active configurations" value={o ? (o.activeConfigurations ?? "—") : "…"} hint={o ? `used the server in the last ${o.activeDays} days` : undefined} />
        <Stat label="Plays, 24 h" value={o?.playedDay ?? "…"} hint={o ? `${o.playedWeek} this week` : undefined} />
        <Stat label="Tracker sync" value={sync ? (sync.running ? "…" : sync.finishedAt ? when(sync.finishedAt) : "—") : "…"} hint={syncHint || undefined} />
      </div>

      <Card>
        <CardHeader className="space-y-3">
          <div>
            <CardTitle className="text-base">Playback of a configuration</CardTitle>
            <CardDescription>
              What the server recorded for one configuration: live sessions, positions and plays that went through it, and what the tracker sync imported. Look a configuration up by its id or a user name.
            </CardDescription>
          </div>
          <div className="relative max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              id="jellyfin-configuration-search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Configuration id or user name"
              className="pl-8"
            />
            {query && (
              <div className="absolute z-20 mt-1 w-full rounded-md border border-white/[0.08] bg-popover shadow-lg">
                {search.isLoading ? (
                  <p className="text-xs text-muted-foreground px-3 py-2 flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Searching…</p>
                ) : !search.data || search.data.results.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-3 py-2">Nothing matches "{query}".</p>
                ) : (
                  search.data.results.map((row) => (
                    <button
                      key={row.userUUID}
                      type="button"
                      onClick={() => pick(row.userUUID)}
                      className="w-full flex items-center gap-3 px-3 py-2 text-left text-xs hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="font-medium">{row.label}</span>
                      <span className="font-mono text-muted-foreground">{row.userUUID.slice(0, 8)}</span>
                      <span className="text-muted-foreground truncate">{row.profiles.map((p) => p.name).join(", ")}</span>
                      <span className="ml-auto text-muted-foreground whitespace-nowrap">{when(row.lastActivity)}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {selected
            ? <Configuration key={selected} userUUID={selected} route={route} activeTab={activeTab} onClose={close} />
            : <p className="text-xs text-muted-foreground px-4 py-3">Search for a configuration to see its playback.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
