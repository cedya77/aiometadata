import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Film, Loader2, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useJellyfinSyncActions, useJellyfinTitle, type DashboardTab, type JellyfinMatchCandidate, type JellyfinMatchSeason, type JellyfinTrackerMatch } from "@/hooks/useDashboardQueries";
import { Eyebrow } from "./TrackerParts";
import { nameOf } from "./trackerNames";

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

type Links = Record<string, { season: number; offset: number }>;

export function Poster({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  return src && !failed
    ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="aspect-[2/3] w-9 shrink-0 rounded-md object-cover" />
    : <span className="flex aspect-[2/3] w-9 shrink-0 items-center justify-center rounded-md bg-white/5"><Film className="size-4 text-muted-foreground" /></span>;
}

const KIND_LABEL: Record<string, string> = { tv: "Show", anime: "Anime", movie: "Film" };
const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

type OurEpisode = { number: number; name: string | null; airsAt: number | null };

function guessLinks(ours: Map<number, OurEpisode[]>, theirs: JellyfinMatchSeason[], held: Links | null): Links {
  const out: Links = {};
  for (const [season, episodes] of ours) {
    if (held?.[String(season)]) {
      out[String(season)] = held[String(season)];
      continue;
    }
    let found: { season: number; offset: number } | null = null;
    for (let i = 0; i < Math.min(episodes.length, 6) && !found; i += 1) {
      const episode = episodes[i];
      const next = episodes[i + 1];
      for (const target of theirs) {
        const hit = target.episodes.find((e) => same(e.title, episode.name));
        if (!hit) continue;
        const after = next ? target.episodes.find((e) => e.number === hit.number + (next.number - episode.number)) : null;
        if (next && !same(after?.title, next.name)) continue;
        found = { season: target.number, offset: hit.number - episode.number };
        break;
      }
    }
    out[String(season)] = found ?? { season: theirs.some((t) => t.number === season) ? season : theirs[0]?.number ?? season, offset: 0 };
  }
  return out;
}

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
  const name = nameOf(service);
  const actions = useJellyfinSyncActions();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState(subject.title ?? "");
  const [results, setResults] = useState<JellyfinMatchCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<JellyfinMatchCandidate | null>(subject.existing?.target ?? null);
  const [detail, setDetail] = useState<{ ids: Record<string, string | number>; seasons: JellyfinMatchSeason[] } | null>(null);
  const [reading, setReading] = useState(false);
  const [links, setLinks] = useState<Links | null>(null);
  const [preview, setPreview] = useState<number | null>(subject.seasons[0] ?? null);
  const [saving, setSaving] = useState(false);
  const series = subject.kind === "series";
  const { data: title, isLoading: titleLoading } = useJellyfinTitle(userUUID, profile, series ? subject.open : null, { activeTab });

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

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      actions.matchSearch(userUUID, laneKey, text, subject.kind)
        .then((found) => { if (!stale) setResults(found); })
        .catch((error) => { if (!stale) { setResults([]); toast.error(error instanceof Error ? error.message : `Could not search ${name}`); } })
        .finally(() => { if (!stale) setSearching(false); });
    }, 350);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [query, userUUID, laneKey, subject.kind, actions, name]);

  useEffect(() => {
    if (!picked) return;
    let stale = false;
    setReading(true);
    setDetail(null);
    actions.matchDetail(userUUID, laneKey, picked)
      .then((read) => { if (!stale) setDetail(read); })
      .catch((error) => { if (!stale) toast.error(error instanceof Error ? error.message : `Could not read it from ${name}`); })
      .finally(() => { if (!stale) setReading(false); });
    return () => { stale = true; };
  }, [picked, userUUID, laneKey, actions, name]);

  useEffect(() => {
    if (!detail || !series || titleLoading) return;
    const sameTarget = subject.existing && picked && JSON.stringify(subject.existing.target.ids) === JSON.stringify(picked.ids);
    setLinks(guessLinks(ours, detail.seasons, sameTarget ? subject.existing!.seasons : null));
  }, [detail, ours, series, titleLoading, subject.existing, picked]);

  const theirSeason = (number: number) => detail?.seasons.find((s) => s.number === number) ?? null;
  const shown = preview ?? [...ours.keys()][0] ?? null;
  const pointless = useMemo(() => {
    if (!series || !links || !detail?.seasons.length) return [] as Array<{ season: number; count: number }>;
    const now = Date.now();
    return [...ours.entries()].map(([season, episodes]) => {
      const link = links[String(season)];
      const target = detail.seasons.find((s) => s.number === link?.season);
      const count = episodes.filter((e) => (e.airsAt === null || e.airsAt <= now) && !target?.episodes.some((t) => t.number === e.number + (link?.offset ?? 0))).length;
      return { season, count };
    }).filter((entry) => entry.count > 0);
  }, [series, links, detail, ours]);
  const ready = Boolean(picked && detail && (!series || links) && !pointless.length);

  const save = async () => {
    if (!picked || !detail) return;
    setSaving(true);
    try {
      const { sent } = await actions.matchSave(userUUID, {
        key: laneKey,
        item: subject.item,
        bases: subject.bases,
        kind: subject.kind,
        title: subject.title,
        open: subject.open,
        target: { ...picked, ids: detail.ids },
        seasons: series ? links ?? {} : {},
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

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Match on {name}</DialogTitle>
          <DialogDescription>
            {subject.title ? <span className="font-medium text-foreground">{subject.title}</span> : "This title"}: pick what {name} files it under{series ? ", and which of its seasons each season here is" : ""}. Everything sent to {name} for it then uses that.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${name}`} className="pl-9" aria-label={`Search ${name}`} />
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
                    onClick={() => setPicked(candidate)}
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
          </div>

          {picked && series && (
            reading || titleLoading || !links ? (
              <Skeleton className="h-40 rounded-xl" />
            ) : !detail?.seasons.length ? (
              <p className="text-xs text-muted-foreground">{name} lists no episodes for {picked.title}, so episodes keep their numbers.</p>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Eyebrow>Seasons</Eyebrow>
                  {[...ours.entries()].map(([season, episodes]) => {
                    const link = links[String(season)];
                    return (
                      <div key={season} className={cx("flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-2.5 py-2", shown === season ? "bg-white/[0.05]" : "")}>
                        <button type="button" onClick={() => setPreview(season)} className="min-w-28 text-left text-sm font-medium underline-offset-4 hover:underline">
                          Season {season}{episodes.length ? <span className="font-normal text-muted-foreground"> · {episodes.length} ep</span> : null}
                        </button>
                        <span className="text-xs text-muted-foreground">is {name}'s</span>
                        <select
                          value={link.season}
                          onChange={(event) => { setLinks({ ...links, [String(season)]: { season: Number(event.target.value), offset: 0 } }); setPreview(season); }}
                          aria-label={`${name} season for season ${season}`}
                          className="h-8 rounded-lg border border-white/[0.12] bg-background px-2 text-xs"
                        >
                          {detail.seasons.map((s) => <option key={s.number} value={s.number}>Season {s.number} ({s.episodes.length} ep)</option>)}
                        </select>
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          from its episode
                          <input
                            type="number"
                            min={1}
                            value={link.offset + 1}
                            onChange={(event) => { const start = Math.max(1, Number(event.target.value) || 1); setLinks({ ...links, [String(season)]: { ...link, offset: start - 1 } }); setPreview(season); }}
                            onWheel={(event) => event.currentTarget.blur()}
                            className="h-8 w-14 rounded-lg border border-white/[0.12] bg-background px-2 text-xs text-foreground"
                          />
                        </label>
                      </div>
                    );
                  })}
                </div>

                {shown !== null && links[String(shown)] && (
                  <div className="space-y-1.5">
                    <Eyebrow>Season {shown} here and on {name}</Eyebrow>
                    <div className="max-h-56 overflow-y-auto rounded-xl border border-white/[0.07]">
                      {(ours.get(shown) ?? []).map((episode) => {
                        const link = links[String(shown)];
                        const target = theirSeason(link.season)?.episodes.find((e) => e.number === episode.number + link.offset) ?? null;
                        const agrees = same(episode.name, target?.title);
                        return (
                          <div key={episode.number} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-white/[0.05] px-3 py-1.5 text-xs last:border-0">
                            <span className="truncate"><span className="tabular-nums text-muted-foreground">E{episode.number}</span> {episode.name ?? ""}</span>
                            {agrees ? <Check className="size-3.5 text-emerald-300" /> : <span className="text-muted-foreground">→</span>}
                            <span className={cx("truncate", !target && "text-amber-200/80")}>
                              {target ? <><span className="tabular-nums text-muted-foreground">S{link.season}E{target.number}</span> {target.title ?? ""}</> : `No episode ${episode.number + link.offset} on ${name}`}
                            </span>
                          </div>
                        );
                      })}
                      {!(ours.get(shown) ?? []).length && <p className="px-3 py-2 text-xs text-muted-foreground">No episode list here for this season.</p>}
                    </div>
                  </div>
                )}
              </div>
            )
          )}

          {pointless.length > 0 && (
            <p className="rounded-xl bg-amber-400/[0.08] px-3.5 py-2.5 text-xs leading-relaxed text-amber-100 ring-1 ring-inset ring-amber-300/20">
              {pointless.map((entry) => `season ${entry.season}: ${entry.count} ${entry.count === 1 ? "episode" : "episodes"}`).join(", ").replace(/^s/, "S")} would point at episodes {name} doesn't have. Pick another season or starting episode.
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-9 rounded-full px-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">Cancel</button>
            <button type="button" onClick={() => void save()} disabled={!ready || saving} className="flex h-9 items-center gap-2 rounded-full bg-blue-500/90 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50">
              {saving && <Loader2 className="size-3.5 animate-spin" />} {subject.item ? "Save and send" : "Save"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
