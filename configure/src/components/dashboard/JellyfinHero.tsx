import React, { useEffect, useMemo, useRef, useState } from "react";
import { sizedArt } from "./art";
import { Loader2, Pause, Play } from "lucide-react";
import { type JellyfinConfiguration, type JellyfinProfileSummary, type JellyfinSessionRow } from "@/hooks/useDashboardQueries";
import { Art, ShelfTitle } from "./JellyfinShared";
import { Logo } from "./TrackerParts";
import { when, clock, duration, dayKey, useNow, useOpenTitle, titleRefOf, type Activity } from "./jellyfinUtils";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export function Avatar({ src, name, size, ringed }: { src: string | null; name: string; size: "sm" | "md" | "lg"; ringed?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const box = size === "lg" ? "h-14 w-14 text-xl" : size === "md" ? "h-7 w-7 text-xs" : "h-5 w-5 text-[10px]";
  const ring = ringed ? "ring-2 ring-background" : "ring-2 ring-white/10";
  if (src && !failed) return <img src={src} alt="" onError={() => setFailed(true)} className={`${box} shrink-0 rounded-full object-cover ${ring}`} />;
  return <span className={`${box} shrink-0 rounded-full bg-blue-500/20 text-blue-300 font-semibold flex items-center justify-center ${ring}`}>{(name.trim()[0] ?? "?").toUpperCase()}</span>;
}
function HeroStat({ label, value, hint, compact }: { label: string; value: string | number; hint?: string; compact?: boolean }) {
  return (
    <div className="min-w-0">
      <p className={cx("font-semibold tabular-nums leading-none sm:text-3xl", compact ? "text-xl" : "text-2xl")}>{value}</p>
      <p className={cx("mt-1 uppercase tracking-wide text-muted-foreground sm:text-[11px]", compact ? "text-[10px]" : "text-[11px]")}>{label}</p>
      {hint && <p className={cx("text-[11px] text-muted-foreground/80 truncate", compact && "max-sm:hidden")}>{hint}</p>}
    </div>
  );
}

/** Where a session has got to: between reports a playing one moves on from where it was last reported, until it reaches the end. */
function useLivePosition(s: JellyfinSessionRow): number {
  const moving = !s.paused && s.runtimeMs > 0;
  const now = useNow(moving && Date.now() < s.at + s.runtimeMs - s.positionMs, 1000);
  return moving ? Math.min(s.runtimeMs, s.positionMs + Math.max(0, now - s.at)) : s.positionMs;
}
const shareOf = (s: JellyfinSessionRow, positionMs: number) => (s.runtimeMs > 0 ? Math.min(100, (positionMs / s.runtimeMs) * 100) : 0);

/** An avatar ringed by how far its profile's session has got, or plain when nothing plays. */
export function LiveAvatar({ session, src, name, size }: { session: JellyfinSessionRow | undefined; src: string | null; name: string; size: "md" | "lg" }) {
  return session ? <RingedAvatar s={session} src={src} name={name} size={size} /> : <Avatar src={src} name={name} size={size} />;
}
function RingedAvatar({ s, src, name, size }: { s: JellyfinSessionRow; src: string | null; name: string; size: "md" | "lg" }) {
  const share = shareOf(s, useLivePosition(s));
  return (
    <span style={{ background: `conic-gradient(${s.paused ? "rgb(255 255 255 / 0.55)" : "#60a5fa"} ${share}%, rgb(255 255 255 / 0.16) 0)` }} className={cx("inline-flex shrink-0 rounded-full", size === "lg" ? "p-[3px]" : "p-0.5")}>
      <Avatar src={src} name={name} size={size} ringed />
    </span>
  );
}

function LiveDot({ paused }: { paused: boolean }) {
  return (
    <span className="relative flex size-[7px] shrink-0">
      {!paused && <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-400 opacity-75" />}
      <span className={cx("relative inline-flex size-[7px] rounded-full", paused ? "bg-white/55" : "bg-blue-400")} />
    </span>
  );
}

/** Bars that move while a session plays, and a pause sign while it rests. */
function PlayingBars({ paused, className }: { paused: boolean; className?: string }) {
  if (paused) return <Pause aria-hidden className={cx("size-3.5 fill-current", className)} />;
  return (
    <span aria-hidden className={cx("flex h-[13px] items-end gap-0.5", className)}>
      {[0, -0.35, -0.7].map((delay) => <span key={delay} style={{ animationDelay: `${delay}s` }} className="animate-eq h-full w-[3px] origin-bottom rounded-[1px] bg-current" />)}
    </span>
  );
}

const ENDS = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function SessionProgress({ s }: { s: JellyfinSessionRow }) {
  const positionMs = useLivePosition(s);
  const left = s.runtimeMs > 0 ? s.runtimeMs - positionMs : 0;
  const remaining = duration(left);
  const ends = !s.paused && left > 0 ? `ends ${ENDS.format(Date.now() + left)}` : null;
  return (
    <div className="max-w-md">
      <div className="relative h-1.5 rounded-full bg-white/20">
        <div
          className={cx("relative h-full rounded-full", s.paused ? "bg-white/70" : "bg-gradient-to-r from-blue-600 via-blue-400 to-sky-300 shadow-[0_0_14px_rgba(96,165,250,0.75)]")}
          style={{ width: `${shareOf(s, positionMs)}%` }}
        >
          <span className={cx("absolute right-0 top-1/2 size-3 -translate-y-1/2 translate-x-1/2 rounded-full ring-2", s.paused ? "bg-white/90 ring-white/25" : "bg-white ring-blue-400/60 shadow-[0_0_10px_rgba(125,211,252,0.9)]")} />
        </div>
      </div>
      <div className="mt-2 flex justify-between gap-3 text-xs tabular-nums text-white/80">
        <span>{clock(positionMs)}</span>
        <span className="truncate">{[remaining && `${remaining} left`, ends].filter(Boolean).join(" · ")}</span>
      </div>
    </div>
  );
}

/** The session the hero turns into while it plays: the title's logo over its art, how far it has got, and where it reports. */
function LiveSession({ s, named }: { s: JellyfinSessionRow; named: boolean }) {
  const open = useOpenTitle();
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [s.logoUrl]);
  const who = s.viewer ? `${s.viewer}, into ${s.profile}'s history` : named ? s.profile : null;
  const facts = [...(s.episode ? [s.episode] : [s.year, ...s.genres]), who].filter(Boolean).join(" · ");
  const videoId = s.videoId;
  return (
    <div>
      <div className="h-32 md:h-2" />
      {s.logoUrl && !logoFailed
        ? <img src={sizedArt(s.logoUrl, 500) ?? s.logoUrl} alt={s.title} onError={() => setLogoFailed(true)} className="max-h-24 max-w-[236px] object-contain object-left drop-shadow-[0_4px_18px_rgba(0,0,0,0.6)] md:max-w-[300px]" />
        : <p className="text-3xl font-bold leading-tight drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]">{s.title}</p>}
      <p className="mt-2.5 truncate text-[13px] text-white/80">{facts}</p>
      <div className="mt-4"><SessionProgress s={s} /></div>
      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        {open && videoId && (
          <button type="button" onClick={() => open(titleRefOf({ seriesId: s.seriesId, videoId }))} className="inline-flex h-10 items-center gap-2 rounded-full bg-white px-[18px] text-sm font-semibold text-black transition-colors hover:bg-white/85">
            <PlayingBars paused={s.paused} />
            Details
          </button>
        )}
        {s.trackers.length > 0 && (
          <span className="inline-flex h-10 items-center gap-2 rounded-full border border-white/[0.12] bg-white/10 px-3 backdrop-blur-md">
            <span className="text-xs text-white/80">Scrobbling to</span>
            <span className="flex gap-1">
              {s.trackers.map((service) => <Logo key={service} service={service} size={22} />)}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function NowPlaying({ s }: { s: JellyfinSessionRow }) {
  const positionMs = useLivePosition(s);
  const pct = s.runtimeMs > 0 ? Math.max(1, shareOf(s, positionMs)) : null;
  return (
    <div className="glass flex items-center gap-3 rounded-xl px-3 py-2">
      <div className="w-20 shrink-0"><Art src={s.imageUrl} title={s.title} wide /></div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs leading-tight truncate">
          <span className={`mr-1.5 inline-flex items-center gap-1 rounded px-1 py-px text-[10px] font-medium ${s.paused ? "bg-white/10 text-muted-foreground" : "bg-blue-500/20 text-blue-300"}`}>
            {s.paused ? <Pause className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5" />}{s.paused ? "Paused" : "Playing"}
          </span>
          <span className="font-medium">{s.title}</span>
          {s.episode && <span className="text-muted-foreground"> · {s.episode}</span>}
        </p>
        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 rounded-full bg-white/10 overflow-hidden">
            {pct !== null && <div className="h-full bg-gradient-to-r from-blue-600 to-blue-400" style={{ width: `${pct}%` }} />}
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground whitespace-nowrap">{clock(positionMs)}{s.runtimeMs > 0 ? ` / ${clock(s.runtimeMs)}` : ""}</span>
        </div>
        <p className="text-[10px] text-muted-foreground truncate">{s.viewer ? `${s.viewer}, into ${s.profile}'s history` : s.profile} · {when(s.at)}</p>
      </div>
    </div>
  );
}

// The art fades out at the top for the header and at the foot into the page, and stays clear across the middle.
const LIVE_SHADE = "linear-gradient(180deg, hsl(var(--background) / 0.75) 0%, transparent 26%, transparent 50%, hsl(var(--background) / 0.85) 82%, hsl(var(--background)) 100%)";

export function Hero({ data, profile, onProfile, activity, back, actions, search, switching }: {
  data: JellyfinConfiguration;
  profile: string | null;
  onProfile: (key: string | null) => void;
  activity: Activity;
  back: React.ReactNode;
  actions: React.ReactNode;
  search: React.ReactNode;
  switching: boolean;
}) {
  const history = data.history === undefined ? data.profile : data.history;
  const shown = history === null ? data.profiles : data.profiles.filter((p) => p.key === history);
  const viewers = data.viewers ?? data.profiles;
  const viewer = profile === null ? null : viewers.find((p) => p.key === profile) ?? null;
  const borrowed = viewer !== null && history !== null && viewer.key !== history ? shown[0]?.name ?? null : null;
  const sum = (pick: (p: JellyfinProfileSummary) => number) => shown.reduce((n, p) => n + pick(p), 0);
  const lastActivity = shown.reduce<number | null>((at, p) => Math.max(at ?? 0, p.lastActivity ?? 0) || null, null);
  const lead = profile === null ? data.profiles[0] : viewer ?? shown[0];
  const live = switching ? undefined : data.sessions[0];
  const backdrop = sizedArt(data.sessions[0]?.backdropUrl ?? data.inProgress[0]?.backdropUrl ?? data.recentlyPlayed[0]?.backdropUrl
    ?? data.sessions[0]?.imageUrl ?? data.inProgress[0]?.imageUrl ?? data.recentlyPlayed[0]?.imageUrl, 1280);
  const [loaded, setLoaded] = useState<string | null>(null);
  const chips = viewers.length > 1;
  // Someone other than the profile in view is named; the profile's own play reads as its own.
  const several = profile === null && data.profiles.length > 1;
  const watcher = live && (live.viewer ?? (several ? live.profile : null));
  const liveLine = live && (watcher
    ? `${watcher} ${live.paused ? "paused" : "is watching"} ${live.title}`
    : live.paused ? `Paused on ${live.title}` : `Watching ${live.title} now`);
  return (
    <div className="relative overflow-hidden">
      {backdrop && (
        <img
          key={backdrop}
          src={backdrop}
          alt=""
          onLoad={() => setLoaded(backdrop)}
          className={cx(
            "absolute w-full object-cover transition-opacity duration-700",
            live ? "inset-x-0 top-0 h-[28rem] object-[58%_20%] md:inset-y-0 md:h-full md:object-top" : "inset-0 h-full object-top",
            loaded === backdrop && !switching ? (live ? "opacity-85" : "opacity-50") : "opacity-0",
          )}
        />
      )}
      {live ? (
        <>
          <div className="absolute inset-x-0 top-0 h-[28rem] md:hidden" style={{ background: LIVE_SHADE }} />
          <div className="absolute inset-0 hidden bg-gradient-to-r from-background/85 via-background/40 to-transparent md:block" />
          <div className="absolute inset-0 hidden bg-gradient-to-t from-background via-transparent to-transparent md:block" />
        </>
      ) : (
        <>
          <div className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/30" />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent" />
        </>
      )}
      <div className="relative space-y-5 px-4 pt-3 pb-6 sm:px-6 sm:pt-5">
        <div className="flex items-center gap-3 sm:gap-4">
          {back}
          <LiveAvatar session={live} src={lead?.avatar ?? null} name={lead?.name ?? data.label} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="text-2xl font-semibold leading-tight truncate">{profile === null ? data.label : lead?.name ?? data.label}</p>
            {switching ? (
              <p className="flex items-center gap-1.5 text-xs text-blue-300"><Loader2 className="h-3 w-3 animate-spin" /> Loading {profile === null ? "every profile" : lead?.name ?? "profile"}…</p>
            ) : live && liveLine ? (
              <p className="flex items-center gap-[7px] text-[13px] text-blue-200"><LiveDot paused={live.paused} /><span className="truncate">{liveLine}</span></p>
            ) : (
              <p className="text-xs text-muted-foreground truncate">
                <span className="font-mono">{data.userUUID.slice(0, 8)}</span>
                {lastActivity ? ` · active ${when(lastActivity)}` : ""}
                {borrowed ? ` · shares ${borrowed}'s history` : shown[0]?.sharedWith.length ? ` · shared with ${shown[0].sharedWith.join(", ")}` : ""}
              </p>
            )}
          </div>
          {actions}
        </div>
        {/* On a phone the profiles move to the avatar tab of the tab bar. */}
        {chips && (
          <div className="hidden flex-wrap gap-1.5 md:flex">
            <button type="button" onClick={() => onProfile(null)} className={`h-7 rounded-full px-3 text-xs ring-1 transition-colors ${profile === null ? "bg-foreground text-background ring-transparent" : "glass ring-transparent hover:bg-black/50"}`}>All</button>
            {viewers.map((p) => (
              <button key={p.key} type="button" onClick={() => onProfile(p.key)} className={`h-7 inline-flex items-center gap-1.5 rounded-full pl-1 pr-3 text-xs ring-1 transition-colors ${profile === p.key ? "bg-foreground text-background ring-transparent" : "glass ring-transparent hover:bg-black/50"}`}>
                {switching && profile === p.key ? <Loader2 className="h-5 w-5 animate-spin p-0.5" /> : <Avatar src={p.avatar} name={p.name} size="sm" />}
                {p.name}
              </button>
            ))}
          </div>
        )}
        {live && <LiveSession s={live} named={several} />}
        <div className={cx("grid gap-x-6 gap-y-4 sm:grid-cols-4 max-w-2xl", live ? "grid-cols-4 max-sm:gap-x-2 max-sm:pt-1" : "grid-cols-2")}>
          <HeroStat compact={!!live} label="Movies" value={sum((p) => p.movies).toLocaleString()} />
          <HeroStat compact={!!live} label="Episodes" value={sum((p) => p.episodes).toLocaleString()} />
          <HeroStat compact={!!live} label="In progress" value={sum((p) => p.inProgress).toLocaleString()} />
          <HeroStat compact={!!live} label="Day streak" value={activity.streak} hint={activity.best > activity.streak ? `best ${activity.best} this year` : undefined} />
        </div>
        <div className="max-w-2xl">{search}</div>
        {!switching && data.sessions.length > 1 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 max-w-3xl">
            {data.sessions.slice(1).map((s, i) => <NowPlaying key={`${s.title}-${i}`} s={s} />)}
          </div>
        )}
      </div>
    </div>
  );
}
const HEAT = ["bg-muted/50", "bg-blue-500/25", "bg-blue-500/50", "bg-blue-500/80", "bg-blue-400"];
const MONTH = new Intl.DateTimeFormat(undefined, { month: "short" });
const DAY_TITLE = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

export const ActivityMap = React.memo(function ActivityMap({ activity }: { activity: Activity }) {
  const scroller = useRef<HTMLDivElement>(null);
  const { weeks, months, cut } = useMemo(() => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 52 * 7 - today.getDay());
    const weeks: Array<Array<{ key: string; date: Date; n: number } | null>> = [];
    const months: Array<{ at: number; label: string }> = [];
    const cursor = new Date(start);
    let lastMonth = -1;
    while (cursor <= today) {
      const week: Array<{ key: string; date: Date; n: number } | null> = [];
      for (let d = 0; d < 7; d += 1) {
        if (cursor > today) week.push(null);
        else {
          const key = dayKey(cursor);
          week.push({ key, date: new Date(cursor), n: activity.days[key] ?? 0 });
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      const first = week[0]?.date;
      if (first && first.getMonth() !== lastMonth) {
        months.push({ at: weeks.length, label: MONTH.format(first) });
        lastMonth = first.getMonth();
      }
      weeks.push(week);
    }
    const lit = Object.values(activity.days).filter((n) => n > 0).sort((a, b) => a - b);
    const q = (f: number) => lit[Math.min(lit.length - 1, Math.floor(lit.length * f))] ?? 1;
    return { weeks, months, cut: [q(0.25), q(0.5), q(0.75)] };
  }, [activity.days]);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [weeks.length]);
  const level = (n: number) => (n <= 0 ? 0 : n <= cut[0] ? 1 : n <= cut[1] ? 2 : n <= cut[2] ? 3 : 4);
  return (
    <section className="px-4 py-4 sm:px-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <ShelfTitle title="Activity" count={null} />
        <p className="text-xs text-muted-foreground tabular-nums">
          <span className="text-foreground">{activity.total.toLocaleString()}</span> watched in the last year · <span className="text-foreground">{activity.active}</span> active days · best streak <span className="text-foreground">{activity.best}</span>
        </p>
      </div>
      <div ref={scroller} className="overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="min-w-[720px] space-y-1">
          <div className="relative h-3 text-[10px] text-muted-foreground">
            {months.map((m) => <span key={`${m.at}-${m.label}`} className="absolute" style={{ left: `${(m.at / weeks.length) * 100}%` }}>{m.label}</span>)}
          </div>
          <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
            {weeks.map((week, w) => (
              <div key={w} className="grid gap-[3px]">
                {week.map((day, d) => day
                  ? <span key={day.key} title={`${DAY_TITLE.format(day.date)}: ${day.n} watched`} className={`aspect-square w-full rounded-[3px] ${HEAT[level(day.n)]}`} />
                  : <span key={`empty-${d}`} className="aspect-square w-full" />)}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
        Less {HEAT.map((c) => <span key={c} className={`h-[11px] w-[11px] rounded-[2px] ${c}`} />)} More
      </div>
    </section>
  );
});
