import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronDown, Film, Loader2, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useJellyfinSyncActions, useJellyfinTitle, type DashboardTab, type JellyfinMatchCandidate, type JellyfinMatchDetail, type JellyfinMatchSeason, type JellyfinTrackerMatch } from "@/hooks/useDashboardQueries";
import { Eyebrow } from "./TrackerParts";
import { useTrackers } from "./trackers";
import { GUESSED, LOOK, heldIn, keyOf, norm, planSeason, seasonLink, seasonName, sentKey, strayEpisodes, wordsOf, type OurEpisode, type Ref, type Row, type SeasonPlan, type Status, type TheirEpisode } from "./trackerMatchPlan";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export interface MatchSubject {
  item: string | null;
  bases: string[];
  kind: "movie" | "series";
  title: string | null;
  open: { id: string; type: "movie" | "series" } | null;
  seasons: number[];
  existing?: JellyfinTrackerMatch | null;
}

export function Poster({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  return src && !failed
    ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="aspect-[2/3] w-9 shrink-0 rounded-md object-cover" />
    : <span className="flex aspect-[2/3] w-9 shrink-0 items-center justify-center rounded-md bg-white/5"><Film className="size-4 text-muted-foreground" /></span>;
}

const KIND_LABEL: Record<string, string> = { tv: "Show", anime: "Anime", movie: "Film" };

type Order = "tmdb" | "tvdb";

const sentAs = (target: TheirEpisode) => (sentKey(target) === keyOf(target.season, target.number) ? null : target.sends.season === 0 ? `Special ${target.sends.episode}` : `S${target.sends.season}E${target.sends.episode}`);

function viewOf(seasons: JellyfinMatchSeason[]) {
  return {
    seasons,
    numbers: seasons.map((s) => s.number),
    theirs: seasons.flatMap((s) => s.episodes.map((e): TheirEpisode => {
      const normed = norm(e.title);
      return { season: s.number, number: e.number, title: e.title, airedAt: e.airedAt, sends: e.sends ?? { season: s.number, episode: e.number }, norm: normed, words: wordsOf(normed) };
    })),
  };
}

const MARK: Record<Status, { label: string; tone: string }> = {
  same: { label: "✓", tone: "bg-emerald-400/10 text-emerald-300" },
  number: { label: "#", tone: "bg-emerald-400/10 text-emerald-300" },
  chosen: { label: "✓", tone: "bg-white/10 text-foreground/80" },
  part: { label: "2:1", tone: "bg-blue-400/15 text-blue-300" },
  close: { label: "?", tone: "bg-amber-400/15 text-amber-300" },
  shift: { label: "?", tone: "bg-amber-400/15 text-amber-300" },
  missing: { label: "!", tone: "bg-amber-400/15 text-amber-300" },
  none: { label: "×", tone: "bg-white/5 text-muted-foreground" },
  later: { label: "…", tone: "bg-white/5 text-muted-foreground" },
};

export default function JellyfinTrackerMatch({ userUUID, profile, activeTab, laneKey, service, subject, onClose, onSaved }: {
  userUUID: string;
  profile: string | null;
  activeTab: DashboardTab;
  laneKey: string;
  service: string;
  subject: MatchSubject;
  onClose: () => void;
  onSaved: () => void;
}) {
  const name = useTrackers().name(service);
  const actions = useJellyfinSyncActions();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState(subject.title ?? "");
  const [results, setResults] = useState<JellyfinMatchCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<JellyfinMatchCandidate | null>(subject.existing?.target ?? null);
  const [changing, setChanging] = useState(!subject.existing);
  const [detail, setDetail] = useState<JellyfinMatchDetail | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [reading, setReading] = useState(false);
  const [chosen, setChosen] = useState<Record<string, Ref | null>>({});
  const [prefer, setPrefer] = useState<Record<number, number>>({});
  const [shown, setShown] = useState<number | null>(null);
  const [onlyLook, setOnlyLook] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [pickerSeason, setPickerSeason] = useState<number | null>(null);
  const [moveRest, setMoveRest] = useState(true);
  const [saving, setSaving] = useState(false);
  const series = subject.kind === "series";
  const { data: title, isLoading: titleLoading, isFetching: titleFetching, refetch: readTitle } = useJellyfinTitle(userUUID, profile, series ? subject.open : null, { activeTab });
  const pickedRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const ours = useMemo(() => {
    const out = new Map<number, OurEpisode[]>();
    for (const episode of title?.episodes ?? []) {
      if (episode.season === null || episode.season < 1 || episode.number === null) continue;
      out.set(episode.season, [...(out.get(episode.season) ?? []), { number: episode.number, name: episode.name, airsAt: episode.airsAt }]);
    }
    for (const season of subject.seasons) if (season > 0 && !out.has(season)) out.set(season, []);
    for (const list of out.values()) list.sort((a, b) => a.number - b.number);
    return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
  }, [title, subject.seasons]);

  const views = useMemo(() => ({
    tmdb: viewOf(detail?.seasons ?? []),
    tvdb: detail?.tvdbSeasons?.length ? viewOf(detail.tvdbSeasons) : null,
  }), [detail]);

  const sameTarget = Boolean(subject.existing && picked && JSON.stringify(subject.existing.target.ids) === JSON.stringify(picked.ids));
  const held = sameTarget ? subject.existing?.episodes ?? null : null;
  const links = useMemo(() => (sameTarget && !held ? subject.existing?.seasons ?? {} : {}), [sameTarget, held, subject.existing]);
  const heldBy = useMemo(() => ({
    tmdb: held,
    tvdb: held && views.tvdb ? heldIn(views.tvdb.theirs, held) : null,
  }), [held, views]);

  const auto = useMemo<Order>(() => {
    if (!series || !views.tvdb) return "tmdb";
    const now = Date.now();
    const score = (which: Order) => {
      const view = which === "tvdb" ? views.tvdb ?? views.tmdb : views.tmdb;
      const rows = [...ours.entries()].flatMap(([season, episodes]) =>
        planSeason(season, episodes, view.theirs, view.numbers, which === "tmdb" ? links[String(season)]?.season : undefined, {}, heldBy[which], now).rows);
      return {
        missing: rows.filter((r) => r.status === "missing").length,
        look: rows.filter((r) => LOOK.has(r.status)).length,
        aligned: rows.filter((r) => r.target && r.key === keyOf(r.target.season, r.target.number)).length,
      };
    };
    const tvdb = score("tvdb");
    const tmdb = score("tmdb");
    const gap = tvdb.missing - tmdb.missing || tvdb.look - tmdb.look || tmdb.aligned - tvdb.aligned;
    return gap < 0 || (gap === 0 && detail?.tvdbDefault) ? "tvdb" : "tmdb";
  }, [series, views, ours, links, heldBy, detail]);
  const shownOrder: Order = views.tvdb ? order ?? auto : "tmdb";
  const view = shownOrder === "tvdb" && views.tvdb ? views.tvdb : views.tmdb;
  const theirs = view.theirs;

  const plans = useMemo(() => {
    if (!series || !view.seasons.length) return [] as SeasonPlan[];
    const now = Date.now();
    return [...ours.entries()].map(([season, episodes]) =>
      planSeason(season, episodes, view.theirs, view.numbers, prefer[season] ?? (shownOrder === "tmdb" ? links[String(season)]?.season : undefined), chosen, heldBy[shownOrder], now));
  }, [series, view, ours, prefer, chosen, links, heldBy, shownOrder]);

  const plan = plans.find((p) => p.season === shown) ?? plans[0] ?? null;
  const strays = useMemo(() => strayEpisodes(plans, theirs, Date.now()), [plans, theirs]);
  const stray = plan ? strays.get(plan.theirs) ?? [] : [];
  const counts = (p: SeasonPlan) => ({
    look: p.rows.filter((r) => LOOK.has(r.status)).length,
    missing: p.rows.filter((r) => r.status === "missing").length,
  });
  const missingTotal = plans.reduce((sum, p) => sum + counts(p).missing, 0);
  const ready = Boolean(picked && detail && !reading && (!series || title) && missingTotal === 0);

  useEffect(() => {
    const text = query.trim();
    if (!changing || text.length < 2) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      actions.matchSearch(userUUID, laneKey, text, subject.kind)
        .then((found) => { if (!stale) setResults(found); })
        .catch((error) => { if (!stale) { setResults([]); toast.error(error instanceof Error ? error.message : `Could not search ${name}`); } })
        .finally(() => { if (!stale) setSearching(false); });
    }, 350);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [query, changing, userUUID, laneKey, subject.kind, actions, name]);

  useEffect(() => {
    if (!picked) return;
    let stale = false;
    setReading(true);
    setDetail(null);
    setOrder(null);
    setChosen({});
    setPrefer({});
    setOpenRow(null);
    actions.matchDetail(userUUID, laneKey, picked)
      .then((read) => { if (!stale) setDetail(read); })
      .catch((error) => { if (!stale) toast.error(error instanceof Error ? error.message : `Could not read it from ${name}`); })
      .finally(() => { if (!stale) setReading(false); });
    return () => { stale = true; };
  }, [picked, userUUID, laneKey, actions, name]);

  useEffect(() => {
    const list = listRef.current;
    const current = pickedRef.current;
    if (openRow && list && current) list.scrollTop = current.offsetTop - list.clientHeight / 2 + current.clientHeight / 2;
  }, [openRow, pickerSeason]);

  const pick = (candidate: JellyfinMatchCandidate) => {
    setPicked(candidate);
    setChanging(false);
  };

  const openPicker = (row: Row) => {
    if (openRow === row.key) {
      setOpenRow(null);
      return;
    }
    setOpenRow(row.key);
    setPickerSeason(row.target?.season ?? plan?.theirs ?? null);
    setMoveRest(true);
  };

  const later = (row: Row) => (plan ? plan.rows.filter((r) => r.ours.number > row.ours.number && GUESSED.has(r.status)) : []);

  const choose = (row: Row, target: TheirEpisode | null) => {
    const next: Record<string, Ref | null> = { ...chosen, [row.key]: target ? { season: target.season, episode: target.number } : null };
    if (target && moveRest) {
      for (const r of later(row)) {
        const moved = theirs.find((t) => t.season === target.season && t.number === target.number + (r.ours.number - row.ours.number));
        if (moved) next[r.key] = { season: moved.season, episode: moved.number };
      }
    }
    setChosen(next);
    setOpenRow(null);
  };

  const switchOrder = (next: Order) => {
    if (next === shownOrder) return;
    setOrder(next);
    setChosen({});
    setPrefer({});
    setOpenRow(null);
    setPickerSeason(null);
  };

  const linkSeason = (season: number, theirSeason: number) => {
    setPrefer({ ...prefer, [season]: theirSeason });
    setChosen(Object.fromEntries(Object.entries(chosen).filter(([key]) => !key.startsWith(`${season}:`))));
    setOpenRow(null);
  };

  const save = async () => {
    if (!picked || !detail) return;
    setSaving(true);
    try {
      const seasons: Record<string, { season: number; offset: number }> = {};
      const episodes: Record<string, Ref | null> = {};
      for (const p of plans) {
        for (const row of p.rows) {
          if (row.status === "later") continue;
          episodes[row.key] = row.target ? { ...row.target.sends } : null;
        }
        seasons[String(p.season)] = seasonLink(p, theirs);
      }
      const { sent } = await actions.matchSave(userUUID, {
        key: laneKey,
        item: subject.item,
        bases: subject.bases,
        kind: subject.kind,
        title: subject.title,
        open: subject.open,
        target: { ...picked, ids: detail.ids },
        seasons: series ? seasons : {},
        ...(series ? { episodes } : {}),
      });
      toast.success(`Matched to ${picked.title} on ${name}`, { description: sent ? `Sending ${sent} ${sent === 1 ? "watch" : "watches"} again` : `Nothing left to send to ${name}` });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", "jellyfin", "sync"] });
      onSaved();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the match");
    } finally {
      setSaving(false);
    }
  };

  const tally = plan ? {
    same: plan.rows.filter((r) => r.status === "same" || r.status === "number" || r.status === "chosen").length,
    parts: plan.rows.filter((r) => r.status === "part").length,
    look: counts(plan).look,
    none: plan.rows.filter((r) => r.status === "none").length,
    later: plan.rows.filter((r) => r.status === "later").length,
  } : null;
  const visible = plan ? plan.rows.filter((r) => !onlyLook || LOOK.has(r.status) || r.key === openRow) : [];
  const theirCount = (season: number) => view.seasons.find((s) => s.number === season)?.episodes.length ?? 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Match on {name}</DialogTitle>
          <DialogDescription>
            {subject.title ? <span className="font-medium text-foreground">{subject.title}</span> : "This title"}: pick what {name} files it under{series ? ", then check each episode lands on the right one" : ""}. Everything sent to {name} for it then uses that.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {picked && !changing ? (
            <div className="flex items-center gap-3 rounded-xl bg-blue-500/10 p-1.5 ring-1 ring-inset ring-blue-400/30">
              <Poster src={picked.posterUrl} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{picked.title}{picked.year ? <span className="font-normal text-muted-foreground"> ({picked.year})</span> : null}</span>
                <span className="block text-xs text-muted-foreground">{[KIND_LABEL[picked.kind] ?? picked.kind, view.seasons.length ? `${view.seasons.length} ${view.seasons.length === 1 ? "season" : "seasons"}` : null, theirs.length ? `${theirs.length} episodes` : null].filter(Boolean).join(" · ")}</span>
              </span>
              <button type="button" onClick={() => setChanging(true)} className="h-8 shrink-0 rounded-full px-3.5 text-xs font-medium ring-1 ring-inset ring-white/15 transition-colors hover:bg-white/10">Change</button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${name}`} className="pl-9" aria-label={`Search ${name}`} autoFocus />
                {searching && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {results === null && searching && [0, 1, 2].map((i) => <Skeleton key={i} className="h-14 rounded-xl" />)}
                {results?.length === 0 && !searching && <p className="px-1 py-2 text-xs text-muted-foreground">Nothing on {name} by that name.</p>}
                {results?.map((candidate) => {
                  const active = picked && JSON.stringify(picked.ids) === JSON.stringify(candidate.ids);
                  return (
                    <button
                      key={JSON.stringify(candidate.ids)}
                      type="button"
                      onClick={() => pick(candidate)}
                      className={cx("flex w-full items-center gap-3 rounded-xl p-1.5 text-left transition-colors", active ? "bg-blue-500/15 ring-1 ring-inset ring-blue-400/40" : "hover:bg-white/[0.05]")}
                    >
                      <Poster src={candidate.posterUrl} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{candidate.title}{candidate.year ? <span className="font-normal text-muted-foreground"> ({candidate.year})</span> : null}</span>
                        <span className="block text-xs text-muted-foreground">{[KIND_LABEL[candidate.kind] ?? candidate.kind, candidate.episodes ? `${candidate.episodes} episodes` : null].filter(Boolean).join(" · ")}</span>
                      </span>
                      {active && <Check className="size-4 shrink-0 text-blue-300" />}
                    </button>
                  );
                })}
              </div>
              {picked && <button type="button" onClick={() => setChanging(false)} className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Keep {picked.title}</button>}
            </div>
          )}

          {picked && series && !changing && (
            reading || titleLoading ? (
              <Skeleton className="h-64 rounded-xl" />
            ) : !title ? (
              <p className="text-xs text-muted-foreground">
                Could not read the episodes here, so they can't be lined up with {name}'s.{" "}
                <button type="button" onClick={() => void readTitle()} disabled={titleFetching} className="font-medium text-foreground underline-offset-4 hover:underline disabled:opacity-50">Try again</button>
              </p>
            ) : !view.seasons.length ? (
              <p className="text-xs text-muted-foreground">{name} lists no episodes for {picked.title}, so episodes keep their numbers.</p>
            ) : plan && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Eyebrow>Seasons</Eyebrow>
                    {views.tvdb && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{name}'s order</span>
                        <div className="flex gap-1 rounded-full bg-white/[0.05] p-0.5" role="group" aria-label={`${name} episode order`}>
                          {(["tvdb", "tmdb"] as const).map((which) => (
                            <button key={which} type="button" aria-pressed={shownOrder === which} onClick={() => switchOrder(which)} className={cx("h-7 rounded-full px-3 text-xs", shownOrder === which ? "bg-white/10 font-medium text-foreground" : "text-muted-foreground")}>
                              {which === "tvdb" ? "TVDB" : "TMDB"}{which === auto && order !== null && order !== auto ? " · lines up better" : ""}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {plans.map((p) => {
                      const { look } = counts(p);
                      const theirTotal = theirCount(p.theirs);
                      return (
                        <button
                          key={p.season}
                          type="button"
                          onClick={() => { setShown(p.season); setOpenRow(null); }}
                          aria-pressed={p === plan}
                          className={cx("flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium ring-1 ring-inset transition-colors", p === plan ? "bg-blue-500/15 text-foreground ring-blue-400/50" : "bg-white/[0.04] text-foreground/80 ring-white/10 hover:bg-white/[0.08]")}
                        >
                          Season {p.season}
                          {look
                            ? <span className="rounded-full bg-amber-400/15 px-1.5 text-[11px] text-amber-300">{look} to check</span>
                            : <span className="text-[11px] text-muted-foreground">{p.rows.length === theirTotal || !p.rows.length ? p.rows.length || theirTotal : `${p.rows.length} → ${theirTotal}`}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">Season {plan.season} here</span>
                    <span className="text-muted-foreground">is {name}'s</span>
                    <select
                      value={plan.theirs}
                      onChange={(event) => linkSeason(plan.season, Number(event.target.value))}
                      aria-label={`${name} season for season ${plan.season}`}
                      className="h-8 rounded-lg border border-white/[0.12] bg-background px-2 text-xs"
                    >
                      {view.seasons.map((s) => <option key={s.number} value={s.number}>{seasonName(s.number)} ({s.episodes.length} episodes)</option>)}
                    </select>
                  </div>
                  <div className="flex gap-1 rounded-full bg-white/[0.05] p-0.5" role="group" aria-label="Rows shown">
                    <button type="button" aria-pressed={!onlyLook} onClick={() => setOnlyLook(false)} className={cx("h-7 rounded-full px-3 text-xs", !onlyLook ? "bg-white/10 font-medium text-foreground" : "text-muted-foreground")}>All {plan.rows.length}</button>
                    <button type="button" aria-pressed={onlyLook} onClick={() => setOnlyLook(true)} className={cx("h-7 rounded-full px-3 text-xs", onlyLook ? "bg-white/10 font-medium text-foreground" : "text-muted-foreground")}>Needs a look · {tally?.look ?? 0}</button>
                  </div>
                </div>

                {tally && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {tally.same > 0 && <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-emerald-400" />{tally.same} line up</span>}
                    {tally.parts > 0 && <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-blue-400" />{tally.parts} parts of {new Set(plan.rows.filter((r) => r.status === "part").map((r) => r.target && sentKey(r.target))).size} {name} episodes, each sent once</span>}
                    {tally.look > 0 && <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-amber-400" />{tally.look} to check</span>}
                    {tally.none > 0 && <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-white/30" />{tally.none} not sent</span>}
                    {tally.later > 0 && <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-white/20" />{tally.later} not aired yet</span>}
                  </div>
                )}

                <div className="overflow-hidden rounded-xl border border-white/[0.08]">
                  <div className="hidden grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] gap-2.5 bg-white/[0.03] px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground sm:grid">
                    <span>Here</span><span /><span>Sent to {name} as</span>
                  </div>
                  {!plan.rows.length && <p className="px-3 py-3 text-xs text-muted-foreground">No episode list here for this season.</p>}
                  {plan.rows.length > 0 && !visible.length && <p className="px-3 py-3 text-xs text-muted-foreground">Every episode in this season lines up.</p>}
                  {visible.map((row) => {
                    const mark = MARK[row.status];
                    const look = LOOK.has(row.status);
                    const open = openRow === row.key;
                    const moving = open ? later(row).length : 0;
                    const listed = open ? theirs.filter((t) => t.season === (pickerSeason ?? plan.theirs)) : [];
                    const sent = row.target ? sentAs(row.target) : null;
                    return (
                      <div key={row.key} className={cx("border-t border-white/[0.05]", look && "bg-amber-400/[0.04]")}>
                        <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_28px] items-center gap-x-2.5 gap-y-1.5 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] sm:py-1">
                          <span className="flex min-w-0 items-center gap-2 text-[13px]">
                            <span className="w-8 shrink-0 tabular-nums text-muted-foreground">E{row.ours.number}</span>
                            <span className="truncate">{row.ours.name ?? ""}</span>
                          </span>
                          <span className={cx("flex h-5 items-center justify-center rounded-full text-[10px] font-bold", mark.tone)} aria-hidden="true">{mark.label}</span>
                          <span className="col-span-2 flex min-w-0 items-center gap-2 sm:col-span-1">
                            <button
                              type="button"
                              onClick={() => openPicker(row)}
                              aria-expanded={open}
                              aria-label={`${name} episode for E${row.ours.number}`}
                              className={cx("flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[13px] ring-1 ring-inset transition-colors", look ? "ring-amber-300/50" : "ring-white/[0.08] hover:ring-white/20", open && "bg-white/[0.06]")}
                            >
                              {row.target
                                ? <>
                                    <span className="shrink-0 self-start tabular-nums leading-7 text-muted-foreground">{row.target.season !== plan.theirs ? `S${row.target.season} ` : ""}E{row.target.number}</span>
                                    <span className="min-w-0">
                                      <span className="block truncate leading-7">{row.target.title ?? ""}</span>
                                      {sent && <span className="-mt-1 block text-[11px] tabular-nums text-muted-foreground">sent as TMDB {sent}</span>}
                                    </span>
                                  </>
                                : <span className={cx("truncate", row.status === "missing" ? "text-amber-200" : "text-muted-foreground")}>{row.status === "none" ? "Not sent" : row.status === "later" ? "Follows the season once it airs" : "Pick an episode"}</span>}
                              <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                            </button>
                            <span className="hidden w-20 shrink-0 sm:block">
                              {row.status === "part" && <span className="rounded-full bg-blue-400/15 px-2 py-0.5 text-[11px] text-blue-300">part {row.part}</span>}
                              {row.status === "close" && <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] text-amber-300">close title</span>}
                              {row.status === "shift" && <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] text-amber-300">by number</span>}
                            </span>
                          </span>
                        </div>
                        {open && (
                          <div className="mx-3 mb-3 space-y-1 rounded-xl bg-background p-1.5 ring-1 ring-inset ring-white/[0.12] sm:ml-[calc(50%+20px)]">
                            {view.seasons.length > 1 && (
                              <select
                                value={pickerSeason ?? plan.theirs}
                                onChange={(event) => setPickerSeason(Number(event.target.value))}
                                aria-label={`${name} season to pick from`}
                                className="h-8 w-full rounded-lg border border-white/[0.12] bg-background px-2 text-xs"
                              >
                                {view.seasons.map((s) => <option key={s.number} value={s.number}>{seasonName(s.number)}</option>)}
                              </select>
                            )}
                            <div ref={listRef} className="relative max-h-56 overflow-y-auto">
                              {listed.map((t) => {
                                const current = row.target === t;
                                const as = sentAs(t);
                                return (
                                  <button
                                    key={keyOf(t.season, t.number)}
                                    ref={current ? pickedRef : undefined}
                                    type="button"
                                    onClick={() => choose(row, t)}
                                    className={cx("flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors", current ? "bg-blue-500/20" : "hover:bg-white/[0.06]")}
                                  >
                                    <span className="w-8 shrink-0 tabular-nums text-muted-foreground">E{t.number}</span>
                                    <span className="truncate">{t.title ?? ""}</span>
                                    {as && <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">sent as TMDB {as}</span>}
                                    {current && <Check className={cx("size-3.5 shrink-0 text-blue-300", !as && "ml-auto")} />}
                                  </button>
                                );
                              })}
                            </div>
                            <div className="mx-1.5 h-px bg-white/[0.08]" />
                            <button type="button" onClick={() => choose(row, null)} className="flex min-h-9 w-full items-center rounded-lg px-2.5 text-left text-[13px] hover:bg-white/[0.06]">Not on {name}, don't send it</button>
                            {moving > 0 && (
                              <label className="flex min-h-9 items-center gap-2 px-2.5 text-xs text-muted-foreground">
                                <input type="checkbox" checked={moveRest} onChange={(event) => setMoveRest(event.target.checked)} className="accent-blue-500" />
                                Move the {moving} unconfirmed {moving === 1 ? "episode" : "episodes"} after it by the same step
                              </label>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {stray.length > 0 && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Nothing here points at {stray.slice(0, 4).map((t) => `E${t.number}${t.title ? ` ${t.title}` : ""}`).join(", ")}{stray.length > 4 ? ` and ${stray.length - 4} more` : ""} in {name}'s {plan.theirs === 0 ? "specials" : `season ${plan.theirs}`}, so {stray.length === 1 ? "it isn't" : "they aren't"} marked from here.
                  </p>
                )}
                <p className="text-xs leading-relaxed text-muted-foreground">Episodes are matched by title. When {name} has one episode for two parts here, part 1 sends it and part 2 sends nothing.{shownOrder === "tvdb" ? ` In TVDB order, each episode is still sent as the TMDB episode ${name} links it to.` : ""}</p>
              </div>
            )
          )}

          {missingTotal > 0 && (
            <p className="rounded-xl bg-amber-400/[0.08] px-3.5 py-2.5 text-xs leading-relaxed text-amber-100 ring-1 ring-inset ring-amber-300/20">
              {plans.filter((p) => counts(p).missing).map((p) => `season ${p.season}: ${counts(p).missing}`).join(", ").replace(/^s/, "S")} {missingTotal === 1 ? "episode has" : "episodes have"} no {name} episode yet. Pick one, or choose "Not on {name}".
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-9 rounded-full px-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">Cancel</button>
            <button type="button" onClick={() => void save()} disabled={!ready || saving || changing} className="flex h-9 items-center gap-2 rounded-full bg-blue-500/90 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50">
              {saving && <Loader2 className="size-3.5 animate-spin" />} {subject.item ? "Save and send" : "Save"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
