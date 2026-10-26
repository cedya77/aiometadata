import React, { useEffect, useMemo, useRef, useState } from "react";
import { sizedArt } from "./art";
import { Loader2, Pause, Play } from "lucide-react";
import { type JellyfinConfiguration, type JellyfinProfileSummary, type JellyfinSessionRow } from "@/hooks/useDashboardQueries";
import { Art, ShelfTitle } from "./JellyfinShared";
import { when, clock, duration, dayKey, type Activity } from "./jellyfinUtils";

function Avatar({ src, name, size }: { src: string | null; name: string; size: "sm" | "lg" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const box = size === "lg" ? "h-14 w-14 text-xl" : "h-5 w-5 text-[10px]";
  if (src && !failed) return <img src={src} alt="" onError={() => setFailed(true)} className={`${box} shrink-0 rounded-full object-cover ring-2 ring-white/10`} />;
  return <span className={`${box} shrink-0 rounded-full bg-blue-500/20 text-blue-300 font-semibold flex items-center justify-center ring-2 ring-white/10`}>{(name.trim()[0] ?? "?").toUpperCase()}</span>;
}
function HeroStat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-2xl sm:text-3xl font-semibold tabular-nums leading-none">{value}</p>
      <p className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      {hint && <p className="text-[11px] text-muted-foreground/80 truncate">{hint}</p>}
    </div>
  );
}
function NowPlaying({ s }: { s: JellyfinSessionRow }) {
  const pct = s.runtimeMs > 0 ? Math.min(100, Math.max(1, (s.positionMs / s.runtimeMs) * 100)) : null;
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
          <span className="text-[10px] tabular-nums text-muted-foreground whitespace-nowrap">{clock(s.positionMs)}{s.runtimeMs > 0 ? ` / ${clock(s.runtimeMs)}` : ""}</span>
        </div>
        <p className="text-[10px] text-muted-foreground truncate">{s.viewer ? `${s.viewer}, into ${s.profile}'s history` : s.profile} · {when(s.at)}</p>
      </div>
    </div>
  );
}
export function Hero({ data, profile, onProfile, activity, controls, switching }: {
  data: JellyfinConfiguration;
  profile: string | null;
  onProfile: (key: string | null) => void;
  activity: Activity;
  controls: React.ReactNode;
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
  const backdrop = sizedArt(data.sessions[0]?.backdropUrl ?? data.inProgress[0]?.backdropUrl ?? data.recentlyPlayed[0]?.backdropUrl
    ?? data.sessions[0]?.imageUrl ?? data.inProgress[0]?.imageUrl ?? data.recentlyPlayed[0]?.imageUrl, 1280);
  const [loaded, setLoaded] = useState<string | null>(null);
  const chips = viewers.length > 1;
  return (
    <div className="relative overflow-hidden">
      {backdrop && (
        <img
          key={backdrop}
          src={backdrop}
          alt=""
          onLoad={() => setLoaded(backdrop)}
          className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-700 ${loaded === backdrop && !switching ? "opacity-50" : "opacity-0"}`}
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/30" />
      <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent" />
      <div className="relative space-y-5 px-4 pt-4 pb-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-end gap-2">{controls}</div>
        <div className="flex items-center gap-4">
          <Avatar src={lead?.avatar ?? null} name={lead?.name ?? data.label} size="lg" />
          <div className="min-w-0">
            <p className="text-2xl font-semibold leading-tight truncate">{profile === null ? data.label : lead?.name ?? data.label}</p>
            {switching ? (
              <p className="flex items-center gap-1.5 text-xs text-blue-300"><Loader2 className="h-3 w-3 animate-spin" /> Loading {profile === null ? "every profile" : lead?.name ?? "profile"}…</p>
            ) : (
              <p className="text-xs text-muted-foreground truncate">
                <span className="font-mono">{data.userUUID.slice(0, 8)}</span>
                {lastActivity ? ` · active ${when(lastActivity)}` : ""}
                {borrowed ? ` · shares ${borrowed}'s history` : shown[0]?.sharedWith.length ? ` · shared with ${shown[0].sharedWith.join(", ")}` : ""}
              </p>
            )}
          </div>
        </div>
        {chips && (
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => onProfile(null)} className={`h-7 rounded-full px-3 text-xs ring-1 transition-colors ${profile === null ? "bg-foreground text-background ring-transparent" : "glass ring-transparent hover:bg-black/50"}`}>All</button>
            {viewers.map((p) => (
              <button key={p.key} type="button" onClick={() => onProfile(p.key)} className={`h-7 inline-flex items-center gap-1.5 rounded-full pl-1 pr-3 text-xs ring-1 transition-colors ${profile === p.key ? "bg-foreground text-background ring-transparent" : "glass ring-transparent hover:bg-black/50"}`}>
                {switching && profile === p.key ? <Loader2 className="h-5 w-5 animate-spin p-0.5" /> : <Avatar src={p.avatar} name={p.name} size="sm" />}
                {p.name}
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4 max-w-2xl">
          <HeroStat label="Movies" value={sum((p) => p.movies).toLocaleString()} />
          <HeroStat label="Episodes" value={sum((p) => p.episodes).toLocaleString()} />
          <HeroStat label="In progress" value={sum((p) => p.inProgress).toLocaleString()} />
          <HeroStat label="Day streak" value={activity.streak} hint={activity.best > activity.streak ? `best ${activity.best} this year` : undefined} />
        </div>
        {!switching && data.sessions.length > 0 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 max-w-3xl">
            {data.sessions.map((s, i) => <NowPlaying key={`${s.title}-${i}`} s={s} />)}
          </div>
        )}
      </div>
    </div>
  );
}
const HEAT = ["bg-muted/50", "bg-blue-500/25", "bg-blue-500/50", "bg-blue-500/80", "bg-blue-400"];
export function ActivityMap({ activity }: { activity: Activity }) {
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
        months.push({ at: weeks.length, label: first.toLocaleDateString(undefined, { month: "short" }) });
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
                  ? <span key={day.key} title={`${day.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}: ${day.n} watched`} className={`aspect-square w-full rounded-[3px] ${HEAT[level(day.n)]}`} />
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
}
