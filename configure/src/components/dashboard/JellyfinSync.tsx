import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Film, Loader2, MoreHorizontal, RefreshCw, RotateCcw, Send, Trash2, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useJellyfinSync, useJellyfinSyncActions, type DashboardTab, type JellyfinSyncFeedItem, type JellyfinSyncLane, type JellyfinSyncPulse, type JellyfinSyncRow, type JellyfinSyncWrite } from "@/hooks/useDashboardQueries";
import { CARD_SERVICES } from "@/lib/cardAccounts";
import { ShelfTitle } from "./JellyfinShared";
import { useFolded, when } from "./jellyfinUtils";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

const HOUR = 3_600_000;
const PAST = 24 * HOUR;
const AHEAD = 3 * HOUR;

type Brand = { name: string; mark: string; tone: string; tile: string; from: string; to: string };

const SERVICES: Record<string, Brand> = {
  simkl: { name: "Simkl", mark: "S", tone: "from-zinc-200 to-zinc-400 text-zinc-900", tile: "bg-[#0d0d0f]", from: "#2a2b30", to: "#050506" },
  mdblist: { name: "MDBList", mark: "M", tone: "from-sky-400 to-blue-600 text-white", tile: "bg-[#4a86d0]", from: "#62a1ea", to: "#24518f" },
  publicmetadb: { name: "PublicMetaDB", mark: "P", tone: "from-zinc-300 to-zinc-500 text-black", tile: "bg-[#ebebeb]", from: "#45454d", to: "#111114" },
  anilist: { name: "AniList", mark: "A", tone: "from-sky-400 to-blue-600 text-white", tile: "bg-[#152232]", from: "#21405f", to: "#0b1622" },
  mal: { name: "MyAnimeList", mark: "MAL", tone: "from-indigo-400 to-indigo-700 text-white", tile: "bg-[#2e51a2]", from: "#4069c9", to: "#182b63" },
};
const serviceOf = (service: string): Brand => SERVICES[service] ?? { name: service, mark: service.slice(0, 1).toUpperCase(), tone: "from-zinc-500 to-zinc-700 text-white", tile: "bg-zinc-700", from: "#3f3f46", to: "#18181b" };

function Mark({ service, size = "md" }: { service: string; size?: "sm" | "md" | "lg" }) {
  const s = serviceOf(service);
  const icon = (CARD_SERVICES as Record<string, { icon?: string }>)[service]?.icon;
  const [failed, setFailed] = useState(false);
  const box = size === "lg" ? "size-12 rounded-2xl" : size === "md" ? "size-10 rounded-xl" : "size-5 rounded-md";
  if (icon && !failed) {
    return (
      <span aria-hidden className={cx("inline-flex shrink-0 items-center justify-center overflow-hidden shadow-lg shadow-black/30 ring-1 ring-inset ring-white/20", s.tile, box)}>
        <img src={icon} alt="" onError={() => setFailed(true)} className="h-full w-full object-cover" />
      </span>
    );
  }
  return (
    <span aria-hidden className={cx("inline-flex shrink-0 items-center justify-center bg-gradient-to-br font-black tracking-tight shadow-lg shadow-black/30 ring-1 ring-inset ring-white/20", s.tone, box, size === "sm" ? (s.mark.length > 1 ? "text-[6px]" : "text-[9px]") : (s.mark.length > 1 ? "text-[11px]" : "text-[15px]"))}>
      {s.mark}
    </span>
  );
}

function useNow(active: boolean, every = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [active, every]);
  return now;
}

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function countdown(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const h = Math.floor(s / 3600);
  return `${h} h ${Math.round((s % 3600) / 60)} min`;
}

const limited = (text: string | null) => Boolean(text && /\b429\b|quota|limit|allowance/i.test(text));

type Tone = "ok" | "waiting" | "paused" | "failing" | "idle";

function laneState(lane: JellyfinSyncLane, now: number): { tone: Tone; headline: string } {
  const name = serviceOf(lane.service).name;
  if (lane.readError) return { tone: "failing", headline: `Can't read ${name}` };
  if (lane.pending > 0) {
    const next = lane.nextTryAt ? lane.nextTryAt - now : 0;
    if (limited(lane.lastError)) return { tone: "paused", headline: `Paused by ${name}'s limit · next try ${next > 0 ? `in ${countdown(next)}` : "now"}` };
    if (lane.lastError) return { tone: "failing", headline: `${lane.pending} waiting · retrying ${next > 0 ? `in ${countdown(next)}` : "now"}` };
    return { tone: "waiting", headline: `${lane.pending} waiting · sending ${next > 0 ? `in ${countdown(next)}` : "now"}` };
  }
  if (!lane.imported) return { tone: "idle", headline: "Not read yet" };
  return { tone: "ok", headline: "All caught up" };
}

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,.8)]",
  waiting: "bg-blue-400 shadow-[0_0_12px_rgba(96,165,250,.8)]",
  paused: "bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,.8)]",
  failing: "bg-red-500 shadow-[0_0_12px_rgba(239,68,68,.8)]",
  idle: "bg-zinc-500",
};

const PULSE_LABEL: Record<JellyfinSyncPulse["kind"], string> = { read: "Read", readFailed: "Read failed", sent: "Sent", retry: "Will retry", failed: "Failed", dropped: "Dropped" };

function PulseMark({ event, left }: { event: JellyfinSyncPulse; left: number }) {
  const style = { left: `${left}%` };
  if (event.kind === "read") {
    const tall = event.full ? "h-9 bg-blue-300 shadow-[0_0_10px_rgba(147,197,253,.9)]" : event.changed ? "h-6 bg-blue-400" : "h-3.5 bg-blue-400/50";
    return <span style={style} className={cx("absolute top-1/2 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full", tall)} />;
  }
  const dot = event.kind === "sent" ? "size-2 bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,.9)]"
    : event.kind === "retry" ? "size-2 bg-amber-400"
    : event.kind === "dropped" ? "size-2 bg-zinc-400"
    : "size-2.5 bg-red-500 ring-4 ring-red-500/25";
  return <span style={style} className={cx("absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full", dot)} />;
}

function PulseStrip({ lane, queue, now, syncing, tone, titles }: { lane: JellyfinSyncLane; queue: JellyfinSyncWrite[]; now: number; syncing: boolean; tone: Tone; titles: Map<string, string> }) {
  const track = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; text: string; sub: string } | null>(null);
  const start = now - PAST;
  const span = PAST + AHEAD;
  const pos = (at: number) => Math.max(0, Math.min(100, ((at - start) / span) * 100));
  const nowAt = pos(now);
  const events = lane.pulse.filter((e) => e.at >= start);
  const ahead = queue.map((w) => ({ at: Math.max(now, w.nextAt), w }));

  const hover = (event: React.MouseEvent) => {
    const box = track.current?.getBoundingClientRect();
    if (!box) return;
    const x = event.clientX - box.left;
    let best: { d: number; text: string; sub: string; x: number } | null = null;
    for (const e of events) {
      const px = (pos(e.at) / 100) * box.width;
      const d = Math.abs(px - x);
      if (d > 8 || (best && d >= best.d)) continue;
      const what = e.kind === "read" ? (e.full ? "Read everything" : e.changed ? "Read new changes" : "Read, nothing new") : `${PULSE_LABEL[e.kind]} · ${e.verb ?? ""}`;
      const title = e.video ? titles.get(e.video) : null;
      best = { d, x: px, text: what, sub: [clock(e.at), title, e.kind !== "read" && e.reason ? e.reason : null].filter(Boolean).join(" · ") };
    }
    for (const { at, w } of ahead) {
      const px = (pos(at) / 100) * box.width;
      const d = Math.abs(px - x);
      if (d > 8 || (best && d >= best.d)) continue;
      best = { d, x: px, text: `Waiting · ${w.verb}`, sub: [w.title, w.sending ? "sending now" : `next try ${clock(w.nextAt)}`].filter(Boolean).join(" · ") };
    }
    setTip(best ? { x: best.x, text: best.text, sub: best.sub } : null);
  };

  return (
    <div className="relative">
      <div
        ref={track}
        onMouseMove={hover}
        onMouseLeave={() => setTip(null)}
        className="relative h-12 overflow-hidden rounded-xl bg-black/25 ring-1 ring-inset ring-white/[0.06]"
        role="img"
        aria-label={`${serviceOf(lane.service).name}: ${lane.sent} sent and ${lane.failed} failed in the last 24 hours`}
      >
        <span className="absolute inset-x-0 top-1/2 h-px bg-white/10" />
        {[6, 12, 18].map((h) => <span key={h} style={{ left: `${pos(now - h * HOUR)}%` }} className="absolute inset-y-2 w-px bg-white/[0.05]" />)}
        <span style={{ left: `${nowAt}%` }} className="absolute inset-y-0 right-0 bg-[repeating-linear-gradient(135deg,rgba(255,255,255,.035)_0_6px,transparent_6px_12px)]" />
        {events.map((e, i) => <PulseMark key={i} event={e} left={pos(e.at)} />)}
        {ahead.map(({ at, w }) => (
          <span key={w.id} style={{ left: `${pos(at)}%` }} className={cx("absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2", w.lastError ? "border-amber-400" : "border-blue-300", w.sending && "animate-pulse")} />
        ))}
        <span style={{ left: `${nowAt}%` }} className="absolute inset-y-1 w-px -translate-x-1/2 bg-white/40" />
        <span style={{ left: `${nowAt}%` }} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2">
          <span className={cx("absolute -inset-1 animate-ping rounded-full opacity-60", TONE_DOT[tone].split(" ")[0])} />
          <span className={cx("relative block size-2.5 rounded-full", TONE_DOT[tone])} />
        </span>
        {syncing && <span className="pointer-events-none absolute inset-0 animate-[shimmer_1.4s_linear_infinite] bg-[linear-gradient(90deg,transparent_0%,rgba(96,165,250,.28)_50%,transparent_100%)] bg-[length:40%_100%] bg-no-repeat" />}
      </div>
      <div className="relative mt-1 h-3 text-[10px] tabular-nums text-muted-foreground/70">
        <span className="absolute left-0">24 h ago</span>
        {[12, 6].map((h) => <span key={h} style={{ left: `${pos(now - h * HOUR)}%` }} className="absolute -translate-x-1/2 max-sm:hidden">{h} h</span>)}
        <span style={{ left: `${nowAt}%` }} className="absolute -translate-x-1/2 font-medium text-foreground/70">now</span>
        <span className="absolute right-0 max-sm:hidden">+3 h</span>
      </div>
      {tip && (
        <div style={{ left: Math.max(8, Math.min(tip.x, (track.current?.clientWidth ?? 0) - 8)) }} className="pointer-events-none absolute bottom-full z-20 mb-2 max-w-72 -translate-x-1/2 rounded-lg bg-popover/95 px-2.5 py-1.5 text-xs shadow-xl ring-1 ring-white/10 backdrop-blur-xl">
          <p className="font-medium">{tip.text}</p>
          {tip.sub && <p className="truncate text-muted-foreground">{tip.sub}</p>}
        </div>
      )}
    </div>
  );
}

const GLOW: Record<Tone, string> = {
  ok: "rgba(52, 211, 153, 0.5)",
  waiting: "rgba(96, 165, 250, 0.6)",
  paused: "rgba(251, 191, 36, 0.6)",
  failing: "rgba(239, 68, 68, 0.75)",
  idle: "transparent",
};

function shortState(lane: JellyfinSyncLane, tone: Tone): string {
  if (tone === "failing") return lane.readError ? "Can't read" : "Retrying";
  if (tone === "paused") return "Paused";
  if (tone === "waiting") return `${lane.pending} waiting`;
  if (tone === "idle") return "Not read yet";
  return "Caught up";
}

function Spark({ pulse, now }: { pulse: JellyfinSyncPulse[]; now: number }) {
  const bins = Array.from({ length: 24 }, () => ({ sent: 0, failed: 0, read: 0 }));
  for (const e of pulse) {
    const i = 23 - Math.floor((now - e.at) / HOUR);
    if (i < 0 || i > 23) continue;
    if (e.kind === "sent") bins[i].sent += 1;
    else if (e.kind === "failed" || e.kind === "readFailed") bins[i].failed += 1;
    else if (e.kind === "read") bins[i].read += 1;
  }
  const most = Math.max(1, ...bins.map((b) => b.sent + b.failed));
  return (
    <div aria-hidden className="flex h-9 items-end gap-[3px]">
      {bins.map((b, i) => {
        const total = b.sent + b.failed;
        return (
          <div key={i} className="relative flex h-full flex-1 flex-col justify-end">
            {total > 0 ? (
              <div style={{ height: `${Math.max(14, (total / most) * 100)}%` }} className="flex flex-col overflow-hidden rounded-[2px]">
                {b.failed > 0 && <div style={{ flexGrow: b.failed }} className="bg-red-300" />}
                {b.sent > 0 && <div style={{ flexGrow: b.sent }} className="bg-white/85" />}
              </div>
            ) : b.read > 0 ? <div className="mx-auto size-1 rounded-full bg-white/55" /> : <div className="h-[2px] rounded-full bg-white/15" />}
          </div>
        );
      })}
    </div>
  );
}

function WalletCard({ lane, now, tone, top, z, selected, syncing, stamp, onSelect }: {
  lane: JellyfinSyncLane;
  now: number;
  tone: Tone;
  top: number;
  z: number;
  selected: boolean;
  syncing: boolean;
  stamp: { kind: "sent" | "failed"; at: number } | null;
  onSelect: () => void;
}) {
  const brand = serviceOf(lane.service);
  const icon = (CARD_SERVICES as Record<string, { icon?: string }>)[lane.service]?.icon;
  const card = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  const calm = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const lifted = hover || selected;
  const frame = useRef(0);
  const pointer = useRef({ px: 0.5, py: 0.3 });
  // Set on the element once a frame, so following the pointer never re-renders.
  const lean = () => {
    frame.current = 0;
    const el = card.current;
    if (!el) return;
    const { px, py } = pointer.current;
    el.style.setProperty("--rx", `${(0.5 - py) * 8}deg`);
    el.style.setProperty("--ry", `${(px - 0.5) * 10}deg`);
    el.style.setProperty("--tx", `${(px - 0.5) * el.offsetWidth}px`);
    el.style.setProperty("--ty", `${(py - 0.5) * el.offsetHeight}px`);
  };
  const move = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (calm) return;
    const box = event.currentTarget.getBoundingClientRect();
    pointer.current = { px: (event.clientX - box.left) / box.width, py: (event.clientY - box.top) / box.height };
    if (!frame.current) frame.current = requestAnimationFrame(lean);
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  return (
    <div
      data-wallet={lane.service}
      style={{ transform: `translate3d(${selected ? 20 : 0}px, ${top - (hover ? 10 : 0)}px, 0)`, zIndex: z }}
      className="absolute inset-x-0 top-0 transition-transform duration-500 [transition-timing-function:cubic-bezier(.2,.8,.2,1)]"
    >
      {tone !== "idle" && <span aria-hidden style={{ backgroundColor: GLOW[tone] }} className="pointer-events-none absolute inset-x-6 bottom-0 top-10 -z-10 animate-breathe rounded-[28px] blur-2xl" />}
      <button
        ref={card}
        type="button"
        onClick={onSelect}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => { setHover(false); pointer.current = { px: 0.5, py: 0.5 }; if (!frame.current) frame.current = requestAnimationFrame(lean); }}
        onMouseMove={move}
        aria-pressed={selected}
        aria-label={`${brand.name}: ${shortState(lane, tone)}`}
        style={{
          backgroundImage: `linear-gradient(135deg, ${brand.from}, ${brand.to})`,
          transform: lifted ? `perspective(1100px) rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg)) scale(${selected ? 1.02 : 1})` : "perspective(1100px) rotateX(14deg)",
        }}
        className="group relative block h-[188px] w-full origin-top overflow-hidden rounded-[22px] text-left text-white will-change-transform shadow-[0_0_0_1px_rgba(255,255,255,.12),0_24px_48px_-24px_rgba(0,0,0,.9)] transition-transform duration-500 [transition-timing-function:cubic-bezier(.2,.8,.2,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <span aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,.24)_0%,rgba(255,255,255,0)_42%)]" />
        <span aria-hidden style={{ transform: "translate3d(var(--tx, 0px), var(--ty, 0px), 0)" }} className={cx("pointer-events-none absolute -inset-1/2 bg-[radial-gradient(circle_at_center,rgba(255,255,255,.2),transparent_32%)] transition-opacity duration-300 will-change-transform", lifted ? "opacity-100" : "opacity-0")} />
        {icon && <img aria-hidden src={icon} alt="" className="pointer-events-none absolute -bottom-10 -right-8 size-44 rotate-12 rounded-[36px] opacity-[0.12]" />}
        {syncing && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-1/3 animate-sweep bg-gradient-to-r from-transparent via-white/30 to-transparent" />}
        <span className="relative flex h-full flex-col justify-between p-5">
          <span className="flex items-start gap-3">
            <Mark service={lane.service} size="lg" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-lg font-bold leading-tight drop-shadow">{brand.name}</span>
              <span className="block truncate text-xs text-white/65">{lane.profiles.join(", ")}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-black/35 px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ring-white/15">
              <span className={cx("size-1.5 rounded-full", TONE_DOT[tone])} />
              {shortState(lane, tone)}
            </span>
          </span>
          <span className="flex items-end justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-4xl font-black leading-none tabular-nums drop-shadow">{lane.sent}</span>
              <span className="mt-1 block text-xs text-white/70">sent today{lane.failed > 0 ? ` · ${lane.failed} failed` : ""}</span>
            </span>
            <span className="w-[46%] max-w-48 shrink-0">
              <Spark pulse={lane.pulse} now={now} />
              <span className="mt-1 block text-right text-[10px] text-white/60">last read {lane.syncedAt ? when(lane.syncedAt) : "never"}</span>
            </span>
          </span>
        </span>
        {stamp && (
          <span key={stamp.at} aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className={cx("flex size-20 animate-stamp items-center justify-center rounded-full border-4", stamp.kind === "sent" ? "border-emerald-300 bg-emerald-500/25 text-emerald-100" : "border-red-300 bg-red-500/25 text-red-100")}>
              {stamp.kind === "sent" ? <Check className="size-10" strokeWidth={3.5} /> : <X className="size-10" strokeWidth={3.5} />}
            </span>
          </span>
        )}
      </button>
    </div>
  );
}

function Recent({ items, service }: { items: JellyfinSyncFeedItem[]; service: string }) {
  const mine = items.filter((item) => item.services.some((m) => m.service === service)).slice(0, 12);
  if (!mine.length) return <p className="text-xs text-muted-foreground">Nothing sent to {serviceOf(service).name} lately.</p>;
  return (
    <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {mine.map((item, i) => {
        const mark = item.services.find((m) => m.service === service)!;
        const ok = mark.kind === "sent";
        return (
          <div key={`${item.at}-${i}`} title={mark.reason ?? undefined} className="group relative w-44 shrink-0 snap-start overflow-hidden rounded-xl ring-1 ring-white/10 animate-fade-in">
            <Still src={item.imageUrl} className="w-full rounded-none transition-transform duration-500 group-hover:scale-105" />
            <span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
            <span className={cx("absolute right-2 top-2 flex size-6 items-center justify-center rounded-full shadow-lg", ok ? "bg-emerald-400 text-black" : mark.kind === "failed" ? "bg-red-500 text-white" : "bg-zinc-400 text-black")}>
              {ok ? <Check className="size-3.5" strokeWidth={3.5} /> : <X className="size-3.5" strokeWidth={3.5} />}
            </span>
            <span className="absolute inset-x-0 bottom-0 p-2">
              <span className="block truncate text-[11px] font-semibold text-white">{item.verb}</span>
              <span className="block truncate text-[10px] text-white/70">{[item.title, item.episode].filter(Boolean).join(" · ") || clock(item.at)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CardBack({ lane, queue, feed, now, titles, syncing, onRun, onOutbox }: {
  lane: JellyfinSyncLane;
  queue: JellyfinSyncWrite[];
  feed: JellyfinSyncFeedItem[];
  now: number;
  titles: Map<string, string>;
  syncing: boolean;
  onRun: (full: boolean) => void;
  onOutbox: (action: "retry" | "drop", ids: number[]) => Promise<void>;
}) {
  const brand = serviceOf(lane.service);
  const { tone, headline } = laneState(lane, now);
  const ids = queue.map((w) => w.id);
  const reason = lane.readError ?? (tone !== "paused" ? lane.lastError : null);
  return (
    <div className="animate-card-in overflow-hidden rounded-[22px] bg-black/30 shadow-2xl shadow-black/40 ring-1 ring-white/10 backdrop-blur-xl">
      <div style={{ backgroundImage: `linear-gradient(120deg, ${brand.from}, ${brand.to} 70%)` }} className="relative overflow-hidden p-5">
        <span aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,.18)_0%,rgba(255,255,255,0)_45%)]" />
        <div className="relative flex flex-wrap items-center gap-x-4 gap-y-3">
          <Mark service={lane.service} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="text-xl font-bold text-white">{brand.name}</p>
            <p className="mt-0.5 flex items-center gap-2 text-sm font-medium text-white/90">
              <span className={cx("size-2 shrink-0 rounded-full", TONE_DOT[tone])} />
              <span className="min-w-0 truncate">{headline}</span>
            </p>
          </div>
          <div className="flex items-center gap-1.5 max-sm:w-full">
            <button type="button" onClick={() => onRun(false)} disabled={syncing} className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-white px-4 max-sm:flex-1 text-sm font-semibold text-black shadow-lg shadow-black/30 transition hover:bg-white/90 active:scale-[0.98] disabled:opacity-70">
              <RefreshCw className={cx("size-4", syncing && "animate-spin")} /> {syncing ? "Reading…" : <><span className="max-sm:hidden">Refresh from {brand.name}</span><span className="sm:hidden" aria-label={`Refresh from ${brand.name}`}>Refresh</span></>}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={`More for ${brand.name}`} className="flex size-10 items-center justify-center rounded-full bg-black/25 text-white ring-1 ring-inset ring-white/20 backdrop-blur transition hover:bg-black/40"><MoreHorizontal className="size-4" /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem disabled={syncing} onSelect={() => onRun(true)}><RotateCcw className="size-4" /> Read all of {brand.name} again</DropdownMenuItem>
                <DropdownMenuItem disabled={!ids.length} onSelect={() => void onOutbox("retry", ids)}><Send className="size-4" /> Send waiting writes now</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!ids.length} onSelect={() => void onOutbox("drop", ids)} className="text-red-300 focus:text-red-200"><Trash2 className="size-4" /> Drop waiting writes</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {reason && <p className="relative mt-3 rounded-xl bg-black/35 px-3 py-2 text-xs leading-relaxed text-red-100 ring-1 ring-inset ring-red-300/30">{reason}</p>}
      </div>
      <div className="space-y-6 p-5">
        <PulseStrip lane={lane} queue={queue} now={now} syncing={syncing} tone={tone} titles={titles} />
        <div className="grid grid-cols-3 gap-3 text-center">
          {[
            [String(lane.sent), "sent today", "text-emerald-300"],
            [String(lane.failed), "failed today", lane.failed ? "text-red-300" : "text-foreground/60"],
            [lane.syncedAt ? when(lane.syncedAt) : "never", "last read", "text-foreground"],
          ].map(([value, label, color]) => (
            <div key={label} className="rounded-xl bg-white/[0.04] px-2 py-3 ring-1 ring-inset ring-white/[0.06]">
              <p className={cx("truncate text-base font-bold tabular-nums sm:text-lg", color)}>{value}</p>
              <p className="text-[11px] text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
        {queue.length > 0 && (
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Waiting to send to {brand.name} <span className="tabular-nums">({queue.length})</span></p>
            <div className="space-y-2">{queue.map((write) => <QueueItem key={write.id} write={write} now={now} onOutbox={onOutbox} />)}</div>
          </div>
        )}
        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Recently sent to {brand.name}</p>
          <Recent items={feed} service={lane.service} />
        </div>
        <p className="text-[11px] text-muted-foreground">Last full read {lane.fullAt ? when(lane.fullAt) : "never"}. Refreshing only reads from {brand.name}; nothing is changed there.</p>
      </div>
    </div>
  );
}

function Still({ src, className }: { src: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  return src && !failed
    ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className={cx("aspect-video shrink-0 rounded-md object-cover", className)} />
    : <span className={cx("flex aspect-video shrink-0 items-center justify-center rounded-md bg-white/5", className)}><Film className="size-4 text-muted-foreground" /></span>;
}

function Ring({ write, now }: { write: JellyfinSyncWrite; now: number }) {
  const left = Math.max(0, write.nextAt - now);
  const whole = Math.max(30_000, write.nextAt - write.createdAt);
  const share = Math.min(1, left / whole);
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative flex size-11 shrink-0 items-center justify-center">
      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="3" />
        <circle cx="18" cy="18" r={r} fill="none" stroke={write.lastError ? "rgb(251 191 36)" : "rgb(96 165 250)"} strokeWidth="3" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - share)} className="transition-[stroke-dashoffset] duration-1000 ease-linear" />
      </svg>
      {write.sending || left <= 0
        ? <Loader2 className="size-4 animate-spin text-blue-300" />
        : <span className="text-[9px] font-semibold tabular-nums">{left < 3_600_000 ? countdown(left) : `${Math.round(left / 3_600_000)}h`}</span>}
    </div>
  );
}

function QueueItem({ write, now, onOutbox }: { write: JellyfinSyncWrite; now: number; onOutbox: (action: "retry" | "drop", ids: number[]) => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-2 animate-fade-in">
      <Still src={write.imageUrl} className="w-20 sm:w-24" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{write.verb}</p>
        <p className="truncate text-xs text-muted-foreground">{[write.title, write.episode].filter(Boolean).join(" · ") || write.video}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Mark service={write.service} size="sm" /> {serviceOf(write.service).name}
          {write.attempts > 0 && <span>· tried {write.attempts}×</span>}
          {write.lastError && <span className="min-w-0 truncate text-amber-300/90" title={write.lastError}>· {write.lastError}</span>}
        </p>
      </div>
      <Ring write={write} now={now} />
      {confirm ? (
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => void onOutbox("drop", [write.id])} className="h-8 rounded-full bg-red-500/90 px-3 text-xs font-semibold text-white transition hover:bg-red-500">Drop</button>
          <button type="button" onClick={() => setConfirm(false)} aria-label="Keep it" className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-white/10"><X className="size-4" /></button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => void onOutbox("retry", [write.id])} disabled={write.sending} title="Send now" aria-label="Send now" className="flex size-8 items-center justify-center rounded-full text-foreground/80 transition hover:bg-white/10 hover:text-foreground disabled:opacity-40"><Send className="size-4" /></button>
          <button type="button" onClick={() => setConfirm(true)} disabled={write.sending} title="Drop" aria-label="Drop" className="flex size-8 items-center justify-center rounded-full text-foreground/60 transition hover:bg-white/10 hover:text-red-300 disabled:opacity-40"><Trash2 className="size-4" /></button>
        </div>
      )}
    </div>
  );
}

function dayLabel(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 24 * HOUR);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function FeedRow({ item }: { item: JellyfinSyncFeedItem }) {
  return (
    <div className="flex items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/[0.04]">
      <Still src={item.imageUrl} className="w-16 sm:w-20" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm"><span className="font-medium">{item.verb}</span>{item.title && <span className="text-muted-foreground"> · {[item.title, item.episode].filter(Boolean).join(" · ")}</span>}</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {item.services.map((m) => (
            <span key={m.service} title={m.reason ?? undefined} className={cx("inline-flex items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2 text-[11px] ring-1 ring-inset", m.kind === "sent" ? "bg-emerald-500/10 text-emerald-200 ring-emerald-400/25" : m.kind === "failed" ? "bg-red-500/10 text-red-200 ring-red-400/30" : "bg-white/5 text-muted-foreground ring-white/10")}>
              <Mark service={m.service} size="sm" />
              {serviceOf(m.service).name}
              {m.kind === "sent" ? <Check className="size-3" strokeWidth={3} /> : m.kind === "failed" ? <X className="size-3" strokeWidth={3} /> : <span>dropped</span>}
            </span>
          ))}
        </div>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{clock(item.at)}</span>
    </div>
  );
}

function Chips({ rows, onOpen }: { rows: JellyfinSyncRow[]; onOpen: (service: string) => void }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">No tracker connected. History stays on this server.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {rows.map((row, i) => {
        const tone: Tone = row.readError ? "failing" : row.lastError ? (limited(row.lastError) ? "paused" : "failing") : row.pending > 0 ? "waiting" : row.imported ? "ok" : "idle";
        return (
          <button key={`${row.service}-${i}`} type="button" onClick={() => onOpen(row.service)} className="glass inline-flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-xs transition hover:bg-white/[0.12]">
            <Mark service={row.service} size="sm" />
            <span className="font-medium">{serviceOf(row.service).name}</span>
            <span className={cx("size-1.5 rounded-full", TONE_DOT[tone])} />
            <span className={row.readError ? "text-red-300" : "text-muted-foreground"}>{row.readError ? "can't read" : row.pending > 0 ? `${row.pending} waiting to send` : row.imported ? `last read ${when(row.syncedAt)}` : "not read yet"}</span>
          </button>
        );
      })}
    </div>
  );
}

const CARD_H = 188;

function useArrivals(feed: JellyfinSyncFeedItem[] | undefined, from: React.RefObject<HTMLElement | null>, land: (service: string, kind: "sent" | "failed") => void) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!feed) return;
    const keyOf = (item: JellyfinSyncFeedItem) => `${item.at}|${item.video}|${item.verb}`;
    if (!seen.current) {
      seen.current = new Set(feed.map(keyOf));
      return;
    }
    const fresh = feed.filter((item) => !seen.current!.has(keyOf(item))).slice(0, 4);
    for (const item of feed) seen.current.add(keyOf(item));
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    fresh.forEach((item, i) => {
      for (const mark of item.services) {
        const kind = mark.kind === "sent" ? "sent" : "failed";
        const card = document.querySelector(`[data-wallet="${CSS.escape(mark.service)}"]`);
        if (!card || calm || !item.imageUrl) {
          land(mark.service, kind);
          continue;
        }
        const to = card.getBoundingClientRect();
        const start = from.current?.getBoundingClientRect() ?? to;
        const width = 168;
        const x0 = start.left + start.width / 2 - width / 2;
        const y0 = start.top + 40;
        const img = document.createElement("img");
        img.src = item.imageUrl;
        img.alt = "";
        Object.assign(img.style, { position: "fixed", left: `${x0}px`, top: `${y0}px`, width: `${width}px`, aspectRatio: "16 / 9", objectFit: "cover", borderRadius: "12px", boxShadow: "0 20px 40px rgba(0,0,0,.6)", zIndex: "140", pointerEvents: "none", opacity: "0" });
        document.body.appendChild(img);
        const dx = to.left + to.width / 2 - (x0 + width / 2);
        const dy = to.top + CARD_H / 2 - (y0 + (width * 9) / 32);
        img.animate(
          [
            { transform: "translate(0, 0) scale(1) rotate(0deg)", opacity: 0 },
            { transform: "translate(0, -12px) scale(1.04) rotate(-2deg)", opacity: 1, offset: 0.2 },
            { transform: `translate(${dx}px, ${dy}px) scale(0.3) rotate(-10deg)`, opacity: 0.85 },
          ],
          { duration: 950, delay: i * 220, easing: "cubic-bezier(.55,0,.2,1)", fill: "forwards" }
        ).finished.then(() => { img.remove(); land(mark.service, kind); }, () => img.remove());
      }
    });
  }, [feed, from, land]);
}

export default function JellyfinSync({ userUUID, profile, rows, activeTab }: { userUUID: string; profile: string | null; rows: JellyfinSyncRow[]; activeTab: DashboardTab }) {
  const [folded, fold] = useFolded("jellyfin.fold.sync", true);
  const [chosen, setChosen] = useState<string | null>(null);
  const [allFeed, setAllFeed] = useState(false);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [stamps, setStamps] = useState<Record<string, { kind: "sent" | "failed"; at: number }>>({});
  const back = useRef<HTMLDivElement>(null);
  const { data, isLoading, refetch } = useJellyfinSync(userUUID, profile, !folded, { activeTab });
  const actions = useJellyfinSyncActions();
  const queryClient = useQueryClient();
  const waiting = (data?.queue.length ?? 0) > 0;
  const now = useNow(!folded && Boolean(data), waiting ? 1000 : 15_000);
  const [phone] = useState(() => window.matchMedia("(max-width: 1023px)").matches);

  useEffect(() => {
    if (folded || !waiting) return;
    const timer = window.setInterval(() => void refetch(), 3000);
    return () => window.clearInterval(timer);
  }, [folded, waiting, refetch]);

  const land = useCallback((service: string, kind: "sent" | "failed") => setStamps((held) => ({ ...held, [service]: { kind, at: Date.now() } })), []);
  useArrivals(data?.feed, back, land);

  const titles = useMemo(() => {
    const out = new Map<string, string>();
    for (const item of [...(data?.queue ?? []), ...(data?.feed ?? [])]) if (item.video && item.title) out.set(item.video, [item.title, item.episode].filter(Boolean).join(" · "));
    return out;
  }, [data]);

  const lanes = useMemo(() => data?.lanes ?? [], [data]);
  const tones = useMemo(() => new Map(lanes.map((lane) => [lane.key, laneState(lane, now).tone])), [lanes, now]);
  const selected = lanes.find((lane) => lane.key === chosen)
    ?? lanes.find((lane) => tones.get(lane.key) === "failing")
    ?? lanes.find((lane) => tones.get(lane.key) === "paused" || tones.get(lane.key) === "waiting")
    ?? lanes[0];

  const refresh = () => {
    void refetch();
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "dashboard" && q.queryKey[1] === "jellyfin" && q.queryKey[2] !== "sync" && q.queryKey[2] !== "title" });
  };

  const runLane = async (lane: JellyfinSyncLane, full: boolean) => {
    const name = serviceOf(lane.service).name;
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

  const refreshAll = async () => {
    await Promise.all(lanes.map((lane) => runLane(lane, false)));
  };

  const pick = (key: string) => {
    setChosen(key);
    if (phone) requestAnimationFrame(() => back.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  const open = (service: string) => {
    if (folded) fold();
    const lane = lanes.find((l) => l.service === service);
    setChosen(lane?.key ?? null);
    if (!lane) setPending(service);
  };
  const [pendingService, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingService || !lanes.length) return;
    const lane = lanes.find((l) => l.service === pendingService);
    if (lane) setChosen(lane.key);
    setPending(null);
  }, [pendingService, lanes]);

  const feedDays = useMemo(() => {
    const items = (data?.feed ?? []).slice(0, allFeed ? undefined : 8);
    const out: Array<{ day: string; items: JellyfinSyncFeedItem[] }> = [];
    for (const item of items) {
      const day = dayLabel(item.at);
      const last = out[out.length - 1];
      if (last?.day === day) last.items.push(item);
      else out.push({ day, items: [item] });
    }
    return out;
  }, [data, allFeed]);

  const step = phone ? 60 : 68;
  const stackHeight = lanes.length ? (lanes.length - 1) * step + CARD_H + 24 : 0;

  return (
    <section className="space-y-4 px-4 py-4 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <ShelfTitle title="Trackers" count={null} folded={folded} onFold={fold} />
        {!folded && lanes.length > 1 && (
          <button type="button" onClick={() => void refreshAll()} disabled={running.size > 0} className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-white/10 hover:text-foreground disabled:opacity-60">
            <RefreshCw className={cx("size-3.5", running.size > 0 && "animate-spin")} /> Refresh all from trackers
          </button>
        )}
      </div>

      {folded ? <Chips rows={rows} onOpen={open} /> : isLoading && !data ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(300px,400px)_minmax(0,1fr)]">
          <Skeleton className="h-[420px] rounded-[22px]" />
          <Skeleton className="h-[420px] rounded-[22px]" />
        </div>
      ) : !data || lanes.length === 0 ? (
        <p className="text-xs text-muted-foreground">No tracker connected. History stays on this server.</p>
      ) : (
        <div className="space-y-8">
          <div className="grid gap-6 lg:grid-cols-[minmax(300px,400px)_minmax(0,1fr)] lg:items-start">
            <div className="lg:sticky lg:top-20">
              <div style={{ height: stackHeight }} className="relative">
                {lanes.map((lane, i) => (
                  <WalletCard
                    key={lane.key}
                    lane={lane}
                    now={now}
                    tone={tones.get(lane.key) ?? "idle"}
                    top={i * step}
                    z={i + 1}
                    selected={lane.key === selected?.key}
                    syncing={running.has(lane.key)}
                    stamp={stamps[lane.service] ?? null}
                    onSelect={() => pick(lane.key)}
                  />
                ))}
              </div>
            </div>
            <div ref={back} className="min-w-0 scroll-mt-20">
              {selected && (
                <CardBack
                  key={selected.key}
                  lane={selected}
                  queue={data.queue.filter((w) => w.lane === selected.key)}
                  feed={data.feed}
                  now={now}
                  titles={titles}
                  syncing={running.has(selected.key)}
                  onRun={(full) => void runLane(selected, full)}
                  onOutbox={outbox}
                />
              )}
            </div>
          </div>

          <div className="max-w-5xl space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Sent to trackers</p>
            {feedDays.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing sent to the trackers lately. Plays, marks, ratings and lists show here once they go out.</p>
            ) : (
              <div className="space-y-4">
                {feedDays.map((group) => (
                  <div key={group.day}>
                    <p className="mb-1 px-2 text-xs font-semibold text-foreground/80">{group.day}</p>
                    <div className="space-y-0.5">{group.items.map((item, i) => <FeedRow key={`${item.at}-${i}`} item={item} />)}</div>
                  </div>
                ))}
                {(data.feed.length > 8 || allFeed) && (
                  <button type="button" onClick={() => setAllFeed((v) => !v)} className="px-2 text-xs font-medium text-blue-300 hover:text-blue-200">{allFeed ? "Show less" : `Show all ${data.feed.length}`}</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
