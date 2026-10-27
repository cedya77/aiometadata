import { memo, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CalendarDays, CalendarPlus, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, ImageOff, Link2Off, Loader2, RotateCcw } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpenTitle } from "./jellyfinUtils";
import { useJellyfinCalendar, useJellyfinCalendarFeed, useJellyfinCalendarFeedActions, type DashboardTab, type JellyfinCalendarRow } from "@/hooks/useDashboardQueries";

const WEEK = 7;

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

function firstWeekday(): number {
  try {
    const tag = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = tag.getWeekInfo?.() ?? tag.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch {}
  return 1;
}

function weekOf(date: Date, first: number): Date {
  const day = startOfDay(date);
  return addDays(day, -((day.getDay() - first + WEEK) % WEEK));
}

/** A date with no time is sent as midnight UTC, the day before west of Greenwich, so it keeps its own calendar date. */
function airing(premiere: string | null): { key: string; at: Date | null } | null {
  if (!premiere) return null;
  const date = new Date(premiere);
  if (Number.isNaN(date.getTime())) return null;
  const dateOnly = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
  if (!dateOnly) return { key: dayKey(date), at: date };
  return {
    key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`,
    at: null,
  };
}

function episodeLine(row: JellyfinCalendarRow, compact: boolean): string {
  if (row.number === null) return "";
  if (compact) return row.season !== null ? `S${row.season} · E${row.number}` : `E${row.number}`;
  return row.season !== null ? `Season ${row.season} · Episode ${row.number}` : `Episode ${row.number}`;
}

function premiereLabel(row: JellyfinCalendarRow, compact: boolean): string | null {
  if (row.number !== 1) return null;
  if (compact) return "Premiere";
  return row.season === 1 ? "Series premiere" : "Season premiere";
}

const sized = (src: string | null, width: number) => (src ? `${src}&maxWidth=${width}&quality=90` : null);

const AMBIENT_WIDTH = 200;
const AMBIENT_DWELL_MS = 250;

function artFor(row: JellyfinCalendarRow, aired: boolean, width: number): string[] {
  const order = aired ? [row.still, row.thumb, row.backdrop] : [row.thumb, row.backdrop, row.still];
  return order.map((src) => sized(src, width)).filter((src): src is string => !!src);
}

const AmbientBackdrop = memo(({ src }: { src: string | undefined }) => {
  const [layers, setLayers] = useState<string[]>([]);
  const [shown, setShown] = useState<string | undefined>();
  if (src !== shown) {
    setShown(src);
    if (src) setLayers((previous) => [...previous.filter((layer) => layer !== src), src].slice(-2));
  }
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {layers.map((layer) => (
        <img key={layer} src={layer} alt="" className="image-in absolute inset-0 size-full scale-125 object-cover opacity-40 blur-3xl" />
      ))}
      <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/80 to-background" />
    </div>
  );
});
AmbientBackdrop.displayName = "AmbientBackdrop";

interface Airing {
  row: JellyfinCalendarRow;
  at: Date | null;
  aired: boolean;
}

function FadeImage({ src, className, onError }: { src: string; className: string; onError: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return <img src={src} alt="" loading="lazy" onLoad={() => setLoaded(true)} onError={onError} className={cx(className, loaded ? "image-in" : "opacity-0")} />;
}

const EpisodeCard = ({ airing: { row, at, aired }, large = false, onFocus }: { airing: Airing; large?: boolean; onFocus: (src: string | undefined) => void }) => {
  const open = useOpenTitle();
  const sources = artFor(row, aired, large ? 720 : 480);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [logoFailed, setLogoFailed] = useState(false);
  const src = sources[sourceIndex];
  const logo = logoFailed ? null : sized(row.logo, 360);
  const premiere = premiereLabel(row, !large);
  const time = at ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(at) : null;
  const ambient = sized(row.backdrop, AMBIENT_WIDTH) ?? artFor(row, aired, AMBIENT_WIDTH).pop();

  return (
    <div
      onMouseEnter={() => onFocus(ambient)}
      role={open && row.seriesId ? "button" : undefined}
      tabIndex={open && row.seriesId ? 0 : undefined}
      onClick={open && row.seriesId ? () => open({ item: row.seriesId! }) : undefined}
      className={cx("group block", open && row.seriesId && "cursor-pointer")}
      title={`${row.seriesName}${row.name ? ` · ${row.name}` : ""}`}
    >
      <div
        className={cx(
          "relative aspect-video w-full overflow-hidden rounded-lg bg-foreground/5 shadow-md transition duration-300",
          row.played && "opacity-60 saturate-50 group-hover:opacity-100 group-hover:saturate-100"
        )}
      >
        {src ? (
          <>
            <Skeleton className="absolute inset-0 rounded-lg" />
            <FadeImage key={src} src={src} onError={() => setSourceIndex((i) => i + 1)} className="relative size-full object-cover transition duration-500 group-hover:scale-105" />
          </>
        ) : (
          <div className="flex size-full items-center justify-center">
            <ImageOff className="text-muted-foreground" />
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent" />
        {logo ? (
          <img
            src={logo}
            alt={row.seriesName}
            loading="lazy"
            onError={() => setLogoFailed(true)}
            className={cx("absolute bottom-2 left-2.5 w-auto object-contain object-left-bottom drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]", large ? "max-h-12 max-w-[60%]" : "max-h-8 max-w-[70%]")}
          />
        ) : (
          <p className={cx("absolute inset-x-2.5 bottom-2 line-clamp-2 font-bold leading-tight text-white drop-shadow", large ? "text-lg" : "text-sm")}>{row.seriesName}</p>
        )}
        <div className="absolute inset-x-2 top-2 flex items-start justify-between gap-1">
          {time && !aired ? <span className="rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-md">{time}</span> : <span />}
          {row.played ? (
            <span className="flex size-5 items-center justify-center rounded-full bg-blue-500 text-white shadow" title="Watched">
              <Check className="size-3.5" strokeWidth={3} />
            </span>
          ) : premiere ? (
            <span className="whitespace-nowrap rounded-full bg-blue-500 px-2 py-0.5 text-[11px] font-semibold text-white shadow">{premiere}</span>
          ) : aired ? (
            <span className="whitespace-nowrap rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-semibold text-black shadow">Out now</span>
          ) : null}
        </div>
        <div className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-inset ring-white/[0.08] transition group-hover:ring-white/20" />
      </div>
      <p className={cx("mt-2 truncate font-semibold text-foreground/90", large ? "text-sm" : "text-xs")}>{episodeLine(row, !large)}</p>
      {row.name && <p className={cx("truncate text-muted-foreground", large ? "text-sm" : "text-xs")}>{row.name}</p>}
    </div>
  );
};

const CardSkeleton = () => (
  <div>
    <Skeleton className="aspect-video w-full rounded-lg" />
    <Skeleton className="mt-2 h-3 w-3/4" />
    <Skeleton className="mt-1.5 h-3 w-1/2" />
  </div>
);

interface Day {
  date: Date;
  key: string;
  airings: Airing[];
}

const DayColumn = ({ day, today, loading, onFocus }: { day: Day; today: string; loading: boolean; onFocus: (src: string | undefined) => void }) => {
  const isToday = day.key === today;
  const past = day.key < today;
  return (
    <section
      className={cx(
        "flex min-w-56 snap-start flex-col gap-3 rounded-2xl border p-2.5 transition-colors lg:min-w-0",
        isToday ? "border-blue-500/40 bg-blue-500/[0.07] shadow-[0_0_40px_-12px] shadow-blue-500/40" : "border-foreground/[0.06] bg-foreground/[0.025]"
      )}
    >
      <header className={cx("flex items-baseline gap-2 px-1 pt-0.5", past && "opacity-55")}>
        <span className={cx("flex size-9 shrink-0 items-center justify-center rounded-full text-lg font-bold tabular-nums", isToday ? "bg-blue-500 text-white" : "text-foreground")}>
          {day.date.getDate()}
        </span>
        <span className={cx("text-xs font-semibold uppercase tracking-[0.14em]", isToday ? "text-blue-400" : "text-muted-foreground")}>
          {isToday ? "Today" : new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(day.date)}
        </span>
      </header>
      {loading ? (
        <CardSkeleton />
      ) : day.airings.length ? (
        day.airings.map((a) => <EpisodeCard key={a.row.id} airing={a} onFocus={onFocus} />)
      ) : (
        <p className="flex flex-1 items-center justify-center py-8 text-center text-xs text-muted-foreground/60">Nothing airing</p>
      )}
    </section>
  );
};

const DayStrip = ({ days, selected, today, onSelect }: { days: Day[]; selected: string; today: string; onSelect: (key: string) => void }) => (
  <div className="grid grid-cols-7 gap-1.5">
    {days.map((day) => {
      const active = day.key === selected;
      const isToday = day.key === today;
      return (
        <button
          key={day.key}
          type="button"
          onClick={() => onSelect(day.key)}
          className={cx("flex flex-col items-center gap-1 rounded-xl py-2 transition-colors", active ? "bg-foreground text-background" : "bg-foreground/[0.04] text-foreground hover:bg-foreground/10")}
        >
          <span className={cx("text-[10px] font-semibold uppercase tracking-wider", active ? "text-background/70" : isToday ? "text-blue-400" : "text-muted-foreground")}>
            {new Intl.DateTimeFormat(undefined, { weekday: "narrow" }).format(day.date)}
          </span>
          <span className="text-base font-bold tabular-nums">{day.date.getDate()}</span>
          <span className="flex h-1.5 gap-0.5">
            {day.airings.slice(0, 3).map((a) => <span key={a.row.id} className={cx("size-1.5 rounded-full", active ? "bg-background/80" : "bg-blue-500")} />)}
          </span>
        </button>
      );
    })}
  </div>
);

type View = "week" | "month";
const VIEW_KEY = "jellyfin.calendar.view";
function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "month" ? "month" : "week";
  } catch {
    return "week";
  }
}

function storeView(view: View) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {}
}

const monthOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);

function monthWindow(month: Date, first: number): { start: Date; days: number } {
  const start = weekOf(month, first);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const span = Math.round((startOfDay(last).getTime() - start.getTime()) / 86_400_000) + 1;
  return { start, days: Math.ceil(span / WEEK) * WEEK };
}

function buildDays(start: Date, count: number, rows: JellyfinCalendarRow[] | undefined, now: number, today: string): Day[] {
  const out: Day[] = Array.from({ length: count }, (_, index) => {
    const date = addDays(start, index);
    return { date, key: dayKey(date), airings: [] };
  });
  const byKey = new Map(out.map((day) => [day.key, day]));
  for (const row of rows ?? []) {
    const when = airing(row.premiereDate);
    if (!when) continue;
    const aired = when.at ? when.at.getTime() <= now : when.key <= today;
    byKey.get(when.key)?.airings.push({ row, at: when.at, aired });
  }
  for (const day of out) {
    day.airings.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0) || a.row.seriesName.localeCompare(b.row.seriesName));
  }
  return out;
}

const MONTH_ROWS = 3;

const MonthCell = ({ day, inMonth, isToday, selected, onSelect }: { day: Day; inMonth: boolean; isToday: boolean; selected: boolean; onSelect: () => void }) => {
  const extra = day.airings.length - MONTH_ROWS;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cx(
        "group flex min-h-16 flex-col gap-1 rounded-xl border p-1.5 text-left transition-colors md:min-h-32",
        selected ? "border-foreground/50 bg-foreground/[0.08]" : isToday ? "border-blue-500/40 bg-blue-500/[0.07]" : "border-foreground/[0.06] bg-foreground/[0.025] hover:bg-foreground/[0.06]",
        !inMonth && "opacity-40"
      )}
    >
      <span className={cx("flex size-7 items-center justify-center self-center rounded-full text-sm font-semibold tabular-nums md:self-start", isToday ? "bg-blue-500 text-white" : "text-foreground")}>
        {day.date.getDate()}
      </span>
      <span className="flex flex-wrap justify-center gap-0.5 md:hidden">
        {day.airings.slice(0, 4).map((a) => <span key={a.row.id} className="size-1.5 rounded-full bg-blue-500" />)}
      </span>
      <span className="hidden min-w-0 flex-col gap-1 md:flex">
        {day.airings.slice(0, MONTH_ROWS).map((a) => {
          const src = artFor(a.row, a.aired, 160)[0];
          return (
            <span key={a.row.id} className={cx("flex min-w-0 items-center gap-1.5 rounded-md bg-background/50 p-0.5 pr-1.5", a.row.played && "opacity-60")}>
              {src ? <img src={src} alt="" loading="lazy" className="aspect-video w-9 shrink-0 rounded-sm object-cover" /> : <span className="aspect-video w-9 shrink-0 rounded-sm bg-foreground/10" />}
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium leading-tight">{a.row.seriesName}</span>
              {a.row.played && <Check className="size-3 shrink-0 text-blue-400" strokeWidth={3} />}
            </span>
          );
        })}
        {extra > 0 && <span className="px-1 text-[11px] font-medium text-muted-foreground">+{extra} more</span>}
      </span>
    </button>
  );
};

const MonthGrid = ({ days, month, today, selected, first, onSelect }: { days: Day[]; month: Date; today: string; selected: string; first: number; onSelect: (key: string) => void }) => {
  const weekdays = Array.from({ length: WEEK }, (_, index) => addDays(weekOf(new Date(), first), index));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-7 gap-1.5 px-0.5">
        {weekdays.map((date) => (
          <span key={date.getDay()} className="text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground md:pl-2 md:text-left">
            <span className="md:hidden">{new Intl.DateTimeFormat(undefined, { weekday: "narrow" }).format(date)}</span>
            <span className="hidden md:inline">{new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date)}</span>
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {days.map((day) => (
          <MonthCell key={day.key} day={day} inMonth={day.date.getMonth() === month.getMonth()} isToday={day.key === today} selected={day.key === selected} onSelect={() => onSelect(day.key)} />
        ))}
      </div>
    </div>
  );
};

const DayPanel = ({ day, loading, onFocus }: { day: Day; loading: boolean; onFocus: (src: string | undefined) => void }) => (
  <section className="flex flex-col gap-4">
    <h3 className="text-xl font-bold">{new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(day.date)}</h3>
    {loading ? (
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"><CardSkeleton /></div>
    ) : day.airings.length ? (
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {day.airings.map((a) => <EpisodeCard key={a.row.id} airing={a} large onFocus={onFocus} />)}
      </div>
    ) : (
      <p className="py-8 text-sm text-muted-foreground">Nothing airing</p>
    )}
  </section>
);

const feedUrl = (secret: string) => `${window.location.origin}/calendar/${secret}.ics`;

async function copyLink(url: string, title: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success(title, { description: "Add it in your calendar app as a calendar from a URL." });
  } catch {
    toast.message("Copy this link", { description: url, duration: 20_000 });
  }
}

function CalendarSubscribe({ userUUID, profile, profileName, activeTab }: { userUUID: string; profile: string | null; profileName: string; activeTab: DashboardTab }) {
  const { data, isLoading } = useJellyfinCalendarFeed(userUUID, profile, { activeTab });
  const { issue, revoke } = useJellyfinCalendarFeedActions();
  const [busy, setBusy] = useState(false);
  const secret = data?.secret ?? null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };
  const subscribe = () => run(async () => copyLink(feedUrl(await issue(userUUID, profile)), "Calendar link copied"));
  const renew = () => run(async () => copyLink(feedUrl(await issue(userUUID, profile)), "New calendar link copied"));
  const turnOff = () => run(async () => {
    await revoke(userUUID, profile);
    toast.success("Calendar link turned off");
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Subscribe in a calendar app" title="Subscribe in a calendar app" disabled={isLoading} className={cx("glass flex size-9 items-center justify-center rounded-full transition-colors hover:bg-black/50 disabled:opacity-50", secret && "text-blue-400")}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <CalendarPlus className="size-4" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal leading-relaxed text-muted-foreground">
          {secret
            ? `Calendar apps holding this link follow ${profileName}'s episodes and watchlisted films as they are scheduled.`
            : `A private link that puts ${profileName}'s episodes and watchlisted films in Google, Apple or Outlook Calendar.`}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {secret ? (
          <>
            <DropdownMenuItem asChild>
              <a href={feedUrl(secret).replace(/^https?:/, "webcal:")}><ExternalLink className="size-4" /> Open in a calendar app</a>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => void copyLink(feedUrl(secret), "Calendar link copied")}><Copy className="size-4" /> Copy link</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} onSelect={() => void renew()}><RotateCcw className="size-4" /> Make a new link</DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => void turnOff()} className="text-red-300 focus:text-red-200"><Link2Off className="size-4" /> Turn off the link</DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem disabled={busy} onSelect={() => void subscribe()}><CalendarPlus className="size-4" /> Make a link and copy it</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function JellyfinCalendar({ userUUID, profile, profileName, activeTab }: { userUUID: string; profile: string | null; profileName: string; activeTab: DashboardTab }) {
  const first = useMemo(() => firstWeekday(), []);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  const today = dayKey(new Date(now));
  const thisWeek = useMemo(() => weekOf(new Date(now), first), [first, now]);
  const thisMonth = useMemo(() => monthOf(new Date(now)), [now]);
  const [view, setView] = useState<View>(storedView);
  const [weekStart, setWeekStart] = useState(thisWeek);
  const [month, setMonth] = useState(thisMonth);
  const [picked, setPicked] = useState<string | null>(null);
  const [ambient, setAmbient] = useState<string | undefined>();

  const span = useMemo(() => (view === "month" ? monthWindow(month, first) : { start: weekStart, days: WEEK }), [view, month, first, weekStart]);
  const { data, isLoading, isFetching, isError, refetch } = useJellyfinCalendar(userUUID, profile, span.start, span.days, { activeTab });
  const [before, after] = useMemo(() => (view === "month"
    ? [monthWindow(new Date(month.getFullYear(), month.getMonth() - 1, 1), first), monthWindow(new Date(month.getFullYear(), month.getMonth() + 1, 1), first)]
    : [{ start: addDays(weekStart, -WEEK), days: WEEK }, { start: addDays(weekStart, WEEK), days: WEEK }]), [view, month, first, weekStart]);
  useJellyfinCalendar(userUUID, profile, before.start, before.days, { activeTab, enabled: Boolean(data) });
  useJellyfinCalendar(userUUID, profile, after.start, after.days, { activeTab, enabled: Boolean(data) });
  const days = useMemo(() => buildDays(span.start, span.days, data?.rows, now, today), [span, data, now, today]);
  const counted = view === "month" ? days.filter((day) => day.date.getMonth() === month.getMonth()) : days;
  const total = counted.reduce((sum, day) => sum + day.airings.length, 0);

  const selectable = view === "month" ? counted : days;
  const selected = picked && days.some((day) => day.key === picked)
    ? picked
    : selectable.some((day) => day.key === today)
      ? today
      : (selectable.find((day) => day.airings.length)?.key ?? selectable[0].key);
  const selectedDay = days.find((day) => day.key === selected)!;

  const go = (step: number) => {
    setPicked(null);
    if (view === "month") setMonth(new Date(month.getFullYear(), month.getMonth() + step, 1));
    else setWeekStart(addDays(weekStart, step * WEEK));
  };
  const toToday = () => {
    setPicked(null);
    setWeekStart(thisWeek);
    setMonth(thisMonth);
  };
  const switchTo = (next: View) => {
    storeView(next);
    if (next === view) return;
    setPicked(null);
    if (next === "month") setMonth(monthOf(view === "week" ? weekStart : selectedDay.date));
    else setWeekStart(weekOf(selectedDay.date, first));
    setView(next);
  };

  const lead = useMemo(() => {
    const day = days.find((d) => d.key >= today && d.airings.length) ?? days.find((d) => d.airings.length);
    return sized(day?.airings[0]?.row.backdrop ?? null, AMBIENT_WIDTH) ?? undefined;
  }, [days, today]);

  const heading = view === "month"
    ? new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(month)
    : (new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }) as Intl.DateTimeFormat & { formatRange: (a: Date, b: Date) => string }).formatRange(weekStart, addDays(weekStart, WEEK - 1));
  const atToday = view === "month" ? month.getTime() === thisMonth.getTime() : weekStart.getTime() === thisWeek.getTime();
  const dwell = useRef<number | null>(null);
  useEffect(() => () => { if (dwell.current) window.clearTimeout(dwell.current); }, []);
  const focus = (src: string | undefined) => {
    if (!src) return;
    if (dwell.current) window.clearTimeout(dwell.current);
    dwell.current = window.setTimeout(() => setAmbient(src), AMBIENT_DWELL_MS);
  };

  return (
    <section className="relative isolate overflow-hidden">
      <AmbientBackdrop src={ambient ?? lead} />
      <div className="relative flex flex-col gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <CalendarDays className="size-3.5" /> {profileName}'s calendar
            </span>
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">{heading}</h2>
            <p className="h-5 text-sm text-muted-foreground">{isLoading ? "" : `${total} ${total === 1 ? "episode" : "episodes"}`}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="glass flex h-9 items-center rounded-full p-0.5">
              {(["week", "month"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => switchTo(option)}
                  className={cx("h-full rounded-full px-3.5 text-sm font-medium capitalize transition-colors", option === view ? "bg-white/15 text-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  {option}
                </button>
              ))}
            </div>
            <button type="button" onClick={toToday} disabled={atToday} className="glass h-9 rounded-full px-4 text-sm font-medium transition-opacity disabled:opacity-50">
              Today
            </button>
            <div className="glass flex h-9 items-center rounded-full p-0.5">
              <button type="button" onClick={() => go(-1)} aria-label={view === "month" ? "Previous month" : "Previous week"} className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-white/10">
                <ChevronLeft className="size-4" />
              </button>
              <button type="button" onClick={() => go(1)} aria-label={view === "month" ? "Next month" : "Next week"} className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-white/10">
                <ChevronRight className="size-4" />
              </button>
            </div>
            <CalendarSubscribe userUUID={userUUID} profile={profile} profileName={profileName} activeTab={activeTab} />
          </div>
        </div>

        {isError && !isFetching && (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">Could not read this calendar.</p>
            <button type="button" onClick={() => void refetch()} className="glass h-8 rounded-full px-4 text-xs font-medium hover:bg-white/15">Retry</button>
          </div>
        )}
        {!(isError && !isFetching) && (
        <div className={cx("transition-opacity duration-300", isFetching && !isLoading && "opacity-70")}>
          {view === "month" ? (
            <div className="flex flex-col gap-8">
              <MonthGrid days={days} month={month} today={today} selected={selected} first={first} onSelect={setPicked} />
              <DayPanel day={selectedDay} loading={isLoading} onFocus={focus} />
            </div>
          ) : (
            <>
              <div className="hidden snap-x gap-3 overflow-x-auto pb-2 md:flex lg:grid lg:grid-cols-7 lg:overflow-visible">
                {days.map((day) => <DayColumn key={day.key} day={day} today={today} loading={isLoading} onFocus={focus} />)}
              </div>
              <div className="flex flex-col gap-5 md:hidden">
                <DayStrip days={days} selected={selected} today={today} onSelect={setPicked} />
                <div className="flex flex-col gap-5">
                  {isLoading ? (
                    <CardSkeleton />
                  ) : selectedDay.airings.length ? (
                    selectedDay.airings.map((a) => <EpisodeCard key={a.row.id} airing={a} large onFocus={focus} />)
                  ) : (
                    <p className="py-12 text-center text-sm text-muted-foreground">Nothing airing</p>
                  )}
                </div>
              </div>
              {!isLoading && total === 0 && (
                <div className="mx-auto mt-6 hidden max-w-md flex-col items-center gap-2 text-center md:flex">
                  <CalendarDays className="size-8 text-muted-foreground/60" />
                  <p className="font-semibold">Nothing airing this week</p>
                  <p className="text-sm text-muted-foreground">New episodes of the shows this profile follows appear here once they're scheduled.</p>
                </div>
              )}
            </>
          )}
        </div>
        )}
      </div>
    </section>
  );
}
