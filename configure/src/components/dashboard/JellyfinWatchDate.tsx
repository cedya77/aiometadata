import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, Clock, ImageOff, Loader2 } from "lucide-react";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

const DAY = 86_400_000;
const WIDTH = 376;

export interface WatchDateTarget {
  itemId: string;
  episode: boolean;
  heading: string;
  sub: string | null;
  still: string | null;
  from: number | null;
  releasedAt: number | null;
  others: number[];
}

export interface WatchDateAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const startOfDay = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };
const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);
const withTime = (day: number, hours: number, minutes: number) => { const d = new Date(day); d.setHours(hours, minutes, 0, 0); return d.getTime(); };
const addDays = (day: number, days: number) => { const d = new Date(day); d.setDate(d.getDate() + days); return startOfDay(d.getTime()); };
const timeOf = (at: number) => { const d = new Date(at); return { hours: d.getHours(), minutes: d.getMinutes() }; };

// The server dates a release whose time is unknown at noon UTC; any other value is the moment it came out.
const dateOnly = (at: number) => ((at % DAY) + DAY) % DAY === DAY / 2;

function releaseDay(at: number): number {
  if (!dateOnly(at)) return startOfDay(at);
  const d = new Date(at);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
}

function weekStart(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    return (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay ?? 7;
  } catch {
    return 7;
  }
}

const uses12Hours = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === true;

function dateNote(target: WatchDateTarget, trackers: string[]): string {
  if (target.from === null) return "Saved here. The trackers keep the date they have.";
  const moved = trackers.filter((name) => name === "MDBList" || name === "PublicMetaDB" || (name === "Simkl" && target.episode));
  const held = !target.episode && trackers.includes("Simkl") ? " Simkl keeps its own date for movies, since changing it there clears your rating." : "";
  return `Saved here${moved.length ? ` and changed on ${moved.join(", ")}` : ""}.${held}`;
}

function TimeField({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const wrap = (n: number) => (n > max ? min : n < min ? max : n);
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      maxLength={2}
      value={draft ?? String(value).padStart(2, "0")}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => {
        const digits = event.target.value.replace(/\D/g, "").slice(0, 2);
        setDraft(digits);
        const n = Number.parseInt(digits, 10);
        if (Number.isFinite(n) && n >= min && n <= max) onChange(n);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          setDraft(null);
          onChange(wrap(value + (event.key === "ArrowUp" ? 1 : -1)));
        }
      }}
      className="h-10 w-12 rounded-lg bg-white/[0.07] text-center text-[15px] font-semibold tabular-nums ring-1 ring-inset ring-white/10 transition focus:bg-white/[0.12] focus:outline-none focus:ring-blue-400/70"
    />
  );
}

export default function WatchDateSheet({ target, anchor, trackers, onSave, onClose }: {
  target: WatchDateTarget;
  anchor: WatchDateAnchor;
  trackers: string[];
  onSave: (to: number) => Promise<boolean>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [now] = useState(() => Date.now());
  const [phone] = useState(() => window.matchMedia("(max-width: 639px)").matches);
  const [picked, setPicked] = useState(() => {
    const start = target.from ?? now;
    return Math.min(start, now);
  });
  const [view, setView] = useState(() => { const d = new Date(target.from ?? now); return { year: d.getFullYear(), month: d.getMonth() }; });
  const [zoom, setZoom] = useState<"days" | "months">("days");
  const [saving, setSaving] = useState(false);
  const [stillFailed, setStillFailed] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const returnTo = useRef<Element | null>(document.activeElement);

  const first = weekStart();
  const { hours, minutes } = timeOf(picked);
  const future = picked > Date.now() + 60_000;
  const unchanged = target.from !== null && Math.abs(picked - target.from) < 60_000;
  const released = target.releasedAt && target.releasedAt <= now ? releaseDay(target.releasedAt) : null;
  const marked = useMemo(() => new Set(target.others.filter((at) => at !== target.from).map(startOfDay)), [target.others, target.from]);

  const pickDay = (day: number) => {
    setPicked(withTime(day, hours, minutes));
    const d = new Date(day);
    setView({ year: d.getFullYear(), month: d.getMonth() });
  };

  const quick = useMemo(() => {
    const today = startOfDay(now);
    const yesterday = addDays(today, -1);
    const earlier = Math.max(today, Math.floor((now - 2 * 3_600_000) / 900_000) * 900_000);
    const out: Array<{ label: string; at: () => number; is: (at: number) => boolean }> = [
      { label: "Earlier today", at: () => earlier, is: (at) => sameDay(at, now) },
      { label: "Last night", at: () => withTime(yesterday, 21, 0), is: (at) => at === withTime(yesterday, 21, 0) },
      { label: "Yesterday", at: () => withTime(yesterday, hours, minutes), is: (at) => sameDay(at, yesterday) && at !== withTime(yesterday, 21, 0) },
    ];
    if (released !== null) {
      const exact = target.releasedAt && !dateOnly(target.releasedAt) ? target.releasedAt : null;
      out.push({
        label: target.episode ? "Air date" : "Release day",
        at: () => Math.min(now, exact ?? withTime(released, hours, minutes)),
        is: (at) => sameDay(at, released),
      });
    }
    return out;
  }, [now, hours, minutes, released, target.releasedAt, target.episode]);

  const cells = useMemo(() => {
    const firstOfMonth = new Date(view.year, view.month, 1);
    const lead = (firstOfMonth.getDay() - (first % 7) + 7) % 7;
    const days = new Date(view.year, view.month + 1, 0).getDate();
    const out: Array<number | null> = Array.from({ length: lead }, () => null);
    for (let n = 1; n <= days; n += 1) out.push(new Date(view.year, view.month, n).getTime());
    while (out.length % 7) out.push(null);
    return out;
  }, [view, first]);

  const weekdays = useMemo(() => {
    const format = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
    const sunday = new Date(2024, 0, 7);
    return Array.from({ length: 7 }, (_, i) => format.format(new Date(sunday.getTime() + (((first % 7) + i) % 7) * DAY)));
  }, [first]);

  const monthName = new Date(view.year, view.month, 1).toLocaleDateString(undefined, { month: "long" });
  const canNext = zoom === "days" ? new Date(view.year, view.month + 1, 1).getTime() <= now : view.year < new Date(now).getFullYear();
  const step = (dir: 1 | -1) => setView((v) => {
    if (zoom === "months") return { ...v, year: v.year + dir };
    const d = new Date(v.year, v.month + dir, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  useLayoutEffect(() => {
    if (phone) return;
    const el = ref.current;
    if (!el) return;
    const { height } = el.getBoundingClientRect();
    const fit = (left: number) => Math.max(8, Math.min(left, window.innerWidth - WIDTH - 8));
    if (anchor.bottom + 8 + height + 8 <= window.innerHeight) setPlace({ left: fit(anchor.left), top: anchor.bottom + 8 });
    else if (anchor.top - height - 8 >= 8) setPlace({ left: fit(anchor.left), top: anchor.top - height - 8 });
    else {
      const top = Math.max(8, Math.min((anchor.top + anchor.bottom) / 2 - height / 2, window.innerHeight - height - 8));
      const right = anchor.right + 12;
      setPlace({ left: right + WIDTH + 8 <= window.innerWidth ? right : fit(anchor.left - WIDTH - 12), top });
    }
  }, [anchor, phone, zoom]);

  useEffect(() => {
    grid.current?.querySelector<HTMLButtonElement>("[data-picked=true]")?.focus({ preventScroll: true });
    const back = returnTo.current;
    return () => { if (back instanceof HTMLElement && document.contains(back)) back.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    const away = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    if (!phone) document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, phone]);

  const onGridKey = (event: React.KeyboardEvent) => {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const by = moves[event.key];
    if (!by || zoom !== "days") return;
    event.preventDefault();
    const day = addDays(picked, by);
    if (day > now) return;
    pickDay(day);
    requestAnimationFrame(() => grid.current?.querySelector<HTMLButtonElement>("[data-picked=true]")?.focus({ preventScroll: true }));
  };

  const save = async () => {
    if (future || unchanged || saving) return;
    setSaving(true);
    if (!(await onSave(picked))) setSaving(false);
  };

  const setHours = (value: number) => {
    const next = uses12Hours ? (value % 12) + (hours >= 12 ? 12 : 0) : value;
    setPicked(withTime(startOfDay(picked), next, minutes));
  };
  const setHalf = (pm: boolean) => setPicked(withTime(startOfDay(picked), (hours % 12) + (pm ? 12 : 0), minutes));
  const still = stillFailed ? null : target.still;

  const sheet = (
    <form
      ref={ref}
      role="dialog"
      aria-label={target.from === null ? "Add the watch date" : "Change the watch date"}
      onSubmit={(event) => { event.preventDefault(); void save(); }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      style={phone ? undefined : { left: place?.left ?? -9999, top: place?.top ?? 0, width: WIDTH }}
      className={cx(
        "z-[130] flex flex-col overflow-hidden bg-popover/95 shadow-2xl shadow-black/60 ring-1 ring-white/10 backdrop-blur-xl",
        phone ? "fixed inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-3xl pb-[max(1rem,env(safe-area-inset-bottom))] animate-in slide-in-from-bottom duration-300" : "fixed max-w-[calc(100vw-1rem)] rounded-2xl animate-fade-in"
      )}
    >
      {phone && <span aria-hidden className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-white/20" />}
      <div className="flex items-center gap-3 p-3">
        <div className="relative aspect-video w-20 shrink-0 overflow-hidden rounded-md bg-white/5 ring-1 ring-inset ring-white/10">
          {still ? <img src={still} alt="" onError={() => setStillFailed(true)} className="h-full w-full object-cover" /> : <span className="flex h-full w-full items-center justify-center"><ImageOff className="size-4 text-muted-foreground/60" /></span>}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">When did you watch it?</p>
          <p className="truncate text-sm font-semibold leading-snug">{target.heading}</p>
          <p className={cx("truncate text-xs tabular-nums transition-colors", unchanged ? "text-muted-foreground" : "text-blue-300")}>
            {new Date(picked).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })} · {new Date(picked).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </p>
        </div>
      </div>

      <div className="flex gap-1.5 overflow-x-auto px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {quick.map((chip) => {
          const on = chip.is(picked);
          return (
            <button key={chip.label} type="button" onClick={() => { const at = chip.at(); setPicked(at); const d = new Date(at); setView({ year: d.getFullYear(), month: d.getMonth() }); setZoom("days"); }} aria-pressed={on} className={cx("h-8 shrink-0 whitespace-nowrap rounded-full px-3 text-[13px] font-medium ring-1 ring-inset transition-colors", on ? "bg-blue-500/20 text-blue-100 ring-blue-400/50" : "bg-white/[0.06] text-foreground/85 ring-white/10 hover:bg-white/[0.12]")}>
              {chip.label}
            </button>
          );
        })}
      </div>

      <div className="mx-3 mt-3 rounded-xl bg-white/[0.04] p-2 ring-1 ring-inset ring-white/[0.06]">
        <div className="mb-1 flex items-center justify-between">
          <button type="button" onClick={() => step(-1)} aria-label={zoom === "days" ? "Previous month" : "Previous year"} className="flex size-8 items-center justify-center rounded-full text-foreground/70 transition hover:bg-white/10 hover:text-foreground"><ChevronLeft className="size-4" /></button>
          <button type="button" onClick={() => setZoom((z) => (z === "days" ? "months" : "days"))} aria-label={zoom === "days" ? "Choose a month" : "Back to the days"} className="rounded-full px-3 py-1 text-sm font-semibold transition hover:bg-white/10">
            {zoom === "days" ? <>{monthName} <span className="text-muted-foreground">{view.year}</span></> : view.year}
          </button>
          <button type="button" onClick={() => step(1)} disabled={!canNext} aria-label={zoom === "days" ? "Next month" : "Next year"} className="flex size-8 items-center justify-center rounded-full text-foreground/70 transition hover:bg-white/10 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"><ChevronRight className="size-4" /></button>
        </div>
        {zoom === "days" ? (
          <div ref={grid} onKeyDown={onGridKey} role="grid" aria-label={`${monthName} ${view.year}`}>
            <div className="grid grid-cols-7 pb-1 text-center text-[11px] font-medium uppercase text-muted-foreground">{weekdays.map((w, i) => <span key={i}>{w}</span>)}</div>
            <div className="grid grid-cols-7 gap-y-0.5">
              {cells.map((day, i) => {
                if (day === null) return <span key={`e${i}`} />;
                const isPicked = sameDay(day, picked);
                const later = day > now;
                const before = released !== null && day < released;
                return (
                  <button
                    key={day}
                    type="button"
                    data-picked={isPicked}
                    tabIndex={isPicked ? 0 : -1}
                    disabled={later}
                    onClick={() => pickDay(day)}
                    aria-label={new Date(day).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                    aria-pressed={isPicked}
                    className={cx(
                      "relative mx-auto flex size-9 items-center justify-center rounded-full text-[13px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300",
                      isPicked ? "bg-blue-500 font-semibold text-white shadow-lg shadow-blue-500/30" : later ? "text-foreground/20" : before ? "text-foreground/40 hover:bg-white/10" : "text-foreground/90 hover:bg-white/10",
                      !isPicked && sameDay(day, now) && "ring-1 ring-inset ring-white/30",
                      !isPicked && released !== null && sameDay(day, released) && "text-blue-200"
                    )}
                  >
                    {new Date(day).getDate()}
                    {marked.has(day) && <span className={cx("absolute bottom-1 size-1 rounded-full", isPicked ? "bg-white" : "bg-blue-400")} />}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1 p-1">
            {Array.from({ length: 12 }, (_, m) => {
              const start = new Date(view.year, m, 1).getTime();
              const on = view.year === new Date(picked).getFullYear() && m === new Date(picked).getMonth();
              return (
                <button key={m} type="button" disabled={start > now} onClick={() => { setView({ year: view.year, month: m }); setZoom("days"); }} className={cx("h-10 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-25", on ? "bg-blue-500 text-white" : "hover:bg-white/10")}>
                  {new Date(view.year, m, 1).toLocaleDateString(undefined, { month: "short" })}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-3 pt-3">
        <Clock className="size-4 text-muted-foreground" />
        <TimeField label="Hour" value={uses12Hours ? hours % 12 || 12 : hours} min={uses12Hours ? 1 : 0} max={uses12Hours ? 12 : 23} onChange={setHours} />
        <span className="font-semibold text-muted-foreground">:</span>
        <TimeField label="Minute" value={minutes} min={0} max={59} onChange={(value) => setPicked(withTime(startOfDay(picked), hours, value))} />
        {uses12Hours && (
          <div className="ml-1 flex h-10 items-center gap-0.5 rounded-full bg-white/[0.07] p-1 ring-1 ring-inset ring-white/10">
            {(["AM", "PM"] as const).map((half) => {
              const on = (half === "PM") === hours >= 12;
              return <button key={half} type="button" onClick={() => setHalf(half === "PM")} aria-pressed={on} className={cx("h-full rounded-full px-3 text-xs font-semibold transition-colors", on ? "bg-white text-black shadow" : "text-muted-foreground hover:text-foreground")}>{half}</button>;
            })}
          </div>
        )}
      </div>

      <p className={cx("px-3 pt-3 text-xs leading-relaxed", future ? "text-amber-300" : "text-muted-foreground")}>
        {future ? "That's later than now. Pick a time that has passed." : dateNote(target, trackers)}
      </p>
      <div className="flex items-center justify-end gap-2 p-3">
        <button type="button" onClick={onClose} disabled={saving} className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-foreground/70 transition hover:bg-white/10 hover:text-foreground">Cancel</button>
        <button type="submit" disabled={future || unchanged || saving} className="inline-flex h-10 items-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-black shadow-lg shadow-black/30 transition hover:bg-white/90 active:scale-[0.98] disabled:opacity-50">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" strokeWidth={3} />} {target.from === null ? "Add date" : "Save"}
        </button>
      </div>
    </form>
  );

  return createPortal(
    phone ? (
      <div className="fixed inset-0 z-[130]">
        <div aria-hidden onClick={onClose} className="absolute inset-0 bg-black/55 animate-fade-in" />
        {sheet}
      </div>
    ) : sheet,
    document.body
  );
}
