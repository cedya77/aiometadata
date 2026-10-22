import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowLeftRight, Ban, Bookmark, CalendarDays, ChevronDown, History, Infinity as Everything, ListChecks, Loader2, Pause, Play, Square, Star } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useJellyfinCopyJobs, useJellyfinSyncActions, type DashboardTab, type JellyfinCopyJob, type JellyfinCopyNamed, type JellyfinCopyPreview, type JellyfinCopyTitle, type JellyfinCopyWhat, type JellyfinSyncLane } from "@/hooks/useDashboardQueries";
import { Eyebrow, Logo, Still, Toggle } from "./TrackerParts";
import { ANIME_ONLY, COPY_FROM, COPY_ROUTES, nameOf } from "./trackerNames";
import { when } from "./jellyfinUtils";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
const shortDay = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

type Range = "all" | "since" | "pick";

const NOUNS: Record<JellyfinCopyWhat, [string, string]> = { watches: ["watch", "watches"], ratings: ["rating", "ratings"], watchlist: ["watchlist title", "watchlist titles"], dropped: ["dropped show", "dropped shows"] };
const REASONS: Record<string, string> = {
  "turned off": "are turned off for it in your tracking settings",
  "not anime": "aren't anime",
  "one season": "rate one anime season, which it can't hold apart from the show",
  "not rated there": "are seasons or episodes, which it doesn't rate",
  "not in library": "aren't in its library, and it only rates titles you've added",
  "no id": "have no id it knows",
  "not a show": "are films, and only shows can be dropped",
  refused: "were sent before and it didn't take them",
};
const nounOf = (what: JellyfinCopyWhat, n: number) => plural(n, NOUNS[what][0], NOUNS[what][1]);

function markLine(t: JellyfinCopyTitle, what: JellyfinCopyWhat): string {
  const kind = t.kind === "movie" ? "Film" : t.kind === "season" ? `Season ${t.season}` : t.kind === "episode" ? `S${t.season}E${t.episode}` : "Show";
  const value = what === "ratings" && t.rating ? ` · rated ${t.rating}` : "";
  const date = t.lastAt ? ` · ${what === "ratings" ? "rated" : what === "watchlist" ? "added" : "dropped"} ${shortDay(t.lastAt)}` : "";
  return `${kind}${value}${date}`;
}

function Side({ label, lane, lanes, onPick, accent }: { label: string; lane: JellyfinSyncLane | undefined; lanes: JellyfinSyncLane[]; onPick: (key: string) => void; accent?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cx("flex min-w-0 flex-1 items-center gap-4 rounded-2xl border p-4 text-left transition-colors hover:bg-white/[0.05]", accent ? "border-blue-400/40 bg-gradient-to-r from-blue-500/[0.1] to-transparent" : "border-white/[0.09] bg-white/[0.03]")}>
          {lane ? <Logo service={lane.service} size={48} /> : <span className="size-12 rounded-xl bg-white/5" />}
          <span className="min-w-0 flex-1">
            <span className={cx("block text-[11px] font-medium uppercase tracking-[0.14em]", accent ? "text-blue-300" : "text-muted-foreground")}>{label}</span>
            <span className="block truncate text-lg font-bold">{lane ? nameOf(lane.service) : "Pick a tracker"}</span>
            {lane && lane.profiles.length > 0 && <span className="block truncate text-xs text-muted-foreground">{lane.profiles.join(", ")} · read {lane.syncedAt ? when(lane.syncedAt) : "never"}</span>}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {lanes.map((option) => (
          <DropdownMenuItem key={option.key} onSelect={() => onPick(option.key)} className="gap-3">
            <Logo service={option.service} size={22} /> {nameOf(option.service)}
            {option.profiles.length > 1 && <span className="text-xs text-muted-foreground">{option.profiles.join(", ")}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function JobCard({ job, onControl }: { job: JellyfinCopyJob; onControl: (id: number, action: "pause" | "resume" | "stop") => void }) {
  const share = job.total ? Math.min(100, (job.done / job.total) * 100) : 100;
  const live = job.status === "running" || job.status === "paused";
  const waiting = job.status === "running" && job.nextAt && job.nextAt - Date.now() > 60_000;
  return (
    <div className={cx("flex flex-col gap-3 rounded-2xl p-5", live ? "border border-blue-400/25 bg-gradient-to-b from-blue-500/[0.06] to-white/[0.015]" : "border border-white/[0.07] bg-white/[0.02]")}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2">
          <Logo service={job.fromService} size={28} />
          <ArrowLeftRight className="size-3.5 text-muted-foreground" />
          <Logo service={job.toService} size={28} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{nameOf(job.fromService)} to {nameOf(job.toService)}</span>
          <span className="block text-xs text-muted-foreground">
            {job.status === "done" ? `Finished ${when(job.finishedAt ?? job.createdAt)}` : job.status === "stopped" ? `Stopped ${when(job.finishedAt ?? job.createdAt)}` : job.status === "failed" ? "Gave up" : job.status === "paused" ? "Paused" : waiting ? `Waiting, resumes ${new Date(job.nextAt!).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}` : "Copying"}
            {" · started "}{when(job.createdAt)}
          </span>
        </span>
        {live && (
          <span className="flex items-center gap-1.5">
            {job.status === "running"
              ? <button type="button" onClick={() => onControl(job.id, "pause")} className="flex h-8 items-center gap-1.5 rounded-full border border-white/[0.12] px-3 text-xs font-medium hover:bg-white/10"><Pause className="size-3.5" /> Pause</button>
              : <button type="button" onClick={() => onControl(job.id, "resume")} className="flex h-8 items-center gap-1.5 rounded-full border border-white/[0.12] px-3 text-xs font-medium hover:bg-white/10"><Play className="size-3.5" /> Resume</button>}
            <button type="button" onClick={() => onControl(job.id, "stop")} className="flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-red-300 hover:bg-red-500/10"><Square className="size-3.5" /> Stop</button>
          </span>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xl font-bold tabular-nums">{job.done.toLocaleString()} <span className="text-sm font-medium text-muted-foreground">of {nounOf(job.what ?? "watches", job.total)}</span></span>
        <span className="text-xs tabular-nums text-muted-foreground">{job.sent.toLocaleString()} sent{job.skipped ? ` · ${job.skipped.toLocaleString()} already there` : ""}{job.failed ? ` · ${job.failed.toLocaleString()} not found` : ""}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.07]">
        <div style={{ width: `${share}%` }} className={cx("h-full rounded-full transition-[width] duration-700", job.status === "failed" ? "bg-red-400" : live ? "bg-gradient-to-r from-blue-500 to-blue-300 shadow-[0_0_14px_rgba(96,165,250,0.6)]" : "bg-emerald-400/80")} />
      </div>
      {job.lastError && <p className="text-xs text-amber-200/90">{job.lastError}</p>}
    </div>
  );
}

export default function JellyfinCopy({ userUUID, profile, lanes, activeTab, initial }: {
  userUUID: string;
  profile: string | null;
  lanes: JellyfinSyncLane[];
  activeTab: DashboardTab;
  initial: { from: string; to: string } | null;
}) {
  const [what, setWhat] = useState<JellyfinCopyWhat>("watches");
  const [retry, setRetry] = useState(false);
  const route = COPY_ROUTES[what];
  const sources = useMemo(() => lanes.filter((lane) => route.from.has(lane.service)), [lanes, route]);
  const targets = useMemo(() => lanes.filter((lane) => !route.to || route.to.has(lane.service)), [lanes, route]);
  const [from, setFrom] = useState<string>(initial?.from ?? lanes.find((lane) => COPY_FROM.has(lane.service))?.key ?? "");
  const [to, setTo] = useState<string>(initial?.to ?? lanes.find((lane) => lane.key !== (initial?.from ?? lanes.find((l) => COPY_FROM.has(l.service))?.key))?.key ?? "");
  const [range, setRange] = useState<Range>("all");
  const [sinceDay, setSinceDay] = useState(() => new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10));
  const [preview, setPreview] = useState<JellyfinCopyPreview | null>(null);
  const [comparing, setComparing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, JellyfinCopyNamed>>({});
  const [shown, setShown] = useState(60);
  const [starting, setStarting] = useState(false);
  const actions = useJellyfinSyncActions();
  const { data: jobsData, refetch: refetchJobs } = useJellyfinCopyJobs(userUUID, true, { activeTab });
  const jobs = useMemo(() => jobsData?.jobs ?? [], [jobsData]);
  const live = jobs.some((job) => job.status === "running");
  const busy = jobs.find((job) => (job.status === "running" || job.status === "paused") && job.from === from && job.to === to && (job.what ?? "watches") === what) ?? null;
  const busyId = busy?.id ?? null;

  useEffect(() => {
    if (initial) {
      setFrom(initial.from);
      setTo(initial.to);
    }
  }, [initial]);

  useEffect(() => {
    if (!sources.some((lane) => lane.key === from)) setFrom(sources.find((lane) => lane.key !== to)?.key ?? sources[0]?.key ?? "");
    if (!targets.some((lane) => lane.key === to)) setTo(targets.find((lane) => lane.key !== from)?.key ?? "");
  }, [sources, targets, from, to]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void refetchJobs(), 3000);
    return () => window.clearInterval(timer);
  }, [live, refetchJobs]);

  const since = range === "since" ? new Date(`${sinceDay}T00:00:00`).getTime() : 0;
  const fromLane = lanes.find((lane) => lane.key === from);
  const toLane = lanes.find((lane) => lane.key === to);

  useEffect(() => {
    if (!from || !to || from === to || busyId !== null) {
      setPreview(null);
      return;
    }
    let gone = false;
    setComparing(true);
    setFailure(null);
    actions.copyPreview(userUUID, { profile, from, to, since, what, retry })
      .then((next) => {
        if (gone) return;
        setPreview(next);
        setNames(next.named);
        setPicked(new Set());
        setShown(60);
      })
      .catch((error) => { if (!gone) setFailure(error instanceof Error ? error.message : "Could not compare the trackers"); })
      .finally(() => { if (!gone) setComparing(false); });
    return () => { gone = true; };
  }, [actions, userUUID, profile, from, to, since, what, busyId, retry]);

  useEffect(() => {
    setRetry(false);
  }, [from, to, since, what]);

  const visible = useMemo(() => preview?.titles.slice(0, shown) ?? [], [preview, shown]);
  useEffect(() => {
    const unnamed = visible.map((t) => t.video).filter((video) => !(video in names)).slice(0, 60);
    if (!unnamed.length) return;
    let gone = false;
    actions.copyDescribe(userUUID, unnamed).then((more) => { if (!gone) setNames((held) => ({ ...held, ...more })); }).catch(() => undefined);
    return () => { gone = true; };
  }, [actions, names, visible, userUUID]);

  const chosen = range === "pick" ? (preview?.titles.filter((t) => picked.has(t.id)) ?? []) : (preview?.titles ?? []);
  const chosenWatches = chosen.reduce((sum, t) => sum + t.count, 0);
  const marks = what !== "watches";
  const refused = marks ? (preview?.totals.reasons?.refused ?? 0) : (preview?.totals.blocked?.refused ?? 0);
  const retryControl = retry
    ? <p>Watches sent before that didn't land are included this time. <button type="button" onClick={() => setRetry(false)} className="font-semibold text-blue-300 hover:text-blue-200">Leave them out</button></p>
    : refused > 0 ? <p><button type="button" onClick={() => setRetry(true)} className="font-semibold text-blue-300 hover:text-blue-200">Try the {refused.toLocaleString()} sent before again</button></p> : null;
  const posters = (preview?.titles ?? []).slice(0, 8).map((t) => names[t.video]?.posterUrl ?? names[t.video]?.imageUrl).filter(Boolean) as string[];
  const toName = toLane ? nameOf(toLane.service) : "";
  const fromName = fromLane ? nameOf(fromLane.service) : "";

  const swappable = Boolean(toLane && fromLane && route.from.has(toLane.service) && (!route.to || route.to.has(fromLane.service)));
  const swap = () => {
    if (!swappable) return;
    setFrom(to);
    setTo(from);
  };

  const start = async () => {
    if (!preview || !chosenWatches) return;
    setStarting(true);
    try {
      await actions.copyStart(userUUID, { profile, from, to, since, titles: range === "pick" ? [...picked] : null, what, retry });
      toast.success(`Copying ${nounOf(what, chosenWatches)} to ${toName}`, { description: "It runs in the background; you can leave this page." });
      await refetchJobs();
      setPreview(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The copy could not start");
    } finally {
      setStarting(false);
    }
  };

  const control = async (id: number, action: "pause" | "resume" | "stop") => {
    try {
      await actions.copyControl(userUUID, id, action);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the copy");
    } finally {
      void refetchJobs();
    }
  };

  if (!lanes.some((lane) => COPY_FROM.has(lane.service))) return <p className="text-sm text-muted-foreground">Copying starts from MDBList, Simkl or PublicMetaDB; connect one to copy its history to another tracker.</p>;

  const running = jobs.filter((job) => job.status === "running" || job.status === "paused");
  const recent = jobs.filter((job) => !running.includes(job)).slice(0, 3);

  return (
    <div className="flex flex-col gap-6">
      {running.map((job) => <JobCard key={job.id} job={job} onControl={(id, action) => void control(id, action)} />)}

      <div className="grid grid-cols-1 items-center gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Side label="From" lane={fromLane} lanes={sources.filter((lane) => lane.key !== to)} onPick={setFrom} />
        <button type="button" onClick={swap} disabled={!swappable} aria-label="Swap from and to" title={swappable ? "Swap" : `${toName} can only be copied to`} className="mx-auto flex size-12 items-center justify-center rounded-full border border-blue-400/30 bg-blue-500/10 text-blue-200 transition hover:bg-blue-500/20 disabled:opacity-40">
          <ArrowLeftRight className="size-4" />
        </button>
        <Side label="To" lane={toLane} lanes={targets.filter((lane) => lane.key !== from)} onPick={setTo} accent />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Toggle<JellyfinCopyWhat> value={what} onChange={setWhat} options={[["watches", History, "Watches"], ["ratings", Star, "Ratings"], ["watchlist", Bookmark, "Watchlist"], ["dropped", Ban, "Dropped"]]} />
        <Toggle<Range> value={range} onChange={setRange} options={[["all", Everything, "Everything"], ["since", CalendarDays, "Since a date"], ["pick", ListChecks, "Pick titles"]]} />
        {range === "since" && (
          <label className="glass flex h-9 items-center gap-2 rounded-full px-3 text-sm">
            <span className="text-muted-foreground">Since</span>
            <input type="date" value={sinceDay} max={new Date().toISOString().slice(0, 10)} onChange={(event) => event.target.value && setSinceDay(event.target.value)} className="bg-transparent text-foreground outline-none [color-scheme:dark]" />
          </label>
        )}
        <span className="text-xs text-muted-foreground">{what === "watches" ? "Watch history, each watch with its own date" : what === "ratings" ? "Ratings, each with the date it was given" : what === "watchlist" ? "Watchlist, each title with the date it was added" : "Dropped shows"}</span>
      </div>

      <div className="flex min-w-0 flex-col gap-5 rounded-2xl border border-white/[0.07] bg-black/20 p-5 backdrop-blur-sm sm:p-6">
        {busy ? (
          <p className="text-sm text-muted-foreground">{busy.status === "paused" ? "A copy" : "Copying"} from {fromName} to {toName}{busy.status === "paused" ? " is paused" : ""}, see the progress above. The comparison comes back when it's done.</p>
        ) : !sources.length ? (
          <p className="text-sm text-muted-foreground">{what === "ratings" ? "Ratings copy from MDBList or Simkl. PublicMetaDB has no way to list the ratings you've given." : "Connect MDBList, Simkl or PublicMetaDB to copy from."}</p>
        ) : failure ? (
          <p className="text-sm text-red-300">{failure}</p>
        ) : comparing || !preview ? (
          <div className="flex flex-col gap-4">
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Comparing {fromName} with {toName}…</p>
            <Skeleton className="h-16 w-2/3 rounded-xl" />
            <Skeleton className="h-36 rounded-xl" />
          </div>
        ) : !preview.titles.length ? (
          <div className="space-y-1">
            <p className="text-sm text-emerald-200/90">{toName} already has {what === "watches" ? "everything" : what === "ratings" ? "every rating" : what === "watchlist" ? "every watchlist title" : "every dropped show"} {fromName} has{range === "since" ? ` since ${shortDay(since)}` : ""}{preview.totals.excluded || preview.totals.blocked?.noId || preview.totals.blocked?.refused ? " that it can take" : ""}.</p>
            {!marks && (preview.totals.blocked?.noId ?? 0) > 0 && <p className="text-xs text-muted-foreground">{plural(preview.totals.blocked!.noId, "watch", "watches")} can't be copied: {toName} has no id for {preview.totals.blocked!.noId === 1 ? "it" : "them"}.</p>}
            {!marks && (preview.totals.blocked?.refused ?? 0) > 0 && <p className="text-xs text-muted-foreground">{plural(preview.totals.blocked!.refused, "watch", "watches")} {preview.totals.blocked!.refused === 1 ? "was" : "were"} sent before and {toName} didn't take {preview.totals.blocked!.refused === 1 ? "it" : "them"}.</p>}
            {retryControl && <div className="text-xs">{retryControl}</div>}
            {marks && preview.totals.excluded > 0 && Object.entries(preview.totals.reasons ?? {}).map(([reason, n]) => <p key={reason} className="text-xs text-muted-foreground">{plural(n, "title")} {REASONS[reason] ?? reason}, so {n === 1 ? "it stays" : "they stay"} out.</p>)}
          </div>
        ) : (
          <>
            <Eyebrow>{toName} will get</Eyebrow>
            <div className="flex flex-wrap gap-x-9 gap-y-3">
              {(marks
                ? ([[preview.totals.films, "film", "films"], [preview.totals.shows ?? 0, "show", "shows"], [preview.totals.seasons ?? 0, "season", "seasons"], [preview.totals.episodes, "episode", "episodes"]] as const).filter(([n], i) => n > 0 || i < 2)
                : ([[preview.totals.films, "film", "films"], [preview.totals.episodes, ANIME_ONLY.has(toLane?.service ?? "") ? "show's progress" : "episode", ANIME_ONLY.has(toLane?.service ?? "") ? "shows' progress" : "episodes"], [preview.totals.titles, "title", "titles"]] as const)
              ).map(([n, one, many]) => (
                <div key={many}>
                  <p className="text-3xl font-extrabold tabular-nums tracking-tight">{n.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">{n === 1 ? one : many}</p>
                </div>
              ))}
            </div>
            {range !== "pick" && posters.length > 0 && (
              <div className="flex items-center">
                {posters.map((src) => <img key={src} src={src} alt="" loading="lazy" className="-mr-5 aspect-[2/3] w-16 rounded-lg border-[3px] border-background object-cover shadow-xl shadow-black/50 sm:w-20" />)}
                {preview.totals.titles > posters.length && <span className="ml-9 text-sm text-muted-foreground">and {plural(preview.totals.titles - posters.length, "more title", "more titles")}</span>}
              </div>
            )}
            {range === "pick" && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <Eyebrow>Pick titles <span className="tabular-nums opacity-70">({picked.size} of {preview.titles.length})</span></Eyebrow>
                  <span className="flex gap-3 text-xs font-semibold text-blue-300">
                    <button type="button" onClick={() => setPicked(new Set(preview.titles.map((t) => t.id)))} className="hover:text-blue-200">All</button>
                    <button type="button" onClick={() => setPicked(new Set())} className="hover:text-blue-200">None</button>
                  </span>
                </div>
                <div className="max-h-[420px] space-y-1 overflow-y-auto pr-1 [scrollbar-width:thin]">
                  {visible.map((t) => {
                    const on = picked.has(t.id);
                    const n = names[t.video];
                    return (
                      <label key={t.id} className={cx("flex cursor-pointer items-center gap-3.5 rounded-xl p-1.5 pr-3 transition-colors", on ? "bg-blue-500/[0.1] ring-1 ring-inset ring-blue-400/30" : "hover:bg-white/[0.04]")}>
                        <input type="checkbox" checked={on} onChange={() => setPicked((held) => { const next = new Set(held); if (next.has(t.id)) next.delete(t.id); else next.add(t.id); return next; })} className="size-4 shrink-0 accent-blue-500" />
                        <Still src={n?.imageUrl ?? null} className="w-20 rounded-lg sm:w-24" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{n?.title ?? (n ? "Unknown title" : "…")}</span>
                          <span className="block text-xs text-muted-foreground">{marks ? markLine(t, what) : <>{t.kind === "movie" ? "Film" : plural(t.count, "episode")}{t.lastAt ? ` · last ${shortDay(t.lastAt)}` : ""}</>}</span>
                        </span>
                      </label>
                    );
                  })}
                  {preview.titles.length > shown && <button type="button" onClick={() => setShown((n) => n + 60)} className="w-full py-2 text-xs font-medium text-muted-foreground hover:text-foreground">Show more</button>}
                </div>
              </div>
            )}
            <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
              {what === "watches" && <p>Each watch keeps the date {fromName} has, and anything not yet in your history comes in too. Nothing is removed from {toName}, and what it already has is skipped, so copying again is safe.</p>}
              {what === "ratings" && <p>Each rating keeps the date {fromName} has. Titles {toName} has already rated keep their own rating, so copying again is safe.{toLane?.service === "simkl" ? " Simkl rates in whole numbers, so half points are rounded." : ""}</p>}
              {what === "watchlist" && <p>Titles already on {toName}{toLane?.service === "simkl" ? " or anywhere in your Simkl library" : ""} are skipped, and nothing is removed from it, so copying again is safe.</p>}
              {what === "dropped" && <p>Shows {toName} already has as dropped are skipped. Your watch history on {toName} stays as it is.</p>}
              {marks && preview.totals.excluded > 0 && Object.entries(preview.totals.reasons ?? {}).map(([reason, n]) => <p key={reason}>{plural(n, "title")} {REASONS[reason] ?? reason}, so {n === 1 ? "it stays" : "they stay"} out.</p>)}
              {what === "ratings" && toLane?.service === "publicmetadb" && chosenWatches > 20 && <p>{toName} takes 200 new ratings an hour, so this runs for about {Math.max(1, Math.round(chosenWatches / 200))} {Math.round(chosenWatches / 200) <= 1 ? "hour" : "hours"}.</p>}
              {!marks && (preview.totals.blocked?.noId ?? 0) > 0 && <p>{plural(preview.totals.blocked!.noId, "watch", "watches")} can't be copied: {toName} has no id for {preview.totals.blocked!.noId === 1 ? "it" : "them"}.</p>}
              {!marks && (preview.totals.blocked?.refused ?? 0) > 0 && <p>{plural(preview.totals.blocked!.refused, "watch", "watches")} {preview.totals.blocked!.refused === 1 ? "was" : "were"} sent before and {toName} didn't take {preview.totals.blocked!.refused === 1 ? "it" : "them"}, so {preview.totals.blocked!.refused === 1 ? "it stays" : "they stay"} out.</p>}
              {retryControl}
              {!marks && preview.totals.excluded > 0 && <p>{plural(preview.totals.excluded, "watch", "watches")} {ANIME_ONLY.has(toLane?.service ?? "") ? "aren't anime" : `are turned off for ${toName} in your tracking settings`}, so {preview.totals.excluded === 1 ? "it stays" : "they stay"} out.</p>}
              {!marks && toLane?.service === "publicmetadb" && chosenWatches > 200 && <p>{toName} takes one watch at a time, so this runs for about {Math.max(1, Math.round(chosenWatches / 4 / 60))} {Math.round(chosenWatches / 4 / 60) <= 1 ? "minute" : "minutes"}.</p>}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
              <span className="text-xs text-muted-foreground">Runs in the background; you can leave this page.</span>
              <button type="button" onClick={() => void start()} disabled={starting || !chosenWatches} className="flex h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-black shadow-lg shadow-black/30 transition hover:bg-white/90 active:scale-[0.98] disabled:opacity-50">
                {starting && <Loader2 className="size-4 animate-spin" />}
                {range === "pick" && !picked.size ? "Pick some titles" : `Copy ${nounOf(what, chosenWatches)}`}
              </button>
            </div>
          </>
        )}
      </div>

      {recent.length > 0 && (
        <div className="space-y-2">
          <Eyebrow>Earlier copies</Eyebrow>
          {recent.map((job) => <JobCard key={job.id} job={job} onControl={(id, action) => void control(id, action)} />)}
        </div>
      )}
    </div>
  );
}
