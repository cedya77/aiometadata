import { useState } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { toast } from "sonner";
import { Info, Link2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useJellyfinDriftDetail, type DashboardTab, type JellyfinDriftItem } from "@/hooks/useDashboardQueries";
import { nameOf } from "./trackerNames";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(at).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
const moment = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ID_LABELS: Record<string, string> = { imdb: "IMDb", tvdb: "TVDB", tmdb: "TMDB", simkl: "Simkl", tvmaze: "TVmaze", kitsu: "Kitsu", mal: "MAL", anilist: "AniList", trakt: "Trakt" };

function ranges(numbers: number[]): string {
  const out: string[] = [];
  let start = numbers[0];
  let last = numbers[0];
  for (const n of [...numbers.slice(1), Number.NaN]) {
    if (n === last + 1) {
      last = n;
      continue;
    }
    out.push(start === last ? String(start) : `${start} to ${last}`);
    start = n;
    last = n;
  }
  return out.join(", ");
}

function seasonsOf(item: JellyfinDriftItem): Array<{ season: number | null; episodes: string; count: number; from: number; to: number }> {
  const bySeason = new Map<number | null, { episodes: Set<number>; from: number; to: number }>();
  for (const view of item.views) {
    const held = bySeason.get(view.season) ?? { episodes: new Set<number>(), from: view.at, to: view.at };
    if (view.episode !== null) held.episodes.add(view.episode);
    held.from = Math.min(held.from, view.at);
    held.to = Math.max(held.to, view.at);
    bySeason.set(view.season, held);
  }
  return [...bySeason.entries()]
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))
    .map(([season, held]) => {
      const numbers = [...held.episodes].sort((a, b) => a - b);
      return { season, episodes: numbers.length ? ranges(numbers) : "", count: numbers.length, from: held.from, to: held.to };
    });
}

function labelOf(id: string): string {
  if (id.startsWith("tt")) return "IMDb";
  return ID_LABELS[id.split(":")[0]] ?? id.split(":")[0];
}

function Chip({ text, label }: { text: string; label?: string }) {
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => toast.success(`Copied ${text}`), () => undefined);
  };
  return (
    <button type="button" onClick={copy} title="Copy" className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] ring-1 ring-inset ring-white/[0.08] transition-colors hover:bg-white/[0.12]">
      <span className="text-muted-foreground">{label ?? labelOf(text)}</span>
      <span className="truncate font-mono text-foreground/90">{text}</span>
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function Detail({ userUUID, laneKey, service, side: shown, item, activeTab, open }: { userUUID: string; laneKey: string; service: string; side: "behind" | "ahead" | "again"; item: JellyfinDriftItem; activeTab: DashboardTab; open: boolean }) {
  const name = nameOf(service);
  const side = shown === "ahead" ? "ahead" : "behind";
  const { data, isLoading, isError } = useJellyfinDriftDetail(userUUID, laneKey, side, item, open, { activeTab });
  const seasons = seasonsOf(item);
  const film = item.kind === "movie";
  return (
    <div className="space-y-3.5">
      <div>
        <p className="truncate text-sm font-semibold">{item.title ?? "Unknown title"}</p>
        <p className="text-xs text-muted-foreground">{shown === "again" ? `Rewatched here, ${name} has only an earlier watch` : side === "behind" ? `Watched here, missing on ${name}` : `Watched on ${name}, missing here`}</p>
      </div>

      <Section title={film ? "Watched" : side === "behind" ? "Watched here" : `Watched on ${name}`}>
        <div className="space-y-0.5 text-xs">
          {film
            ? <p className="text-foreground/90">{item.views.length === 1 ? day(item.views[0].at) : `${item.views.length} times, ${item.views.map((v) => day(v.at)).join(", ")}`}</p>
            : seasons.map((s) => (
              <p key={String(s.season)} className="flex gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">{s.season === null ? "Episodes" : `Season ${s.season}`}</span>
                <span className="min-w-0 flex-1 text-foreground/90">{s.count === 1 ? "episode" : "episodes"} {s.episodes}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{day(s.from) === day(s.to) ? day(s.to) : `${day(s.from)} to ${day(s.to)}`}</span>
              </p>
            ))}
        </div>
      </Section>

      {isLoading || !data ? (
        isError ? <p className="text-xs text-red-300">Could not read the details.</p> : <div className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></div>
      ) : (
        <>
          <Section title={side === "behind" ? "Filed here as" : `${name} files it as`}>
            <div className="flex flex-wrap gap-1">
              <Chip text={data.video} />
              {data.aliases.map((alias) => <Chip key={alias} text={alias} />)}
            </div>
          </Section>

          {side === "behind" && (
            <Section title={`Sent to ${name} as`}>
              {data.match && <p className="flex items-center gap-1.5 text-xs text-blue-200"><Link2 className="size-3.5" /> Matched by hand to {data.match.title}{data.match.year ? ` (${data.match.year})` : ""}</p>}
              {data.sendsAs ? (
                <div className="flex flex-wrap items-center gap-1">
                  {Object.entries(data.sendsAs.ids).map(([kind, value]) => <Chip key={kind} label={ID_LABELS[kind] ?? kind} text={String(value)} />)}
                  {data.sendsAs.season !== null && data.sendsAs.episode !== null && <span className="pl-1 text-[11px] text-muted-foreground">as S{data.sendsAs.season}E{data.sendsAs.episode}</span>}
                </div>
              ) : (
                <p className="text-xs text-amber-200/90">{data.sendError ?? `Nothing ${name} can take`}</p>
              )}
            </Section>
          )}

          {data.holds && (
            <Section title={`On ${name}`}>
              <p className={cx("text-xs", data.holds.found ? "text-foreground/90" : "text-amber-200/90")}>
                {data.holds.kind === "movie"
                  ? data.holds.found ? `Watched${data.holds.watchedAt ? ` ${day(data.holds.watchedAt)}` : ""}` : `${name} has nothing under these ids`
                  : data.holds.found
                    ? `${data.holds.watched} of ${data.holds.total || "?"} episodes watched${data.holds.at ? `, last ${day(data.holds.at)}` : ""}`
                    : `${name} has no show under these ids`}
              </p>
              {data.holds.kind === "series" && data.holds.season !== undefined && (
                <p className="text-xs text-muted-foreground">
                  Season {data.holds.season} {data.holds.numbers?.length ? <>held as episodes <span className="text-foreground/90">{ranges(data.holds.numbers)}</span></> : "has no episodes held under these ids"}
                  {data.holds.upTo ? ` (episodes 1 to ${data.holds.upTo} checked)` : ""}
                </p>
              )}
            </Section>
          )}

          {data.attempts.length > 0 && (
            <Section title="Lately">
              <div className="space-y-1">
                {data.attempts.slice(0, 4).map((attempt, i) => (
                  <div key={`${attempt.at}-${i}`} className="flex gap-2 text-xs">
                    <span className={cx("mt-1.5 size-1.5 shrink-0 rounded-full", attempt.kind === "sent" ? "bg-emerald-400" : attempt.kind === "failed" ? "bg-red-400" : "bg-white/40")} />
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground/90">{attempt.kind === "sent" ? "Sent" : attempt.kind === "failed" ? "Gave up" : "Dropped"}</span>
                      <span className="text-muted-foreground"> · {moment(attempt.at)} · <span className="font-mono">{attempt.video}</span></span>
                      {attempt.reason && <span className="block truncate text-muted-foreground" title={attempt.reason}>{attempt.reason}</span>}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

export default function DriftInfo({ userUUID, laneKey, service, side, item, activeTab, children }: {
  userUUID: string;
  laneKey: string;
  service: string;
  side: "behind" | "ahead" | "again";
  item: JellyfinDriftItem;
  activeTab: DashboardTab;
  children: React.ReactElement;
}) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={150}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <button type="button" onClick={() => setOpen(true)} aria-label={`Details: ${item.title ?? "this title"}`} className="flex size-8 shrink-0 items-center justify-center rounded-full text-foreground/70 transition hover:bg-white/10 sm:hidden">
          <Info className="size-4" />
        </button>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="z-50 w-[min(26rem,calc(100vw-1.5rem))] rounded-xl border border-white/[0.08] bg-popover/95 p-4 text-left text-sm text-popover-foreground shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-xl animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
          >
            <Detail userUUID={userUUID} laneKey={laneKey} service={service} side={side} item={item} activeTab={activeTab} open={open} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
