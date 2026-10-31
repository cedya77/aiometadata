import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { JellyfinYearTitle } from "@/hooks/useDashboardQueries";
import { titlePage, useDashboardOpen } from "./DashboardLink";
import { ChapterHeader, TitleLink, TitleList, YEAR_GLASS } from "./JellyfinYearShared";
import { sizedArt } from "./art";
import type { YearChapterProps } from "./yearChapters";
import { displayName, formatDay, hoursOf, localYearOf, metaIdOf, type YearModel } from "./yearModel";

const TOP_TEN = 10;
const DECK_REACH = 3;
const DRAG_STEP_PX = 110;
const CAPTURE_PX = 8;
const FLY_MS = 70;
const MOMENTUM_MS = 260;
const VELOCITY_SAMPLES = 4;
const PAUSE_MS = 120;
const WHEEL_STEP = 90;
const WHEEL_IDLE_MS = 220;
const OUTLINE: CSSProperties = { WebkitTextStroke: "2px rgba(255,255,255,0.28)", color: "transparent" };
const NETWORK_LOGO: CSSProperties = { filter: "brightness(0) invert(1)" };
const REFLECT: CSSProperties = { transform: "scaleY(-1)", WebkitMaskImage: "linear-gradient(to top, black, transparent 75%)", maskImage: "linear-gradient(to top, black, transparent 75%)" };

const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

function formatRuntime(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} m` : `${minutes} m`;
}

function statusWord(status: string | null | undefined): "running" | "ended" | "cancelled" | null {
  const value = (status ?? "").toLowerCase();
  if (/cancel/.test(value)) return "cancelled";
  if (/end/.test(value)) return "ended";
  if (/continu|return|production|airing/.test(value)) return "running";
  return null;
}

const finished = (title: JellyfinYearTitle): boolean => !!title.progress?.finishedAt;

function Spotlight({ model, show, rest }: { model: YearModel; show: JellyfinYearTitle; rest: JellyfinYearTitle[] }) {
  const { totals, network } = model.data;
  const progress = show.progress;
  const share = totals.watchMs ? Math.round((show.watchMs / totals.watchMs) * 100) : 0;
  const busiest = useMemo(() => {
    const perDay = new Map<number, { plays: number; marked: number }>();
    for (const play of model.plays) {
      if (play.title !== show) continue;
      const day = perDay.get(play.day) ?? { plays: 0, marked: 0 };
      day.plays += 1;
      if (play.catchUp) day.marked += 1;
      perDay.set(play.day, day);
    }
    let best = { day: 0, plays: 0, marked: false };
    for (const [day, count] of perDay) if (count.plays > best.plays) best = { day, plays: count.plays, marked: count.marked * 2 > count.plays };
    return best;
  }, [model, show]);
  let ahead = 0;
  let sum = 0;
  for (const other of rest) {
    if (sum + other.episodes >= show.episodes) break;
    sum += other.episodes;
    ahead += 1;
  }
  const lead = ahead >= 2 ? `More episodes than your next ${ahead} shows put together.` : ahead === 1 ? "More episodes than any other show." : "Level with your next show for the most episodes.";
  const state = statusWord(show.facts?.status);
  const pct = progress ? Math.round((progress.seen / progress.aired) * 100) : 0;
  const left = progress ? progress.aired - progress.seen : 0;
  const background = show.facts?.background;
  const airs = [
    network && (
      <span key="network">
        {state === "running" ? "Airs on" : "Aired on"}{" "}
        {network.logo ? <img src={network.logo} alt={network.name} className="ml-0.5 inline-block h-3 align-[-1px]" style={NETWORK_LOGO} /> : network.name}
      </span>
    ),
    show.facts?.year && <span key="year">since {show.facts.year}</span>,
    state && <span key="state">{state === "running" ? "still running" : state}</span>,
  ].filter(Boolean);
  return (
    <div className="relative isolate flex min-h-[520px] items-end overflow-hidden rounded-[28px]">
      {background && <div aria-hidden="true" className="absolute inset-0 -z-20 bg-cover" style={{ backgroundImage: `url("${sizedArt(background, 1280) ?? background}")`, backgroundPosition: "center 25%" }} />}
      <div aria-hidden="true" className="absolute inset-0 -z-10" style={{ background: "linear-gradient(90deg, rgba(12,13,15,0.96) 0%, rgba(12,13,15,0.75) 45%, rgba(12,13,15,0.1) 100%), linear-gradient(0deg, rgba(12,13,15,0.9), rgba(12,13,15,0) 50%)" }} />
      <div className="flex w-full flex-wrap items-end gap-10 p-6 sm:p-12">
        <div className="min-w-0 flex-[1_1_420px]">
          <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-amber-400">Your number one show</span>
          <TitleLink title={show} name={displayName(show)} className="mt-4 block w-fit max-w-full transition-opacity hover:opacity-85">
            {show.facts?.logo
              ? <img src={show.facts.logo} alt={displayName(show)} className="block w-full max-w-[420px] [filter:drop-shadow(0_4px_20px_rgba(0,0,0,0.6))]" />
              : <span className="block text-4xl font-extrabold tracking-[-0.03em] sm:text-5xl">{displayName(show)}</span>}
          </TitleLink>
          <div className="mt-7 flex flex-wrap items-baseline gap-3">
            <span className="text-7xl font-black leading-[0.85] tracking-[-0.05em] sm:text-[96px]">{show.episodes.toLocaleString()}</span>
            <span className="text-lg text-foreground/80 sm:text-xl">{progress ? `episodes, of ${progress.aired.toLocaleString()}` : show.episodes === 1 ? "episode" : "episodes"}</span>
          </div>
          {progress && (
            <div className="mt-[18px] max-w-[460px]">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.12]"><div className="h-full bg-gradient-to-r from-blue-600 to-blue-400" style={{ width: `${pct}%` }} /></div>
              <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                <span>{pct}% of {plural(progress.seasons, "season")}</span>
                <span>{left ? `${left.toLocaleString()} to go` : state === "running" ? "all caught up" : "finished"}</span>
              </div>
            </div>
          )}
        </div>
        <div className="grid flex-[0_1_380px] grid-cols-2 gap-3">
          <div className={`${YEAR_GLASS} rounded-[18px] p-4`}><p className="whitespace-nowrap text-[22px] font-bold sm:text-[26px]">≈ {hoursOf(show.watchMs).toLocaleString()} h</p><p className="mt-1 text-xs text-muted-foreground">{share}% of your whole year</p></div>
          <div className={`${YEAR_GLASS} rounded-[18px] p-4`}><p className="text-[22px] font-bold sm:text-[26px]">{busiest.plays.toLocaleString()}</p><p className="mt-1 text-xs text-muted-foreground">{busiest.plays === 1 ? "episode" : "episodes"} {busiest.marked ? "marked on" : "on"} <span className="whitespace-nowrap">{formatDay(model.year, busiest.day)}</span>{busiest.marked ? "" : " alone"}</p></div>
          <div className={`${YEAR_GLASS} col-span-2 rounded-[18px] p-4`}>
            <p className="text-[15px] font-semibold leading-[1.4]">{lead}</p>
            {airs.length > 0 && <p className="mt-1.5 text-xs text-muted-foreground">{airs.flatMap((part, i) => (i ? [" · ", part] : [part]))}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function TopTenCard({ title, rank }: { title: JellyfinYearTitle; rank: number }) {
  const progress = title.progress;
  const done = finished(title);
  const state = statusWord(title.facts?.status);
  const poster = title.facts?.poster;
  const line = !progress ? plural(title.episodes, "episode")
    : done && title.episodes >= progress.aired ? `${title.episodes} of ${progress.aired} · all of it`
      : `${title.episodes} of ${progress.aired} episodes`;
  return (
    <TitleLink title={title} name={displayName(title)} className="group relative block w-[168px] shrink-0 snap-start">
      <span aria-hidden="true" className="absolute -left-1.5 -top-[18px] z-0 text-[92px] font-black leading-none tracking-[-0.06em]" style={OUTLINE}>{rank}</span>
      <div className="relative z-[1] ml-[34px] overflow-hidden rounded-[14px] shadow-[0_20px_40px_-16px_rgba(0,0,0,0.8),inset_0_0_0_1px_rgba(255,255,255,0.1)]">
        {poster
          ? <img src={sizedArt(poster, 342) ?? poster} alt="" loading="lazy" className="block aspect-[2/3] w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]" />
          : <div className="aspect-[2/3] w-full bg-gradient-to-br from-zinc-700 to-zinc-900" />}
        {done && <span className={`${YEAR_GLASS} absolute right-2 top-2 rounded-full px-2 py-[3px] text-[10px] font-bold tracking-[0.04em] text-green-300`}>{state === "running" ? "CAUGHT UP" : "FINISHED"}</span>}
      </div>
      <div className="ml-[34px] mt-2.5">
        <p className="truncate text-[13px] font-semibold decoration-white/35 underline-offset-4 group-hover:underline">{displayName(title)}</p>
        <p className="mb-1.5 mt-0.5 text-[11px] text-muted-foreground">{line}</p>
        {progress && <div className="h-[3px] overflow-hidden rounded-full bg-white/10"><div className={`h-full ${done ? "bg-green-400" : "bg-blue-400"}`} style={{ width: `${Math.round((progress.seen / progress.aired) * 100)}%` }} /></div>}
      </div>
    </TitleLink>
  );
}

function Stars({ rating }: { rating: number }) {
  const half = useId();
  const path = "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z";
  return (
    <span className="flex gap-0.5 text-amber-400">
      {Array.from({ length: 5 }, (_, i) => {
        const fill = Math.min(2, Math.max(0, rating - i * 2));
        return (
          <svg key={i} aria-hidden="true" width="15" height="15" viewBox="0 0 24 24">
            {fill === 1 && <defs><linearGradient id={half}><stop offset="50%" stopColor="currentColor" /><stop offset="50%" stopColor="rgba(255,255,255,0.2)" /></linearGradient></defs>}
            <path d={path} fill={fill === 2 ? "currentColor" : fill === 1 ? `url(#${half})` : "rgba(255,255,255,0.2)"} />
          </svg>
        );
      })}
    </span>
  );
}

function placement(d: number): { x: number; z: number; rotate: number } {
  const side = Math.sign(d);
  const depth = Math.abs(d);
  if (depth <= 1) return { x: d * 150, z: 90 - depth * 300, rotate: -d * 58 };
  return { x: side * (150 + (depth - 1) * 70), z: -140 - depth * 70, rotate: -side * 58 };
}

function Coverflow({ films, opening, label, caption }: { films: JellyfinYearTitle[]; opening: number; label: string; caption: (title: JellyfinYearTitle) => string }) {
  const [focus, setFocus] = useState(opening);
  const [goal, setGoal] = useState(opening);
  const [drag, setDrag] = useState<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; samples: Array<[number, number]> } | null>(null);
  const swiped = useRef(false);
  const open = useDashboardOpen();
  const last = films.length - 1;
  const clamp = (at: number) => Math.min(last, Math.max(0, at));
  const move = (by: number) => setGoal((at) => clamp(at + by));
  useEffect(() => {
    if (goal === focus) return;
    const timer = window.setTimeout(() => setFocus((at) => at + Math.sign(goal - at)), FLY_MS);
    return () => window.clearTimeout(timer);
  }, [goal, focus]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    let travel = 0;
    let lastAt = 0;
    const onWheel = (event: WheelEvent) => {
      const dx = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!dx || Math.abs(dx) < Math.abs(event.shiftKey ? 0 : event.deltaY)) return;
      event.preventDefault();
      const now = Date.now();
      if (now - lastAt > WHEEL_IDLE_MS || Math.sign(dx) !== Math.sign(travel)) travel = 0;
      lastAt = now;
      travel += dx;
      const steps = Math.trunc(travel / WHEEL_STEP);
      if (!steps) return;
      travel -= steps * WHEEL_STEP;
      setGoal((at) => Math.min(last, Math.max(0, at + steps)));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [last]);
  const release = (x: number | null, stamp = 0) => {
    const held = press.current;
    press.current = null;
    setDrag(null);
    if (!held || x === null) return;
    const dx = x - held.x;
    if (!swiped.current) return;
    const tail = held.samples.slice(-VELOCITY_SAMPLES);
    const [fromAt, fromX] = tail[0];
    const [toAt, toX] = tail[tail.length - 1];
    const velocity = stamp - toAt > PAUSE_MS || toAt <= fromAt ? 0 : (toX - fromX) / (toAt - fromAt);
    const landed = clamp(focus + Math.round(-dx / DRAG_STEP_PX));
    setFocus(landed);
    setGoal(clamp(landed + Math.round(-(velocity * MOMENTUM_MS) / DRAG_STEP_PX)));
  };
  const flying = goal !== focus;
  const shown = focus - (drag ?? 0) / DRAG_STEP_PX;
  const centre = films[Math.round(shown)] ?? films[focus];
  const ambient = centre?.facts?.background ?? centre?.facts?.poster;
  return (
    <>
      {ambient && <div aria-hidden="true" className="absolute -inset-10 -z-20 scale-110 bg-cover bg-center opacity-45 blur-[40px] saturate-150" style={{ backgroundImage: `url("${sizedArt(ambient, 342) ?? ambient}")` }} />}
      <div
        ref={stage}
        role="img"
        aria-label={label}
        className="relative h-[310px] cursor-grab touch-pan-y select-none [--s:0.72] [perspective:1400px] active:cursor-grabbing sm:h-[430px] sm:[--s:1]"
        onPointerDown={(event) => {
          press.current = { x: event.clientX, samples: [[event.timeStamp, event.clientX]] };
          swiped.current = false;
        }}
        onPointerMove={(event) => {
          const held = press.current;
          if (!held) return;
          const dx = event.clientX - held.x;
          held.samples.push([event.timeStamp, event.clientX]);
          if (held.samples.length > 20) held.samples.shift();
          if (!swiped.current && Math.abs(dx) <= CAPTURE_PX) return;
          if (!swiped.current) {
            swiped.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            setGoal(focus);
          }
          setDrag(Math.max((focus - last) * DRAG_STEP_PX, Math.min(focus * DRAG_STEP_PX, dx)));
        }}
        onPointerUp={(event) => release(event.clientX, event.timeStamp)}
        onPointerCancel={() => release(null)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            move(event.key === "ArrowRight" ? 1 : -1);
          }
        }}
      >
        {films.map((film, i) => {
          const d = i - shown;
          const depth = Math.abs(d);
          if (depth > DECK_REACH + 1) return null;
          const { x, z, rotate } = placement(d);
          const poster = film.facts?.poster ? sizedArt(film.facts.poster, 342) ?? film.facts.poster : null;
          const hidden = depth > DECK_REACH;
          return (
            <button
              key={film.key}
              type="button"
              tabIndex={hidden ? -1 : 0}
              aria-label={i === focus ? `Open ${displayName(film)}` : displayName(film)}
              onClick={() => {
                if (!swiped.current) {
                  if (i === focus && goal === focus && open) open(titlePage(metaIdOf(film.key), film.kind));
                  else setGoal(i);
                }
                swiped.current = false;
              }}
              className={`absolute left-1/2 top-[48%] w-[calc(var(--s)*210px)] cursor-pointer ease-out [transform-style:preserve-3d] ${drag !== null ? "" : flying ? "transition-[transform,filter,opacity] duration-200" : "transition-[transform,filter,opacity] duration-500"}`}
              style={{
                transform: `translate(-50%,-50%) translateX(calc(var(--s) * ${x}px)) translateZ(calc(var(--s) * ${z}px)) rotateY(${rotate}deg)`,
                zIndex: Math.round(100 - depth * 10),
                filter: `brightness(${Math.max(0, 1 - depth * 0.16)})`,
                opacity: Math.min(1, Math.max(0, DECK_REACH + 1 - depth)),
                pointerEvents: hidden ? "none" : undefined,
              }}
            >
              <div className={`overflow-hidden rounded-[14px] ${depth < 0.5 ? "shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9),inset_0_0_0_1px_rgba(255,255,255,0.25)]" : "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]"}`}>
                {poster ? <img src={poster} alt="" className="block aspect-[2/3] w-full object-cover" draggable={false} /> : <div className="aspect-[2/3] w-full bg-gradient-to-br from-zinc-700 to-zinc-900" />}
              </div>
              {poster && <div aria-hidden="true" className="mt-1 h-[60px] overflow-hidden rounded-[14px] opacity-30" style={REFLECT}><img src={poster} alt="" className="block aspect-[2/3] w-full object-cover object-bottom" draggable={false} /></div>}
            </button>
          );
        })}
      </div>
      {centre && (
        <p className="truncate px-6 text-center text-sm font-semibold">
          <TitleLink title={centre}>{displayName(centre)}</TitleLink>
          {caption(centre) && <span className="font-normal text-muted-foreground"> · {caption(centre)}</span>}
        </p>
      )}
    </>
  );
}

type Shelf = "films" | "shows";

function ShelfPanel({ model, films, shows, done }: { model: YearModel; films: JellyfinYearTitle[]; shows: JellyfinYearTitle[]; done: JellyfinYearTitle[] }) {
  const [picked, setShelf] = useState<Shelf>(films.length ? "films" : "shows");
  // A rebuild can leave the picked shelf empty, and the tabs only show while both kinds have titles.
  const shelf: Shelf = picked === "films" && !films.length ? "shows" : picked === "shows" && !shows.length ? "films" : picked;
  const { ratings } = model;
  const latest = (title: JellyfinYearTitle) => Math.max(...title.plays.map((play) => play[1]));
  const firstPlay = (title: JellyfinYearTitle) => Math.min(...title.plays.map((play) => play[1]));
  const titles = shelf === "films" ? films : shows;
  const rated = titles.filter((title) => ratings[title.key] !== undefined).sort((a, b) => ratings[b.key] - ratings[a.key] || latest(b) - latest(a));
  const best = rated[0];
  const deck = titles.filter((title) => title.facts?.poster).sort((a, b) => firstPlay(a) - firstPlay(b));
  const favourite = rated.find((title) => title.facts?.poster) ?? (shelf === "shows" ? shows.find((show) => show.facts?.poster) : [...deck].sort((a, b) => b.plays.length - a.plays.length || b.watchMs - a.watchMs)[0]);
  const runtimeOf = (film: JellyfinYearTitle) => film.facts?.runtimeMs || Math.max(0, ...film.plays.map((play) => play[2]));
  const oldest = titles.filter((title) => title.facts?.year).sort((a, b) => a.facts!.year! - b.facts!.year!)[0];
  const released = titles.filter((title) => title.facts?.year === model.year).length;
  const hours = hoursOf(titles.reduce((total, title) => total + title.watchMs, 0));
  const binge = useMemo(() => {
    const perDay = new Map<string, { title: JellyfinYearTitle; day: number; episodes: number }>();
    for (const play of model.plays) {
      if (play.film || play.catchUp) continue;
      const key = `${play.title.key}|${play.day}`;
      const held = perDay.get(key) ?? { title: play.title, day: play.day, episodes: 0 };
      held.episodes += 1;
      perDay.set(key, held);
    }
    return [...perDay.values()].sort((a, b) => b.episodes - a.episodes || a.day - b.day)[0];
  }, [model]);
  const fact = (label: string, value: ReactNode, sub?: string, wide = false) => (
    <div className={`${YEAR_GLASS} rounded-2xl p-3.5 ${wide ? "col-span-2" : ""}`}>
      <p className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-sm font-semibold">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
  const facts = shelf === "films"
    ? (() => {
        const longest = [...films].sort((a, b) => runtimeOf(b) - runtimeOf(a))[0];
        const again = films.filter((film) => film.plays.length >= 2).sort((a, b) => b.plays.length - a.plays.length);
        return (
          <>
            {longest && runtimeOf(longest) > 0 && fact("Longest", <TitleLink title={longest}>{displayName(longest)}</TitleLink>, formatRuntime(runtimeOf(longest)))}
            {oldest && fact("Oldest", <TitleLink title={oldest}>{displayName(oldest)}</TitleLink>, String(oldest.facts!.year))}
            {again.length > 0 && fact(again.every((film) => film.plays.length === 2) ? "Watched twice" : "Watched more than once", <TitleList titles={again.slice(0, 3)} nameOf={displayName} />, undefined, true)}
          </>
        );
      })()
    : (
        <>
          {binge && binge.episodes >= 2 && fact("Biggest binge", <TitleLink title={binge.title}>{displayName(binge.title)}</TitleLink>, `${plural(binge.episodes, "episode")} on ${formatDay(model.year, binge.day)}`)}
          {oldest && fact("Oldest", <TitleLink title={oldest}>{displayName(oldest)}</TitleLink>, String(oldest.facts!.year))}
          {done.length > 0 && fact(done.length === 1 ? "Finished" : `${done.length} finished`, <TitleList titles={done.slice(-3).reverse()} nameOf={displayName} />, done.length > 3 ? `and ${(done.length - 3).toLocaleString()} more` : undefined, true)}
        </>
      );
  const tabs: Array<[Shelf, string, number]> = [["films", "Films", films.length], ["shows", "Shows", shows.length]];
  return (
    <div className="relative isolate mt-[72px] overflow-hidden rounded-[28px]">
      <div aria-hidden="true" className="absolute inset-0 -z-10" style={{ background: "linear-gradient(90deg, #0c0d0f 0%, rgba(12,13,15,0.7) 50%, rgba(12,13,15,0.85) 100%)" }} />
      <div className="flex flex-wrap items-center gap-6 p-5 sm:p-10">
        {deck.length > 0 && (
          <div className="min-w-0 flex-[999_1_560px]">
            <Coverflow
              key={`${shelf}|${deck.length}`}
              films={deck}
              opening={Math.max(0, favourite ? deck.indexOf(favourite) : 0)}
              label={shelf === "films" ? "Your films this year, on a coverflow deck" : "Your shows this year, on a coverflow deck"}
              caption={(title) => (shelf === "films" ? (title.facts?.year ? String(title.facts.year) : "") : plural(title.episodes, "episode"))}
            />
          </div>
        )}
        <div className="min-w-0 flex-[1_1_340px]">
          {films.length > 0 && shows.length > 0
            ? (
                <div role="tablist" aria-label="Shelf" className={`${YEAR_GLASS} inline-flex rounded-full p-1`}>
                  {tabs.map(([key, name]) => (
                    <button key={key} type="button" role="tab" aria-selected={shelf === key} onClick={() => setShelf(key)} className={`rounded-full px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] transition ${shelf === key ? "bg-white text-black" : "text-muted-foreground hover:text-foreground"}`}>
                      {name}
                    </button>
                  ))}
                </div>
              )
            : <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{shelf === "films" ? "Films" : "Shows"}</span>}
          <p className="mt-3 text-5xl font-extrabold leading-none tracking-[-0.04em]">{plural(titles.length, shelf === "films" ? "film" : "show")}</p>
          <p className="mt-1.5 text-base text-foreground/80">{plural(hours, "hour")}{released ? `, ${released} of them ${shelf === "films" ? "released" : "premiered"} this year.` : "."}</p>
          {best && (
            <div className={`${YEAR_GLASS} mt-[22px] rounded-[20px] p-[18px]`}>
              <TitleLink title={best} name={displayName(best)} className="block w-fit max-w-[75%] transition-opacity hover:opacity-85">
                {best.facts?.logo
                  ? <img src={best.facts.logo} alt={displayName(best)} className="block max-h-[54px] max-w-full object-contain object-left" />
                  : <span className="block text-xl font-bold">{displayName(best)}</span>}
              </TitleLink>
              <p className="mt-3 text-[13px] text-muted-foreground">Your highest rated {shelf === "films" ? "film" : "show"} of the year</p>
              <p className="mt-1.5 flex items-center gap-2"><Stars rating={ratings[best.key]} /><span className="text-[13px] font-bold text-amber-300">{ratings[best.key]}/10</span></p>
            </div>
          )}
          <div className="mt-3.5 grid grid-cols-2 gap-2.5">{facts}</div>
        </div>
      </div>
    </div>
  );
}

export default function TitlesChapter({ model, number, label, accent }: YearChapterProps) {
  const byKey = useMemo(() => new Map(model.data.titles.map((title) => [title.key, title])), [model]);
  const shows = useMemo(() => model.data.topShows.map((key) => byKey.get(key)).filter((title): title is JellyfinYearTitle => !!title && title.episodes > 0), [model, byKey]);
  const films = useMemo(() => model.data.titles.filter((title) => title.kind === "movie"), [model]);
  const done = useMemo(() => shows.filter((show) => show.progress?.finishedAt && localYearOf(show.progress.finishedAt, model.timeZone) === model.year).sort((a, b) => a.progress!.finishedAt! - b.progress!.finishedAt!), [shows, model]);
  const [top, ...rest] = shows;
  const { totals } = model.data;
  const counts = [totals.shows.titles && plural(totals.shows.titles, "show"), totals.films.titles && plural(totals.films.titles, "film")].filter(Boolean).join(", ");
  return (
    <>
      <div className="mb-8">
        <ChapterHeader number={number} label={label} accent={accent} title={`${counts}.`} sub={top ? "And then there was this one." : undefined} />
      </div>
      {top && <Spotlight model={model} show={top} rest={rest} />}
      {rest.length > 0 && (
        <>
          <h3 className="mb-0.5 mt-12 text-[22px] font-bold tracking-[-0.02em]">The rest of the top ten</h3>
          <div className="-mx-4 flex snap-x gap-[18px] overflow-x-auto scroll-px-4 px-4 pb-3 pt-[18px] [scrollbar-width:none] sm:-mx-6 sm:scroll-px-6 sm:px-6 lg:mx-0 lg:px-0 [&::-webkit-scrollbar]:hidden">
            {rest.slice(0, TOP_TEN - 1).map((show, i) => <TopTenCard key={show.key} title={show} rank={i + 2} />)}
          </div>
        </>
      )}
      {done.length > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          You finished or caught up on <span className="font-semibold text-foreground">{plural(done.length, "show")}</span> this year
          {done.length === 1
            ? <>: <TitleLink title={done[0]}>{displayName(done[0])}</TitleLink>.</>
            : <>, from <TitleLink title={done[0]}>{displayName(done[0])}</TitleLink> to <TitleLink title={done[done.length - 1]}>{displayName(done[done.length - 1])}</TitleLink>.</>}
        </p>
      )}
      {(films.length > 0 || shows.length > 0) && <ShelfPanel key={model.year} model={model} films={films} shows={shows} done={done} />}
    </>
  );
}
