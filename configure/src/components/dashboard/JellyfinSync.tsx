import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDownToLine, ArrowLeftRight, CheckCircle2, ChevronRight, Film, History, LayoutList, Link2, Loader2, MoreHorizontal, Network, Pencil, RefreshCw, RotateCcw, Send, Trash2, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useJellyfinSync, useJellyfinSyncActions, useJellyfinSyncDrift, useJellyfinTrackerMatches, type DashboardTab, type JellyfinDriftItem, type JellyfinDriftLane, type JellyfinSyncFeedItem, type JellyfinSyncLane, type JellyfinSyncRow, type JellyfinSyncWrite, type JellyfinTrackerMatch } from "@/hooks/useDashboardQueries";
import { Eyebrow, Logo, Still, Toggle } from "./TrackerParts";
import { ANIME_ONLY, COPY_FROM, MATCHABLE, nameOf } from "./trackerNames";
import JellyfinCopy from "./JellyfinCopy";
import TrackerMatchDialog, { Poster, type MatchSubject } from "./JellyfinTrackerMatch";
import DriftInfo from "./JellyfinDriftInfo";
import { Ambient } from "./JellyfinShared";
import { useOpenTitle, useRemembered, when } from "./jellyfinUtils";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

function useNow(active: boolean, every: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [active, every]);
  return now;
}

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const shortDay = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function countdown(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

const limited = (text: string | null) => Boolean(text && /\b429\b|quota|limit|allowance/i.test(text));
const watchesIn = (items: JellyfinDriftItem[] = []) => items.reduce((sum, item) => sum + new Set(item.views.map((v) => `${v.season}:${v.episode}`)).size, 0);
const watches = (n: number) => `${n} ${n === 1 ? "watch" : "watches"}`;

type Tone = "ok" | "waiting" | "paused" | "failing" | "drift" | "ahead" | "idle";
type LaneState = { tone: Tone; short: string; line: string };

function laneState(lane: JellyfinSyncLane, now: number, drift?: JellyfinDriftLane): LaneState {
  const next = lane.nextTryAt ? lane.nextTryAt - now : 0;
  const soon = next > 0 ? `in ${countdown(next)}` : "now";
  if (lane.readError) return { tone: "failing", short: "Can't read", line: `Can't read ${nameOf(lane.service)}` };
  if (lane.pending > 0) {
    if (limited(lane.lastError)) return { tone: "paused", short: "Paused", line: `Paused by its limit, next try ${soon}` };
    if (lane.lastError) return { tone: "failing", short: `${lane.pending} retrying`, line: `${lane.pending} waiting, retrying ${soon}` };
    return { tone: "waiting", short: `${lane.pending} waiting`, line: `${lane.pending} waiting, sending ${soon}` };
  }
  if (!lane.imported) return { tone: "idle", short: "Not read yet", line: "Not read yet" };
  const missing = watchesIn(drift?.behind);
  if (missing) return { tone: "drift", short: `${missing} missing`, line: `Missing ${watches(missing)} from your history` };
  const extra = watchesIn(drift?.ahead);
  if (extra) return { tone: "ahead", short: `${extra} only there`, line: `Has ${watches(extra)} your history doesn't` };
  const again = drift?.rewatchNote ? 0 : watchesIn(drift?.rewatched);
  if (again) return { tone: "drift", short: `${again} ${again === 1 ? "rewatch" : "rewatches"} missing`, line: `Missing ${again === 1 ? "a rewatch" : `${again} rewatches`} from your history` };
  return { tone: "ok", short: "In step", line: drift ? "In step with your history" : "Nothing waiting to send" };
}

const DOT: Record<Tone, string> = {
  ok: "bg-emerald-400",
  waiting: "bg-blue-400",
  paused: "bg-amber-400",
  failing: "bg-red-400",
  drift: "bg-amber-300",
  ahead: "bg-sky-300",
  idle: "bg-zinc-500",
};
const TEXT: Record<Tone, string> = {
  ok: "text-muted-foreground",
  waiting: "text-blue-200",
  paused: "text-amber-200",
  failing: "text-red-300",
  drift: "text-amber-200",
  ahead: "text-sky-200",
  idle: "text-muted-foreground",
};

interface Event {
  at: number;
  kind: string;
  verb: string;
  title: string | null;
  imageUrl: string | null;
  reason: string | null;
  services: Array<{ service: string; kind: string }>;
  quiet?: boolean;
}

interface Burst {
  at: number;
  until: number;
  kind: string;
  verb: string;
  events: Event[];
}

const BURST_GAP = 15 * 60 * 1000;
const PLURAL: Record<string, (n: number) => string> = {
  "Sent a missed watch": (n) => `Sent ${n} missed watches`,
  Watched: (n) => `Watched ${n}`,
  "Marked watched": (n) => `Marked ${n} watched`,
  "Marked unwatched": (n) => `Marked ${n} unwatched`,
  "Moved the watch date": (n) => `Moved ${n} watch dates`,
};

function burstsOf(events: Event[]): Burst[] {
  const out: Burst[] = [];
  for (const event of [...events].sort((a, b) => b.at - a.at)) {
    const last = out[out.length - 1];
    if (last && last.kind === event.kind && last.verb === event.verb && last.at - event.at < BURST_GAP) {
      last.events.push(event);
      last.at = event.at;
      continue;
    }
    out.push({ at: event.at, until: event.at, kind: event.kind, verb: event.verb, events: [event] });
  }
  return out;
}

function summaryOf(burst: Burst): { what: string; detail: string | null; tone: string } {
  const n = burst.events.length;
  const titles = [...new Set(burst.events.map((e) => e.title).filter(Boolean))] as string[];
  const named = titles.length > 3 ? `${titles.slice(0, 3).join(", ")} and ${titles.length - 3} more` : titles.join(", ");
  if (burst.kind === "read") {
    const changed = burst.events.filter((e) => !e.quiet).length;
    return { what: changed ? (changed === 1 ? "Read new changes" : `Read new changes ${changed} times`) : n === 1 ? "Read, nothing new" : `Read ${n} times, nothing new`, detail: null, tone: "bg-blue-400" };
  }
  if (burst.kind === "readFailed") return { what: n === 1 ? "Could not read" : `Could not read, ${n} tries`, detail: burst.events[0].reason, tone: "bg-red-400" };
  if (burst.kind === "failed") return { what: n === 1 ? `Gave up: ${burst.verb}` : `Gave up on ${n} writes`, detail: [named, burst.events[0].reason].filter(Boolean).join(" · ") || null, tone: "bg-red-400" };
  if (burst.kind === "dropped") return { what: n === 1 ? `Dropped: ${burst.verb}` : `Dropped ${n} writes`, detail: named || null, tone: "bg-zinc-400" };
  return { what: n === 1 ? burst.verb : (PLURAL[burst.verb]?.(n) ?? `${burst.verb}, ${n} times`), detail: named || null, tone: "bg-emerald-400" };
}

function BurstRow({ burst, showServices }: { burst: Burst; showServices: boolean }) {
  const { what, detail, tone } = summaryOf(burst);
  const stills = [...new Set(burst.events.map((e) => e.imageUrl).filter(Boolean))].slice(0, 3) as string[];
  const marks = new Map<string, string>();
  for (const e of burst.events) for (const s of e.services) if (marks.get(s.service) !== "failed") marks.set(s.service, s.kind);
  const span = burst.until - burst.at > 60_000 ? `${clock(burst.at)} to ${clock(burst.until)}` : clock(burst.until);
  return (
    <div className="grid grid-cols-[minmax(4.5rem,auto)_10px_minmax(0,1fr)_auto] items-center gap-3 border-t border-white/[0.05] py-2.5 first:border-t-0">
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{span}</span>
      <span className={cx("size-2 justify-self-center rounded-full", tone)} />
      <span className="min-w-0">
        <span className="block truncate text-sm">{what}</span>
        {(detail || (showServices && marks.size > 0)) && (
          <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {showServices && [...marks].map(([service, kind]) => (
              <span key={service} title={`${nameOf(service)}: ${kind}`} className="relative shrink-0">
                <Logo service={service} size={16} />
                {kind !== "sent" && <X className="absolute -bottom-1 -right-1 size-2.5 rounded-full bg-red-500 text-white" strokeWidth={4} />}
              </span>
            ))}
            {detail && <span className="truncate">{detail}</span>}
          </span>
        )}
      </span>
      <span className="flex pl-3">
        {stills.map((src) => <Still key={src} src={src} className="-ml-3 w-14 border-2 border-background" />)}
      </span>
    </div>
  );
}


function spanOf(item: JellyfinDriftItem): string {
  if (item.kind === "movie") return "Film";
  const episodes = [...new Map(item.views.map((v) => [`${v.season}:${v.episode}`, v])).values()];
  const seasons = new Set(episodes.map((v) => v.season));
  if (seasons.size > 1) return `${episodes.length} episodes across ${seasons.size} seasons`;
  const numbers = episodes.map((v) => v.episode ?? 0).sort((a, b) => a - b);
  const season = episodes[0]?.season;
  const last = numbers[numbers.length - 1];
  const list = numbers.length === 1 ? `episode ${last}`
    : last - numbers[0] + 1 === numbers.length ? `episodes ${numbers[0]} to ${last}`
    : `episodes ${numbers.slice(0, -1).join(", ")} and ${last}`;
  const text = season === null || season === undefined ? list : `Season ${season}, ${list}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function datesOf(item: JellyfinDriftItem): string {
  const first = shortDay(Math.min(...item.views.map((v) => v.at)));
  const last = shortDay(item.lastAt);
  return first === last ? first : `${first} to ${last}`;
}

function DriftList({ title, items, all, one, icon, busy, prefix, where, onGo, service, onMatch, info, note }: {
  title: string;
  items: JellyfinDriftItem[];
  all: string;
  one: string;
  icon: React.ReactNode;
  busy: string | null;
  prefix: string;
  where: string;
  onGo: (items: string[] | null) => void;
  service?: string;
  onMatch?: (item: JellyfinDriftItem) => void;
  info?: { userUUID: string; laneKey: string; side: "behind" | "ahead" | "again"; activeTab: DashboardTab };
  note?: string;
}) {
  const openTitle = useOpenTitle();
  const withInfo = (item: JellyfinDriftItem, row: React.ReactElement) => info && service
    ? <DriftInfo userUUID={info.userUUID} laneKey={info.laneKey} service={service} side={info.side} item={item} activeTab={info.activeTab}>{row}</DriftInfo>
    : row;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow>{title} <span className="tabular-nums opacity-70">({watchesIn(items)})</span></Eyebrow>
        {items.length > 1 && !note && (
          <button type="button" onClick={() => onGo(null)} disabled={busy !== null} className="flex items-center gap-1.5 text-xs font-semibold text-blue-300 transition-colors hover:text-blue-200 disabled:opacity-50">
            {busy === `${prefix}*` && <Loader2 className="size-3 animate-spin" />} {all}
          </button>
        )}
      </div>
      {note && <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>}
      <div className="space-y-1">
        {items.map((item) => (
          <div key={item.id} className="group flex items-center gap-2 rounded-xl p-1.5 transition-colors hover:bg-white/[0.04]">
            {withInfo(item, <button type="button" disabled={!openTitle} onClick={() => openTitle?.(item.open)} aria-label={`Open ${item.title ?? "this title"}`} className="flex min-w-0 flex-1 items-center gap-3.5 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60">
              <span className="overflow-hidden rounded-lg"><Still src={item.imageUrl} className="w-20 rounded-lg transition-transform duration-500 group-hover:scale-105 sm:w-28" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold underline-offset-4 group-hover:underline">{item.title ?? "Unknown title"}</span>
                <span className="block text-xs text-muted-foreground">{spanOf(item)}<span className="max-sm:block"><span className="max-sm:hidden"> · </span>{where} {datesOf(item)}</span></span>
                {onMatch && item.unmatched && !item.matchedTo && <span className="mt-0.5 block text-xs text-amber-200/90">{nameOf(service ?? "")} can't find this title</span>}
                {onMatch && item.matchedTo && <span className="mt-0.5 block truncate text-xs text-muted-foreground">Matched to {item.matchedTo}</span>}
              </span>
            </button>)}
            {onMatch && (
              <button type="button" onClick={() => onMatch(item)} aria-label={`Match ${item.title ?? "this title"} on ${nameOf(service ?? "")}`} className={cx("flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors", item.unmatched && !item.matchedTo ? "bg-amber-400/15 text-amber-100 ring-1 ring-inset ring-amber-300/30 hover:bg-amber-400/25" : "border border-white/[0.12] text-foreground/90 hover:bg-white/10")}>
                <Link2 className="size-3.5" /> <span className="hidden sm:inline">{item.matchedTo ? "Edit match" : "Match"}</span>
              </button>
            )}
            {!note && <button type="button" onClick={() => onGo([item.id])} disabled={busy !== null} aria-label={`${one}: ${item.title ?? "this title"}`} className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-white/[0.12] px-3 text-xs font-medium text-foreground/90 transition-colors hover:bg-white/10 disabled:opacity-50">
              {busy === `${prefix}${item.id}` ? <Loader2 className="size-3.5 animate-spin" /> : icon} <span className="hidden sm:inline">{one}</span>
            </button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Waiting({ write, now, onOutbox }: { write: JellyfinSyncWrite; now: number; onOutbox: (action: "retry" | "drop", ids: number[]) => Promise<void> }) {
  const left = Math.max(0, write.nextAt - now);
  return (
    <div className="flex items-center gap-3.5 rounded-xl p-1.5">
      <Still src={write.imageUrl} className="w-20 rounded-lg sm:w-28" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{write.verb}</p>
        <p className="truncate text-xs text-muted-foreground">{[write.title, write.episode].filter(Boolean).join(" · ") || write.video}</p>
        <p className={cx("mt-0.5 flex items-center gap-1.5 truncate text-[11px]", write.lastError ? "text-amber-200/90" : "text-muted-foreground")} title={write.lastError ?? undefined}>
          {write.sending || left <= 0 ? <><Loader2 className="size-3 animate-spin" /> sending</> : `next try in ${countdown(left)}`}
          {write.attempts > 0 && ` · tried ${write.attempts}×`}
          {write.lastError && ` · ${write.lastError}`}
        </p>
      </div>
      <button type="button" onClick={() => void onOutbox("retry", [write.id])} disabled={write.sending} aria-label="Send now" title="Send now" className="flex size-8 shrink-0 items-center justify-center rounded-full text-foreground/80 transition hover:bg-white/10 disabled:opacity-40"><Send className="size-4" /></button>
      <button type="button" onClick={() => void onOutbox("drop", [write.id])} disabled={write.sending} aria-label="Drop" title="Drop" className="flex size-8 shrink-0 items-center justify-center rounded-full text-foreground/60 transition hover:bg-white/10 hover:text-red-300 disabled:opacity-40"><Trash2 className="size-4" /></button>
    </div>
  );
}

function MatchRow({ match, service, onEdit, onRemove }: { match: JellyfinTrackerMatch; service: string; onEdit: () => void; onRemove: () => void }) {
  const moved = Object.entries(match.seasons).filter(([ours, link]) => Number(ours) !== link.season || link.offset !== 0);
  const seasons = moved.map(([ours, link]) => `season ${ours} is ${link.offset ? `season ${link.season} from episode ${link.offset + 1}` : `season ${link.season}`}`).join(", ");
  return (
    <div className="flex items-center gap-3 rounded-xl p-1.5">
      <Poster src={match.target.posterUrl} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{match.title ?? "A title"} <span className="font-normal text-muted-foreground">is</span> {match.target.title}{match.target.year ? <span className="font-normal text-muted-foreground"> ({match.target.year})</span> : null}</p>
        <p className="truncate text-xs text-muted-foreground">{seasons ? `On ${nameOf(service)}, ${seasons}` : `Same seasons on ${nameOf(service)}`}</p>
      </div>
      <button type="button" onClick={onEdit} aria-label="Edit match" title="Edit match" className="flex size-8 shrink-0 items-center justify-center rounded-full text-foreground/80 transition hover:bg-white/10"><Pencil className="size-4" /></button>
      <button type="button" onClick={onRemove} aria-label="Remove match" title="Remove match" className="flex size-8 shrink-0 items-center justify-center rounded-full text-foreground/60 transition hover:bg-white/10 hover:text-red-300"><Trash2 className="size-4" /></button>
    </div>
  );
}

function LaneDetail({ userUUID, profile, activeTab, lane, drift, days, queue, events, now, reading, busy, onRun, onOutbox, onDrift, onChanged }: {
  userUUID: string;
  profile: string | null;
  activeTab: DashboardTab;
  lane: JellyfinSyncLane;
  drift: JellyfinDriftLane | undefined;
  days: number;
  queue: JellyfinSyncWrite[];
  events: Event[];
  now: number;
  reading: boolean;
  busy: string | null;
  onRun: (full: boolean) => void;
  onOutbox: (action: "retry" | "drop", ids: number[]) => Promise<void>;
  onDrift: (action: "push" | "pull", items: string[] | null) => void;
  onChanged: () => void;
}) {
  const name = nameOf(lane.service);
  const matchable = MATCHABLE.has(lane.service);
  const actions = useJellyfinSyncActions();
  const { data: matchData, refetch: refetchMatches } = useJellyfinTrackerMatches(userUUID, lane.key, matchable, { activeTab });
  const [matching, setMatching] = useState<MatchSubject | null>(null);
  const matches = matchData?.matches ?? [];
  const matchItem = (item: JellyfinDriftItem) => {
    const existing = matches.find((m) => m.bases.some((base) => item.bases?.includes(base))) ?? null;
    setMatching({ item: item.id, bases: item.bases ?? [], kind: item.kind === "movie" ? "movie" : "series", title: item.title, open: item.open, seasons: item.seasons ?? [], existing });
  };
  const editMatch = (match: JellyfinTrackerMatch) => setMatching({ item: null, bases: match.bases, kind: match.kind, title: match.title, open: match.open, seasons: Object.keys(match.seasons).map(Number), existing: match });
  const removeMatch = async (match: JellyfinTrackerMatch) => {
    try {
      await actions.matchRemove(userUUID, lane.key, match.group);
      toast.success(`${match.title ?? "The title"} is no longer matched on ${name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the match");
    } finally {
      void refetchMatches();
      onChanged();
    }
  };
  const state = laneState(lane, now, drift);
  const ids = queue.map((w) => w.id);
  const reason = lane.readError ?? (state.tone !== "paused" ? lane.lastError : null);
  const bursts = useMemo(() => burstsOf(events).slice(0, 6), [events]);
  const settled = drift && !drift.error && !drift.behind.length && !drift.ahead.length && !drift.rewatched?.length;
  return (
    <div className="flex min-w-0 animate-fade-in flex-col gap-6 rounded-2xl border border-white/[0.07] bg-black/20 p-5 backdrop-blur-sm sm:p-6">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-4">
          <Logo service={lane.service} size={48} />
          <div className="min-w-0">
            <h3 className="text-2xl font-bold tracking-tight">{name}</h3>
            <p className={cx("text-sm", TEXT[state.tone])}>
              {state.line}
              <span className="text-muted-foreground"> · read {lane.syncedAt ? when(lane.syncedAt) : "never"}{ANIME_ONLY.has(lane.service) ? " · anime only" : ""}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => onRun(false)} disabled={reading} className="flex h-9 items-center gap-2 rounded-full border border-white/[0.12] px-4 text-sm font-medium transition-colors hover:bg-white/10 disabled:opacity-60">
            <RefreshCw className={cx("size-3.5", reading && "animate-spin")} /> {reading ? "Reading…" : "Read again"}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={`More for ${name}`} className="flex size-9 items-center justify-center rounded-full border border-white/[0.12] transition-colors hover:bg-white/10"><MoreHorizontal className="size-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem disabled={reading} onSelect={() => onRun(true)}><RotateCcw className="size-4" /> Read all of {name} again</DropdownMenuItem>
              <DropdownMenuItem disabled={!ids.length} onSelect={() => void onOutbox("retry", ids)}><Send className="size-4" /> Send waiting writes now</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!ids.length} onSelect={() => void onOutbox("drop", ids)} className="text-red-300 focus:text-red-200"><Trash2 className="size-4" /> Drop waiting writes</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {reason && <p className="rounded-xl bg-red-500/[0.08] px-3.5 py-2.5 text-xs leading-relaxed text-red-200 ring-1 ring-inset ring-red-400/20">{reason}</p>}

      {!drift ? (
        <Skeleton className="h-16 rounded-xl" />
      ) : drift.error ? (
        <p className="text-xs text-red-300">Could not compare with {name}: {drift.error}</p>
      ) : settled ? (
        <p className="flex items-center gap-2 text-sm text-emerald-200/90"><CheckCircle2 className="size-4 shrink-0" /> {name} has every watch made here{ANIME_ONLY.has(lane.service) ? "" : `, and nothing it got in the last ${days} days is missing here`}.</p>
      ) : (
        <>
          {drift.behind.length > 0 && <DriftList title={`Missing on ${name}`} items={drift.behind} all="Send all" one="Send" icon={<Send className="size-3.5" />} busy={busy} prefix="push:" where="watched here" onGo={(items) => onDrift("push", items)} service={lane.service} onMatch={matchable ? matchItem : undefined} info={{ userUUID, laneKey: lane.key, side: "behind", activeTab }} />}
          {(drift.rewatched?.length ?? 0) > 0 && <DriftList title={`Rewatched here, not on ${name}`} items={drift.rewatched ?? []} all="Send all" one="Send" icon={<Send className="size-3.5" />} busy={busy} prefix="push:" where="rewatched here" onGo={(items) => onDrift("push", items)} service={lane.service} onMatch={matchable ? matchItem : undefined} info={{ userUUID, laneKey: lane.key, side: "again", activeTab }} note={drift.rewatchNote === "free" ? `${name} keeps only the first watch of an episode or film on free accounts, so these can't be sent there. PRO and VIP accounts log them as rewatches.` : undefined} />}
          {drift.ahead.length > 0 && <DriftList title={`Only on ${name}`} items={drift.ahead} all="Bring all in" one="Bring in" icon={<ArrowDownToLine className="size-3.5" />} busy={busy} prefix="pull:" where="watched" onGo={(items) => onDrift("pull", items)} service={lane.service} info={{ userUUID, laneKey: lane.key, side: "ahead", activeTab }} />}
        </>
      )}

      {queue.length > 0 && (
        <div className="space-y-1">
          <Eyebrow>Waiting to send <span className="tabular-nums opacity-70">({queue.length})</span></Eyebrow>
          {queue.map((write) => <Waiting key={write.id} write={write} now={now} onOutbox={onOutbox} />)}
        </div>
      )}

      {matches.length > 0 && (
        <div className="space-y-1">
          <Eyebrow>Matched by hand <span className="tabular-nums opacity-70">({matches.length})</span></Eyebrow>
          {matches.map((match) => <MatchRow key={match.group} match={match} service={lane.service} onEdit={() => editMatch(match)} onRemove={() => void removeMatch(match)} />)}
        </div>
      )}

      {matching && (
        <TrackerMatchDialog
          userUUID={userUUID}
          profile={profile}
          activeTab={activeTab}
          laneKey={lane.key}
          service={lane.service}
          subject={matching}
          onClose={() => setMatching(null)}
          onSaved={() => { void refetchMatches(); onChanged(); }}
        />
      )}

      {bursts.length > 0 && (
        <div>
          <div className="pb-1"><Eyebrow>Lately</Eyebrow></div>
          {bursts.map((burst, i) => <BurstRow key={`${burst.until}-${i}`} burst={burst} showServices={false} />)}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground/80">
        Every watch made here is checked{ANIME_ONLY.has(lane.service) ? "" : `, and ${name}'s own from the last ${days} days`}{drift?.unread ? `; ${watches(drift.unread)} newer than the last read wait for the next one` : ""}. Reading never changes {name}; sending dates each watch when it happened.
      </p>
    </div>
  );
}


function LedgerRow({ lane, number, state, active, onPick }: { lane: JellyfinSyncLane; number: number; state: LaneState; active: boolean; onPick: () => void }) {
  const others = lane.profiles.length > 1 || lane.profiles[0] !== "Main";
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={cx("group relative isolate flex w-full items-center gap-3 overflow-hidden rounded-xl py-2.5 pl-2 pr-3 text-left transition-all duration-300", active ? "bg-gradient-to-r from-blue-500/[0.12] to-transparent ring-1 ring-blue-400/50 shadow-[0_10px_40px_-12px_rgba(59,130,246,0.55)]" : "hover:bg-white/[0.05]")}
    >
      <span className={cx("w-7 shrink-0 text-right font-mono text-sm tabular-nums transition-colors", active ? "text-blue-300" : "text-muted-foreground/50")}>{String(number).padStart(2, "0")}</span>
      <Logo service={lane.service} size={36} className={cx("transition-transform duration-300", active && "scale-110 shadow-lg")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold leading-tight">{nameOf(lane.service)}{others && <span className="font-normal text-muted-foreground"> · {lane.profiles.join(", ")}</span>}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px]">
          <span className={cx("size-1.5 shrink-0 rounded-full", DOT[state.tone])} />
          <span className={cx("truncate", TEXT[state.tone])}>{state.short}</span>
          <span className="text-muted-foreground/60">·</span>
          <span className="truncate text-muted-foreground">read {lane.syncedAt ? when(lane.syncedAt) : "never"}</span>
        </span>
      </span>
    </button>
  );
}

function HistoryRow({ watched }: { watched: number }) {
  return (
    <div className="flex items-center gap-3 rounded-xl py-2.5 pl-2 pr-3">
      <span className="w-7 shrink-0" />
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-zinc-600 to-zinc-900 ring-1 ring-inset ring-white/10"><History className="size-4 text-zinc-200" /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold leading-tight">Your history here</span>
        <span className="block truncate text-[11px] text-muted-foreground">{watched.toLocaleString()} films and episodes, what each tracker is checked against</span>
      </span>
    </div>
  );
}

const LINE: Record<Tone, { stroke: string; dash?: string; flow?: boolean }> = {
  ok: { stroke: "rgba(255,255,255,0.14)" },
  idle: { stroke: "rgba(255,255,255,0.08)", dash: "2 6" },
  waiting: { stroke: "rgba(96,165,250,0.85)", dash: "6 8", flow: true },
  paused: { stroke: "rgba(251,191,36,0.6)", dash: "2 6" },
  failing: { stroke: "rgba(248,113,113,0.7)", dash: "4 6" },
  drift: { stroke: "rgba(251,191,36,0.65)", dash: "6 6" },
  ahead: { stroke: "rgba(125,211,252,0.6)", dash: "6 6" },
};

const CHIP: Record<Tone, string> = {
  ok: "border-white/10 bg-background/80 text-muted-foreground",
  idle: "border-white/10 bg-background/80 text-muted-foreground",
  waiting: "border-blue-300/40 bg-blue-950/80 text-blue-100",
  paused: "border-amber-300/40 bg-amber-950/80 text-amber-100",
  failing: "border-red-400/40 bg-red-950/80 text-red-100",
  drift: "border-amber-300/40 bg-amber-950/80 text-amber-100",
  ahead: "border-sky-300/40 bg-sky-950/80 text-sky-100",
};

function Hub({ lanes, states, selected, watched, onPick, onCopy }: { lanes: JellyfinSyncLane[]; states: Map<string, LaneState>; selected: string | undefined; watched: number; onPick: (key: string) => void; onCopy: (from: string, to: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [width, setWidth] = useState(1000);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setWidth(el.clientWidth));
    watch.observe(el);
    setWidth(el.clientWidth);
    return () => watch.disconnect();
  }, []);
  const height = 470;
  const midX = width / 2;
  const midY = height / 2 - 6;
  const rx = Math.min(width * 0.38, 470);
  const ry = 178;
  const hub = 72;
  const points = lanes.map((lane, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / lanes.length + (lanes.length % 2 ? 0 : Math.PI / lanes.length);
    const x = midX + rx * Math.cos(angle);
    const y = midY + ry * Math.sin(angle);
    const side = Math.abs(y - midY) < Math.abs(x - midX) * 0.6;
    const tx = side ? x - Math.sign(x - midX) * 36 : x;
    const ty = side ? y - 10 : y < midY ? y + 58 : y - 46;
    const dx = tx - midX;
    const dy = ty - midY;
    const dist = Math.hypot(dx, dy) || 1;
    return { lane, x, y, sx: midX + (dx / dist) * hub, sy: midY + (dy / dist) * hub, ex: tx - (dx / dist) * 6, ey: ty - (dy / dist) * 6 };
  });
  return (
    <div ref={box} className="relative w-full" style={{ height }}>
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.09),transparent_60%)]" />
      <svg aria-hidden className="absolute inset-0" width={width} height={height}>
        {points.map(({ lane, sx, sy, ex, ey }) => {
          const tone = states.get(lane.key)?.tone ?? "idle";
          const look = LINE[tone];
          const on = lane.key === selected;
          return <line key={lane.key} x1={sx} y1={sy} x2={ex} y2={ey} stroke={on && tone === "ok" ? "rgba(147,197,253,0.7)" : look.stroke} strokeWidth={on ? 2.5 : 1.5} strokeDasharray={look.dash} strokeLinecap="round" className={look.flow ? "animate-flow" : undefined} />;
        })}
      </svg>
      {points.map(({ lane, sx, sy, ex, ey }) => {
        const state = states.get(lane.key);
        if (!state || state.tone === "ok") return null;
        return (
          <span key={`chip-${lane.key}`} style={{ left: (sx + ex) / 2, top: (sy + ey) / 2 }} className={cx("pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium backdrop-blur", CHIP[state.tone])}>
            {state.short}
          </span>
        );
      })}
      <div style={{ left: midX - hub, top: midY - hub, width: hub * 2, height: hub * 2 }} className="absolute flex flex-col items-center justify-center gap-1 rounded-full border border-white/15 bg-[radial-gradient(circle_at_35%_30%,rgba(255,255,255,0.13),rgba(255,255,255,0.03))] text-center shadow-[0_0_60px_rgba(59,130,246,0.18),inset_0_1px_0_rgba(255,255,255,0.1)] backdrop-blur">
        <History className="size-5 text-zinc-200" />
        <span className="text-sm font-bold">Your history</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{watched.toLocaleString()} watched</span>
      </div>
      {points.map(({ lane, x, y }) => {
        const on = lane.key === selected;
        const state = states.get(lane.key);
        const target = dragging !== null && dragging !== lane.key;
        return (
          <button
            key={lane.key}
            type="button"
            onClick={() => onPick(lane.key)}
            aria-pressed={on}
            draggable={COPY_FROM.has(lane.service)}
            onDragStart={(event) => { event.dataTransfer.setData("text/plain", lane.key); event.dataTransfer.effectAllowed = "copy"; setDragging(lane.key); }}
            onDragEnd={() => { setDragging(null); setOver(null); }}
            onDragOver={(event) => { if (target) { event.preventDefault(); setOver(lane.key); } }}
            onDragLeave={() => setOver((held) => (held === lane.key ? null : held))}
            onDrop={(event) => { event.preventDefault(); if (dragging && target) onCopy(dragging, lane.key); setDragging(null); setOver(null); }}
            style={{ left: x, top: y }}
            className={cx("group absolute flex w-40 -translate-x-1/2 -translate-y-[44px] flex-col items-center gap-1.5 rounded-2xl p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60", COPY_FROM.has(lane.service) && "cursor-grab active:cursor-grabbing")}
          >
            <Logo service={lane.service} size={60} className={cx("transition-all duration-300 group-hover:scale-105", over === lane.key ? "scale-125 ring-2 ring-emerald-300 shadow-[0_0_32px_rgba(110,231,183,0.55)]" : target ? "outline outline-2 outline-offset-4 outline-dashed outline-white/40" : on ? "scale-110 ring-2 ring-blue-400/80 shadow-[0_0_28px_rgba(59,130,246,0.45)]" : "shadow-lg shadow-black/40", dragging === lane.key && "opacity-60")} />
            <span className="text-sm font-semibold">{nameOf(lane.service)}</span>
            {target
              ? <span className="text-[11px] text-emerald-200">{over === lane.key ? "Drop to copy here" : "Copy here"}</span>
              : state && <span className={cx("text-[11px]", TEXT[state.tone])}>{state.tone === "ok" ? `read ${lane.syncedAt ? when(lane.syncedAt) : "never"}` : state.short}</span>}
          </button>
        );
      })}
    </div>
  );
}


type Tab = "trackers" | "copy" | "activity";
type View = "ledger" | "hub";

const dayOf = (at: number): string => {
  const d = new Date(at);
  if (d.toDateString() === new Date().toDateString()) return "Today";
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
};

export default function JellyfinSync({ userUUID, profile, profileName, watched, rows, activeTab, compact = false, onOpen }: { userUUID: string; profile: string | null; profileName: string; watched: number; rows: JellyfinSyncRow[]; activeTab: DashboardTab; compact?: boolean; onOpen?: () => void }) {
  const folded = compact;
  const [tab, setTab] = useRemembered<Tab>("jellyfin.sync.tab", "trackers");
  const [view, setView] = useRemembered<View>("jellyfin.sync.view", "ledger");
  const [chosen, setChosen] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [copyPair, setCopyPair] = useState<{ from: string; to: string } | null>(null);
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  const detail = useRef<HTMLDivElement>(null);
  const { data, isLoading, refetch } = useJellyfinSync(userUUID, profile, !folded, { activeTab });
  const { data: driftData, refetch: refetchDrift } = useJellyfinSyncDrift(userUUID, profile, !folded, { activeTab });
  const actions = useJellyfinSyncActions();
  const queryClient = useQueryClient();
  const waiting = (data?.queue.length ?? 0) > 0;
  const now = useNow(!folded && Boolean(data), waiting ? 1000 : 15_000);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    if (folded || !waiting) return;
    const timer = window.setInterval(() => void refetch(), 3000);
    return () => window.clearInterval(timer);
  }, [folded, waiting, refetch]);

  const lanes = useMemo(() => data?.lanes ?? [], [data]);
  const drifts = useMemo(() => new Map((driftData?.lanes ?? []).map((lane) => [lane.key, lane])), [driftData]);
  const states = useMemo(() => new Map(lanes.map((lane) => [lane.key, laneState(lane, now, drifts.get(lane.key))])), [lanes, now, drifts]);
  const rank: Tone[] = ["failing", "paused", "waiting", "drift", "ahead"];
  const selected = lanes.find((lane) => lane.key === chosen)
    ?? rank.map((tone) => lanes.find((lane) => states.get(lane.key)?.tone === tone)).find(Boolean)
    ?? lanes[0];
  const days = driftData?.days ?? 30;

  const titles = useMemo(() => {
    const out = new Map<string, string | null>();
    for (const item of [...(data?.queue ?? []), ...(data?.feed ?? [])]) if (item.video) out.set(item.video, [item.title, item.episode].filter(Boolean).join(" · ") || null);
    return out;
  }, [data]);

  const eventsOf = (lane: JellyfinSyncLane): Event[] => {
    const writes = (data?.feed ?? []).flatMap((f) => {
      const mark = f.services.find((s) => s.lane === lane.key);
      return mark ? [{ at: f.at, kind: mark.kind, verb: f.verb, title: [f.title, f.episode].filter(Boolean).join(" · ") || null, imageUrl: f.imageUrl, reason: mark.reason, services: [] }] : [];
    });
    const reads = lane.pulse.filter((p) => p.kind === "read" || p.kind === "readFailed").map((p) => ({
      at: p.at, kind: p.kind, verb: p.kind, title: null, imageUrl: null, reason: p.reason, services: [], quiet: p.kind === "read" && !p.changed && !p.full,
    }));
    return [...writes, ...reads];
  };

  const activity = useMemo(() => {
    const events: Event[] = (data?.feed ?? []).map((f: JellyfinSyncFeedItem) => ({
      at: f.at,
      kind: f.services.some((s) => s.kind === "failed") ? "failed" : f.services.every((s) => s.kind === "dropped") ? "dropped" : "sent",
      verb: f.verb,
      title: [f.title, f.episode].filter(Boolean).join(" · ") || (f.video ? titles.get(f.video) ?? null : null),
      imageUrl: f.imageUrl,
      reason: f.services.find((s) => s.reason)?.reason ?? null,
      services: f.services,
    }));
    const byDay: Array<{ day: string; bursts: Burst[] }> = [];
    for (const burst of burstsOf(events)) {
      const day = dayOf(burst.until);
      const last = byDay[byDay.length - 1];
      if (last?.day === day) last.bursts.push(burst);
      else byDay.push({ day, bursts: [burst] });
    }
    return byDay;
  }, [data, titles]);

  const refresh = () => {
    void refetch();
    void refetchDrift();
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "dashboard" && q.queryKey[1] === "jellyfin" && q.queryKey[2] !== "sync" && q.queryKey[2] !== "title" });
  };

  const runLane = async (lane: JellyfinSyncLane, full: boolean) => {
    const name = nameOf(lane.service);
    setRunning((held) => new Set(held).add(lane.key));
    try {
      const done = await actions.run(userUUID, lane.key, full);
      toast.success(full ? `Read all of ${name} again` : done.changed ? `Read new changes from ${name}` : `Nothing new on ${name}`, { description: `${(done.ms / 1000).toFixed(1)} s` });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not read ${name}`);
    } finally {
      setRunning((held) => { const next = new Set(held); next.delete(lane.key); return next; });
      refresh();
    }
  };

  const outbox = async (action: "retry" | "drop", ids: number[]) => {
    try {
      const { count } = await actions.outbox(userUUID, action, ids);
      toast.success(action === "retry" ? `Sending ${count} ${count === 1 ? "write" : "writes"} now` : `Dropped ${count} ${count === 1 ? "write" : "writes"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the waiting writes");
    } finally {
      refresh();
    }
  };

  const settle = async (lane: JellyfinSyncLane, action: "push" | "pull", items: string[] | null) => {
    const name = nameOf(lane.service);
    const drift = drifts.get(lane.key);
    const picked = (action === "push" ? [...(drift?.behind ?? []), ...(drift?.rewatchNote ? [] : drift?.rewatched ?? [])] : drift?.ahead)?.filter((item) => !items || items.includes(item.id)) ?? [];
    setBusy(`${action}:${items ? items[0] : "*"}`);
    try {
      const { count } = await actions.drift(userUUID, lane.key, action, items);
      if (action === "push") toast[count ? "success" : "info"](count ? `Sending ${watches(watchesIn(picked))} to ${name}` : `${name} already has ${picked.length === 1 ? "it" : "them"}`);
      else toast.success(`Brought ${watches(watchesIn(picked))} in from ${name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not settle the difference with ${name}`);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const pick = (key: string) => {
    setChosen(key);
    if (!wide) requestAnimationFrame(() => detail.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  if (folded) {
    return (
      <section className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <button type="button" onClick={onOpen} className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground">
          {profileName}'s trackers <ChevronRight className="size-3.5" />
        </button>
        <span className="flex items-center gap-2">
          {rows.map((row, i) => {
            const tone: Tone = row.readError ? "failing" : row.lastError ? (limited(row.lastError) ? "paused" : "failing") : row.pending > 0 ? "waiting" : row.imported ? "ok" : "idle";
            return (
              <button key={`${row.service}-${i}`} type="button" onClick={onOpen} aria-label={`Open trackers: ${nameOf(row.service)}`} title={`${nameOf(row.service)}: ${row.readError ? "can't read" : row.pending ? `${row.pending} waiting` : `read ${when(row.syncedAt)}`}`} className="relative transition-transform hover:scale-110">
                <Logo service={row.service} size={20} />
                <span className={cx("absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background", DOT[tone])} />
              </button>
            );
          })}
        </span>
      </section>
    );
  }

  const apart = [...drifts.values()].reduce((sum, d) => sum + watchesIn(d.behind) + watchesIn(d.ahead), 0);
  const unreadable = lanes.filter((lane) => lane.readError);
  const pending = lanes.reduce((sum, lane) => sum + lane.pending, 0);
  const headline = !data ? "Trackers"
    : !lanes.length ? "No trackers"
    : unreadable.length ? (unreadable.length === 1 ? `Can't read ${nameOf(unreadable[0].service)}` : `Can't read ${unreadable.length} trackers`)
    : pending ? `${pending} waiting to send`
    : !driftData ? "Comparing…"
    : apart ? `${apart === 1 ? "One watch" : `${apart.toLocaleString()} watches`} apart`
    : "In step";
  const selectedDrift = selected ? drifts.get(selected.key) : undefined;
  const backdrop = selectedDrift?.behind[0]?.imageUrl ?? selectedDrift?.ahead[0]?.imageUrl ?? null;
  const showHub = view === "hub" && wide;

  const detailOf = (lane: JellyfinSyncLane) => (
    <LaneDetail
      key={lane.key}
      userUUID={userUUID}
      profile={profile}
      activeTab={activeTab}
      lane={lane}
      drift={drifts.get(lane.key)}
      days={days}
      queue={(data?.queue ?? []).filter((w) => w.lane === lane.key)}
      events={eventsOf(lane)}
      now={now}
      reading={running.has(lane.key)}
      busy={busy}
      onRun={(full) => void runLane(lane, full)}
      onOutbox={outbox}
      onDrift={(action, items) => void settle(lane, action, items)}
      onChanged={refresh}
    />
  );

  return (
    <section className="relative isolate overflow-hidden">
      <Ambient src={tab === "trackers" ? backdrop : null} />
      <div className="relative px-4 py-6 sm:px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{profileName}'s trackers</span>
            <h2 className="text-3xl font-bold tracking-tight">{tab === "copy" ? "Copy between trackers" : headline}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {tab === "copy" ? "Through your history here, so it ends up complete too" : data ? `Your history and ${lanes.length} ${lanes.length === 1 ? "tracker" : "trackers"}` : "…"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Toggle value={tab} onChange={setTab} options={[["trackers", LayoutList, "Trackers"], ["copy", ArrowLeftRight, "Copy"], ["activity", History, "Activity"]]} />
            {tab === "trackers" && wide && <Toggle value={view} onChange={setView} options={[["ledger", LayoutList, "Ledger"], ["hub", Network, "Hub"]]} />}
            {lanes.length > 1 && (
              <button type="button" onClick={() => void Promise.all(lanes.map((lane) => runLane(lane, false)))} disabled={running.size > 0} aria-label="Read every tracker again" title="Read every tracker again" className="glass flex size-9 items-center justify-center rounded-full text-foreground/80 transition-colors hover:text-foreground disabled:opacity-60">
                <RefreshCw className={cx("size-4", running.size > 0 && "animate-spin")} />
              </button>
            )}
          </div>
        </div>

        {isLoading && !data ? (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
            <div className="space-y-1.5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>
            <Skeleton className="h-80 rounded-2xl" />
          </div>
        ) : !data || lanes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tracker connected. History stays on this server.</p>
        ) : tab === "copy" ? (
          <JellyfinCopy userUUID={userUUID} profile={profile} lanes={lanes} activeTab={activeTab} initial={copyPair} />
        ) : tab === "activity" ? (
          <div className="max-w-4xl">
            {activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing sent to the trackers lately. Plays, marks, ratings and lists show here once they go out.</p>
            ) : activity.map((group) => (
              <div key={group.day} className="pb-5">
                <p className="pb-1 text-xs font-semibold text-foreground/80">{group.day}</p>
                {group.bursts.map((burst, i) => <BurstRow key={`${burst.until}-${i}`} burst={burst} showServices />)}
              </div>
            ))}
          </div>
        ) : showHub ? (
          <div className="flex flex-col gap-5">
            <Hub lanes={lanes} states={states} selected={selected?.key} watched={watched} onPick={pick} onCopy={(from, to) => { setCopyPair({ from, to }); setTab("copy"); }} />
            <p className="-mt-3 text-center text-[11px] text-muted-foreground">Drag a tracker onto another to copy its history there.</p>
            <div ref={detail} className="mx-auto w-full max-w-4xl scroll-mt-20">{selected && detailOf(selected)}</div>
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:items-start">
            <div className="flex min-w-0 flex-col gap-1">
              <HistoryRow watched={watched} />
              {lanes.map((lane, i) => <LedgerRow key={lane.key} lane={lane} number={i + 1} state={states.get(lane.key)!} active={lane.key === selected?.key} onPick={() => pick(lane.key)} />)}
            </div>
            <div ref={detail} className="min-w-0 scroll-mt-20">{selected && detailOf(selected)}</div>
          </div>
        )}
      </div>
    </section>
  );
}
