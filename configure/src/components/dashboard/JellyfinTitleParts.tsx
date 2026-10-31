import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckSquare, Ellipsis, Film, Loader2, MoreHorizontal, PencilLine, Play, Repeat, Square, Star, Tv } from "lucide-react";
import type { JellyfinTitle, JellyfinTitleAction, JellyfinTitleEpisode, JellyfinTitlePerson } from "@/hooks/useDashboardQueries";
import { ActionMenu } from "./JellyfinShared";
import { CHIP, CREDIT_LIMIT, cx, episodeMenuItems, GLASS_ROUND, orderedSeasons, PHONE_ACTION, seasonLabel, sizedStill, titleFacts, under, untilAir, useCenteredTab, type Anchor, type SeasonItem } from "./titleHelpers";
import CriticRatings from "./CriticRatings";
import { hasCriticRatings } from "./criticRatingSources";
import type { WatchDateAnchor } from "./JellyfinWatchDate";
import { anchorOf, duration, rewatchLabel, timesWatched, when } from "./jellyfinUtils";
import { moodsFor } from "./titleMoods";

export interface TitleActionSpec {
  key: string;
  label: string;
  icon: React.ReactNode;
  placement: "row" | "more";
  active?: boolean;
  busy?: boolean;
  detail?: string;
  run?: () => void;
  panel?: (close: () => void) => React.ReactNode;
}

export function PhoneTitleActions({ play, actions, name }: { play: React.ReactNode; actions: TitleActionSpec[]; name: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const row = actions.filter((action) => action.placement === "row");
  const more = actions.filter((action) => action.placement === "more");
  const panel = actions.find((action) => action.key === open && action.panel);
  return (
    <div className="mt-5 flex w-full flex-col gap-5">
      {play}
      <div className="flex w-full items-start px-2">
        {row.map((action) => (
          <button key={action.key} type="button" disabled={action.busy} aria-pressed={action.active} onClick={() => (action.panel ? setOpen(action.key) : action.run?.())} className={PHONE_ACTION}>
            {action.busy ? <Loader2 className="animate-spin" /> : action.icon}
            {action.label}
          </button>
        ))}
        {more.length > 0 && (
          <button type="button" onClick={() => setOpen("more")} className={PHONE_ACTION}>
            <Ellipsis strokeWidth={1.75} />
            More
          </button>
        )}
      </div>
      {open === "more" && (
        <PhoneSheet title={name} onClose={close}>
          {more.map((action) => <SheetRow key={action.key} icon={action.icon} label={action.label} detail={action.detail} disabled={action.busy} onClick={() => { close(); action.run?.(); }} />)}
        </PhoneSheet>
      )}
      {panel && <PhoneSheet title={name} onClose={close}>{panel.panel!(close)}</PhoneSheet>}
    </div>
  );
}

export function DesktopTitleActions({ play, actions }: { play: React.ReactNode; actions: TitleActionSpec[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const row = actions.filter((action) => action.placement === "row");
  const more = actions.filter((action) => action.placement === "more");
  return (
    <div className="flex flex-wrap items-center gap-3">
      {play}
      {row.map((action) => (
        <div key={action.key} className="relative">
          <button type="button" title={action.detail ?? action.label} aria-label={action.detail ?? action.label} aria-pressed={action.active} disabled={action.busy} onClick={() => (action.panel ? setOpen((held) => (held === action.key ? null : action.key)) : action.run?.())} className={cx(GLASS_ROUND, action.active && "bg-white/20")}>
            {action.busy ? <Loader2 className="size-5 animate-spin" /> : action.icon}
          </button>
          {open === action.key && action.panel && (
            <div className="absolute left-0 top-14 z-30 w-[22rem] rounded-2xl bg-popover/95 p-1 shadow-2xl ring-1 ring-white/10 backdrop-blur-xl animate-fade-in">{action.panel(close)}</div>
          )}
        </div>
      ))}
      {more.length > 0 && (
        <button type="button" aria-label="More" title="More" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setMenu((held) => (held ? null : { x: box.left, y: box.bottom + 8 })); }} className={GLASS_ROUND}>
          <Ellipsis className="size-[22px]" />
        </button>
      )}
      {menu && <ActionMenu at={menu} onClose={closeMenu} items={more.map((action) => ({ icon: action.icon, label: action.label, onSelect: () => action.run?.() }))} />}
    </div>
  );
}

export function FactsBlock({ title, seasonCount, phone }: { title: JellyfinTitle; seasonCount: number; phone: boolean }) {
  const ratings = title.ratings ?? [];
  const critics = hasCriticRatings(ratings);
  const facts = titleFacts(title, seasonCount);
  const score = !critics && title.score ? title.score : null;
  if (phone) {
    return (
      <div className="flex flex-col items-center gap-2.5">
        {facts.length > 0 && (
          <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[13px] font-medium text-[#d8d0c6]">
            {facts.map((fact, index) => (
              <span key={fact} className="inline-flex items-center gap-2">{index > 0 && <span aria-hidden className="size-[3px] rounded-full bg-[#d8d0c6]/45" />}{fact}</span>
            ))}
          </p>
        )}
        {critics && <CriticRatings ratings={ratings} className="justify-center gap-x-3 text-[13px] text-[#ece6df]" iconClassName="h-[15px]" />}
        {(score || title.certification || title.genres.length > 0) && (
          <div className="flex flex-wrap justify-center gap-1.5">
            {score && <span className={CHIP}><Star className="size-3 fill-[#f2c46b] text-[#f2c46b]" />{score}</span>}
            {title.certification && <span className={CHIP}>{title.certification}</span>}
            {title.genres.map((genre) => <span key={genre} className={cx(CHIP, "font-medium text-[#d8d0c6]")}>{genre}</span>)}
          </div>
        )}
      </div>
    );
  }
  const parts: React.ReactNode[] = [
    ...facts.map((fact) => <span key={fact}>{fact}</span>),
    score && <span key="score" className="inline-flex items-center gap-1 font-medium text-foreground"><Star className="size-3.5 fill-amber-400 text-amber-400" />{score}</span>,
    title.certification && <span key="cert" className="rounded-sm border border-foreground/40 px-1.5 text-xs font-semibold leading-5 text-foreground">{title.certification}</span>,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2.5">
        {parts.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground/80">
            {parts.map((part, index) => <span key={index} className="inline-flex items-center gap-2">{index > 0 && <span aria-hidden className="text-foreground/35">·</span>}{part}</span>)}
          </div>
        )}
        {critics && <CriticRatings ratings={ratings} className="text-[15px] text-foreground" iconClassName="h-[17px]" />}
      </div>
      {title.genres.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {title.genres.map((genre, index) => <span key={genre} className="inline-flex items-center gap-2">{index > 0 && <span aria-hidden className="text-foreground/35">·</span>}{genre}</span>)}
        </p>
      )}
    </div>
  );
}

export function MoodLine({ title, phone }: { title: JellyfinTitle; phone: boolean }) {
  const moods = moodsFor(title.tags ?? [], title.genres);
  if (!moods.length) return null;
  const Icon = title.type === "series" ? Tv : Film;
  return (
    <p className={cx("flex flex-wrap items-center gap-x-2.5 gap-y-1", phone ? "-mt-1 w-full justify-center text-[13px] font-medium text-[#d8d0c6]/80" : "text-sm font-semibold tracking-wide text-foreground")}>
      {!phone && <><Icon aria-hidden className="size-4 text-muted-foreground" /><span className="sr-only">{title.type === "series" ? "This show is:" : "This movie is:"} </span></>}
      {moods.map((mood, index) => (
        <span key={mood} className="inline-flex items-center gap-2.5">
          {index > 0 && <><span aria-hidden className="size-1.5 rounded-full bg-blue-500" /><span className="sr-only">, </span></>}
          {mood}
        </span>
      ))}
    </p>
  );
}

export function Credits({ title, onPerson }: { title: JellyfinTitle; onPerson: (person: JellyfinTitlePerson) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const people = (type: string) => title.people.filter((person) => person.type === type && person.name);
  const credits = [
    { key: "directors", label: "Directed by", people: people("Director"), names: [] as string[] },
    { key: "writers", label: "Written by", people: people("Writer"), names: [] as string[] },
    { key: "studios", label: "Studios", people: [] as JellyfinTitlePerson[], names: title.studios ?? [] },
  ].filter((credit) => credit.people.length || credit.names.length);
  if (!credits.length) return null;
  return (
    <div className="flex w-full max-w-4xl flex-wrap gap-x-12 gap-y-5 border-t border-white/10 pt-6 max-sm:justify-center max-sm:text-center">
      {credits.map((credit) => {
        const total = credit.people.length || credit.names.length;
        const expanded = open[credit.key];
        const limit = expanded ? total : CREDIT_LIMIT;
        return (
          <div key={credit.key} className="flex min-w-0 max-w-xs flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{credit.label}</span>
            <p className="text-sm font-medium leading-relaxed">
              {credit.people.slice(0, limit).map((person, index) => (
                <span key={person.id}>{index > 0 && ", "}<button type="button" onClick={() => onPerson(person)} className="hover:underline">{person.name}</button></span>
              ))}
              {credit.names.slice(0, limit).join(", ")}
              {total > CREDIT_LIMIT && (
                <button type="button" onClick={() => setOpen((held) => ({ ...held, [credit.key]: !expanded }))} className="ml-2 text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground">
                  {expanded ? "Show less" : `+${total - CREDIT_LIMIT} more`}
                </button>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}

const SHEET_DISMISS_PX = 90;
const SHEET_FLICK_PX_PER_MS = 0.5;
const SHEET_MS = 220;
const SHEET_DRAG_START_PX = 6;

export function PhoneSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const press = useRef<{ y: number; at: number; lastY: number; lastAt: number; id: number } | null>(null);
  const dragged = useRef(false);
  const [offset, setOffset] = useState<number | null>(null);
  const [state, setState] = useState<"entering" | "open" | "leaving">("entering");
  const height = () => panel.current?.offsetHeight ?? window.innerHeight;
  const dismiss = useCallback(() => {
    setState("leaving");
    window.setTimeout(onClose, SHEET_MS);
  }, [onClose]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setState("open"));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && dismiss();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);
  const shift = state === "open" ? offset ?? 0 : height();
  const shade = state === "open" ? Math.max(0, 1 - (offset ?? 0) / height()) : 0;
  return (
    <div className="fixed inset-0 z-[120] flex items-end" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" onClick={dismiss} className="absolute inset-0 bg-black/55 transition-opacity" style={{ opacity: shade, transitionDuration: offset === null ? `${SHEET_MS}ms` : "0ms" }} />
      <div
        ref={panel}
        onPointerDown={(event) => {
          press.current = { y: event.clientY, at: event.timeStamp, lastY: event.clientY, lastAt: event.timeStamp, id: event.pointerId };
          dragged.current = false;
        }}
        onPointerMove={(event) => {
          const held = press.current;
          if (!held || held.id !== event.pointerId) return;
          const dy = event.clientY - held.y;
          if (!dragged.current) {
            if (Math.abs(dy) < SHEET_DRAG_START_PX) return;
            dragged.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          held.lastY = event.clientY;
          held.lastAt = event.timeStamp;
          setOffset(Math.max(0, dy));
        }}
        onPointerUp={(event) => {
          const held = press.current;
          press.current = null;
          if (!held || !dragged.current) return;
          const dy = Math.max(0, event.clientY - held.y);
          const elapsed = Math.max(1, held.lastAt - held.at);
          const speed = (held.lastY - held.y) / elapsed;
          setOffset(null);
          if (dy > SHEET_DISMISS_PX || speed > SHEET_FLICK_PX_PER_MS) dismiss();
        }}
        onPointerCancel={() => {
          press.current = null;
          setOffset(null);
        }}
        onClickCapture={(event) => {
          if (!dragged.current) return;
          event.preventDefault();
          event.stopPropagation();
          dragged.current = false;
        }}
        className="relative flex w-full touch-none flex-col gap-1 rounded-t-3xl border-t border-white/10 bg-background/90 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 backdrop-blur-2xl ease-out"
        style={{ transform: `translateY(${shift}px)`, transition: offset === null ? `transform ${SHEET_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : "none" }}
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-foreground/20" />
        <p className="truncate px-2 pb-1 text-base font-semibold">{title}</p>
        {children}
      </div>
    </div>
  );
}

export function SheetRow({ icon, label, detail, onClick, disabled }: { icon: React.ReactNode; label: string; detail?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="flex w-full items-center gap-4 rounded-xl px-2 py-2.5 text-left active:bg-foreground/5 disabled:opacity-50">
      <span className="flex size-10 items-center justify-center rounded-full bg-foreground/[0.08] [&_svg]:size-5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium">{label}</span>
        {detail && <span className="block text-xs text-muted-foreground">{detail}</span>}
      </span>
    </button>
  );
}

export function StarPicker({ value, onPick }: { value: number | null; onPick: (rating: number | null) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <div className="mt-2 rounded-2xl bg-foreground/5 px-4 py-3" onMouseLeave={() => setHover(null)}>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm font-medium">Your rating</span>
        <span className="text-sm tabular-nums text-muted-foreground">{shown ? `${shown}/10` : "Not rated"}</span>
      </div>
      <div className="flex items-center justify-between">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <button key={n} type="button" onMouseEnter={() => setHover(n)} onClick={() => onPick(n === value ? null : n)} aria-label={`${n} out of 10`} className="p-0.5">
            <Star className={cx("size-6 transition", n <= shown ? "text-amber-400" : "text-white/25")} fill="currentColor" strokeWidth={0} />
          </button>
        ))}
      </div>
    </div>
  );
}

export function SeasonPills({ seasons, watched, selected, onSelect, onMenu }: { seasons: SeasonItem[]; watched: Set<number>; selected: number | null; onSelect: (season: number) => void; onMenu: (season: SeasonItem, at: { x: number; y: number }) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const ordered = useMemo(() => orderedSeasons(seasons), [seasons]);
  useCenteredTab(track, selected);
  return (
    <div ref={track} role="tablist" aria-label="Select a season" className="-mx-4 flex max-w-[calc(100%+2rem)] gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {ordered.map((season) => {
        const active = season.season === selected;
        return (
          <button
            key={season.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(season.season)}
            onContextMenu={(event) => { event.preventDefault(); onMenu(season, { x: event.clientX, y: event.clientY }); }}
            className={cx("flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-semibold outline-none transition-colors", active ? "bg-[#f6f2ed] text-[#121110]" : "bg-white/[0.08] text-white/80 active:bg-white/[0.14]")}
          >
            {seasonLabel(season.season)}
            {watched.has(season.season) && <Check aria-label="Season watched" className="size-3.5" strokeWidth={3} />}
          </button>
        );
      })}
    </div>
  );
}

export function EpisodeListRow({ ep, now, selecting, selected, busy, highlighted, onToggleSelect, onAction, onPlayOn, onDate }: {
  ep: JellyfinTitleEpisode;
  now: number;
  selecting: boolean;
  selected: boolean;
  busy: boolean;
  highlighted: boolean;
  onToggleSelect: () => void;
  onAction: (action: JellyfinTitleAction) => void;
  onPlayOn: (at: Anchor) => void;
  onDate: (anchor: WatchDateAnchor) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [failed, setFailed] = useState(false);
  const unaired = Boolean(ep.airsAt && ep.airsAt > now);
  const progress = ep.played ? 0 : ep.runtimeMs > 0 && ep.positionMs > 0 ? Math.min(100, (ep.positionMs / ep.runtimeMs) * 100) : 0;
  const still = failed ? null : sizedStill(ep.still, 320);
  const facts = [
    ep.runtimeMs > 0 && duration(ep.runtimeMs),
    ep.airsAt && (unaired ? `Airs ${untilAir(ep.airsAt)}` : new Date(ep.airsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })),
  ].filter(Boolean).join(" · ");
  return (
    <div
      data-episode={ep.id}
      onClick={selecting ? onToggleSelect : undefined}
      onContextMenu={(event) => { if (!selecting) { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); } }}
      className={cx("-mx-2 flex flex-col gap-2 rounded-2xl p-2 transition-colors", (highlighted || selected) && "bg-white/[0.06]", selecting && "cursor-pointer")}
    >
      <div className="flex items-center gap-3">
        <div className="relative aspect-video w-[8.5rem] shrink-0 overflow-hidden rounded-xl bg-white/[0.06] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]">
          {still && <img src={still} alt="" loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover" />}
          {selecting ? (
            <span className="absolute left-1.5 top-1.5 text-white drop-shadow">{selected ? <CheckSquare className="size-5 text-blue-300" /> : <Square className="size-5" />}</span>
          ) : !unaired && (
            <button type="button" aria-label="Play on a device" onClick={(event) => { event.stopPropagation(); onPlayOn(under(event.currentTarget)); }} className="absolute left-1/2 top-1/2 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/25 bg-black/55">
              <Play className="size-3.5 fill-white text-white" />
            </button>
          )}
          {ep.played && !selecting && <span title="Watched" className="absolute left-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-green-600 text-white"><Check className="size-3" strokeWidth={3} /></span>}
          {progress > 0 && <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/25"><span className="block h-full bg-[#f6f2ed]" style={{ width: `${progress}%` }} /></span>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[15.5px] font-semibold leading-snug">{ep.number !== null && `${ep.number}. `}{ep.name || "No title"}</p>
          {facts && <p className="mt-0.5 text-[13px] tabular-nums text-white/50">{facts}</p>}
        </div>
        {!selecting && (
          <button type="button" onClick={(event) => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); setMenu((v) => (v ? null : { x: box.right - 224, y: box.bottom + 4 })); }} aria-label="More" className="flex size-9 shrink-0 items-center justify-center rounded-full text-white/70 active:bg-white/10">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-5" />}
          </button>
        )}
        {menu && <ActionMenu at={menu} onClose={closeMenu} items={episodeMenuItems(ep, unaired, menu, onAction, onPlayOn)} />}
      </div>
      {ep.overview && <p className="line-clamp-2 text-[13.5px] leading-normal text-[#f0eae3]/[0.62]">{ep.overview}</p>}
      {(ep.played || ep.positionMs > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {ep.played && (
            <button
              type="button"
              disabled={selecting}
              onClick={(event) => { event.stopPropagation(); onDate(anchorOf(event.currentTarget)); }}
              className="inline-flex items-center gap-1 rounded-full bg-white/[0.08] px-2.5 py-1 text-xs font-medium text-[#ece6df] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]"
            >
              <Check className="size-3" strokeWidth={3} /> {ep.watches[0] ? when(ep.watches[0]) : "Watched"}{timesWatched(ep) > 1 ? ` · ×${timesWatched(ep)}` : ""}
              <PencilLine className="size-3 opacity-60" />
            </button>
          )}
          {ep.played && ep.positionMs > 0 && <span className={CHIP}><Repeat className="size-3" /> {rewatchLabel(ep.positionMs)}</span>}
          {!ep.played && ep.positionMs > 0 && ep.runtimeMs > 0 && <span className={CHIP}>{duration(Math.max(0, ep.runtimeMs - ep.positionMs))} left</span>}
        </div>
      )}
    </div>
  );
}
