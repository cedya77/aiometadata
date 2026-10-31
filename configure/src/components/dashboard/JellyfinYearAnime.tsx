import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { JellyfinAnimeEntry, JellyfinAnimeVoice, JellyfinYearTitle } from "@/hooks/useDashboardQueries";
import { titlePage, useDashboardOpen } from "./DashboardLink";
import { ChapterHeader, Deck, PersonLink, TitleLink, YEAR_GLASS } from "./JellyfinYearShared";
import { sizedArt } from "./art";
import type { YearChapterProps } from "./yearChapters";
import { hoursOf, inWords, metaIdOf, type YearModel } from "./yearModel";

const CLUB_SIZE = 8;
const SEASON_ROWS = 6;
const SEASON_ROW_H = 69;
const SEASON_FADES = {
  start: "linear-gradient(to bottom, black calc(100% - 48px), transparent)",
  middle: "linear-gradient(to bottom, transparent, black 32px, black calc(100% - 48px), transparent)",
  end: "linear-gradient(to bottom, transparent, black 32px)",
};
const STUDIO_ROWS = 6;
const STUDIO_COVERS = 3;
const THEME_TAGS = 10;
const TILE_GAP = 4;
const TILE_LABEL_W = 80;
const TILE_LABEL_H = 60;
const TILE_ROW = 5;
const TILE_ROW_H = 72;
const VOICE_CARDS = 4;
const VOICE_ROLES = 3;
const SOURCE_ROWS = 6;
const SOURCE_COLOURS = ["#f472b6", "#60a5fa", "#fbbf24", "#34d399", "#c4b5fd", "#9ca3af"];
const SEASONS = [
  { key: "winter", label: "Winter", kanji: "冬", colour: "#bfdbfe" },
  { key: "spring", label: "Spring", kanji: "春", colour: "#f9a8d4" },
  { key: "summer", label: "Summer", kanji: "夏", colour: "#fde68a" },
  { key: "fall", label: "Fall", kanji: "秋", colour: "#fdba74" },
];
const OUTLINE_PINK: CSSProperties = { WebkitTextStroke: "1.5px rgba(244,114,182,0.32)", color: "transparent", writingMode: "vertical-rl", fontSynthesis: "none" };
const COVER_RING = "shadow-[0_0_0_1px_rgba(255,255,255,0.12)]";

const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

function counted<T>(items: T[], keys: (item: T) => string[], weight: (item: T) => number = () => 1): Array<[string, number]> {
  const out = new Map<string, number>();
  for (const item of items) for (const key of keys(item)) out.set(key, (out.get(key) ?? 0) + weight(item));
  return [...out].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function listed(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function seasonOf(entry: JellyfinAnimeEntry): string | null {
  if (entry.season) return entry.season;
  if (!entry.airedFrom) return null;
  return SEASONS[Math.floor(new Date(entry.airedFrom).getUTCMonth() / 3)].key;
}

const airedAt = (entry: JellyfinAnimeEntry) => (entry.airedFrom ? Date.parse(entry.airedFrom) : Infinity);

function compactName(name: string): string {
  const numbered = name.match(/^(.+?\S)(?::\s|\s-\S).*\s(Season \d+)$/);
  if (numbered) return `${numbered[1]} ${numbered[2]}`;
  return name.match(/^(.+?\s\d+(?:st|nd|rd|th) Season):\s.+$/)?.[1] ?? name;
}

function shortName(entry: JellyfinAnimeEntry, franchise: string): string {
  const trimmed = entry.name.startsWith(franchise) ? entry.name.slice(franchise.length).replace(/^[\s:.\-–]+/, "") : entry.name;
  const parts = trimmed.split(" - ");
  return parts[parts.length - 1] || "Season 1";
}

function franchiseOf(entries: JellyfinAnimeEntry[]): string {
  const first = [...entries].sort((a, b) => airedAt(a) - airedAt(b))[0];
  return first.name.replace(/[\s:]+(Season \d+|\d+(st|nd|rd|th) Season|Part \d+|Cour \d+)$/i, "").replace(/\s*\(Cour \d+\)$/i, "");
}

const entryTarget = (entry: JellyfinAnimeEntry): { key: string; kind: "movie" | "series" } => ({ key: `mal:${entry.malId}`, kind: entry.type === "Movie" ? "movie" : "series" });

function Cover({ src, className = "" }: { src: string | null; className?: string }) {
  return src
    ? <img src={src} alt="" loading="lazy" className={`block aspect-[2/3] w-full object-cover ${className}`} />
    : <div className={`aspect-[2/3] w-full bg-gradient-to-br from-zinc-700 to-zinc-900 ${className}`} />;
}

function LongRoad({ title, entries }: { title: JellyfinYearTitle; entries: JellyfinAnimeEntry[] }) {
  const road = [...entries].sort((a, b) => airedAt(a) - airedAt(b));
  const franchise = franchiseOf(road);
  const episodes = road.reduce((total, entry) => total + entry.episodes, 0);
  const runs: Array<{ studio: string; count: number }> = [];
  for (const entry of road) {
    const studio = entry.studios[0] ?? "";
    if (runs.length && runs[runs.length - 1].studio === studio) runs[runs.length - 1].count += 1;
    else runs.push({ studio, count: 1 });
  }
  const named = runs.filter((run) => run.studio);
  const studios = named.length === 1 ? `${named[0].studio} animated every season.`
    : named.length === 2 ? `${named[0].studio} animated the first ${named[0].count === 1 ? "season" : `${inWords(named[0].count)} seasons`}, then ${named[1].studio} took over for the end.`
      : named.length > 2 ? `Animated by ${listed([...new Set(named.map((run) => run.studio))])}.` : "";
  const first = road[0];
  const last = road[road.length - 1];
  const background = title.facts?.background;
  let shownStudio = "";
  let studioIndex = -1;
  return (
    <div className="relative isolate mt-10 overflow-hidden rounded-[28px]">
      {background && <img src={sizedArt(background, 1280) ?? background} alt="" aria-hidden="true" className="absolute inset-0 -z-20 h-full w-full object-cover" />}
      <div aria-hidden="true" className="absolute inset-0 -z-10" style={{ background: "linear-gradient(90deg, rgba(12,13,15,0.97) 0%, rgba(12,13,15,0.85) 40%, rgba(12,13,15,0.55) 100%)" }} />
      <div className="flex flex-wrap items-center gap-9 p-6 sm:p-10">
        <div className="min-w-0 flex-[1_1_300px]">
          <span className="text-xs font-bold uppercase tracking-[0.16em] text-pink-400">The long road</span>
          <TitleLink title={title} name={franchise} className="mt-3.5 block w-fit max-w-full transition-opacity hover:opacity-85">
            {title.facts?.logo
              ? <img src={title.facts.logo} alt={franchise} className="block w-full max-w-[300px] [filter:drop-shadow(0_4px_18px_rgba(0,0,0,0.7))]" />
              : <span className="block text-4xl font-extrabold tracking-[-0.03em]">{franchise}</span>}
          </TitleLink>
          {first.japanese && <p className="mt-2.5 text-base tracking-[0.08em] text-foreground/80">{first.japanese}</p>}
          <p className="mt-5 flex flex-wrap items-baseline gap-x-3 text-[56px] font-black leading-[0.9] tracking-[-0.05em]">{episodes}<span className="text-lg font-semibold leading-snug tracking-normal text-foreground/80">episodes across {plural(road.length, "season")}</span></p>
          <p className="mt-3.5 text-sm leading-[1.5] text-muted-foreground">
            {first.year && last !== first ? `From ${first.year} to ${shortName(last, franchise)}. ` : ""}{studios}
          </p>
        </div>
        <div className="-mx-6 flex min-w-0 flex-[2_1_560px] items-end gap-3 overflow-x-auto sm:justify-end px-6 [scrollbar-width:none] sm:mx-0 sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
          {road.map((entry) => {
            const studio = entry.studios[0] ?? "";
            const changed = studio && studio !== shownStudio;
            if (changed) {
              shownStudio = studio;
              studioIndex += 1;
            }
            return (
              <TitleLink key={entry.malId} title={entryTarget(entry)} name={entry.name} className="group block w-24 min-w-0 shrink-0 sm:w-auto sm:max-w-[132px] sm:flex-1">
                <span className={`mb-2 block h-4 truncate text-[10px] font-bold uppercase tracking-[0.12em] ${studioIndex % 2 ? "text-pink-300" : "text-blue-300"}`}>{changed ? studio.replace(/ Studio$/, "") : ""}</span>
                <Cover src={entry.image} className="rounded-xl shadow-[0_18px_36px_-14px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.14)] transition-transform duration-300 group-hover:-translate-y-1" />
                <p className="mt-2 truncate text-xs font-semibold decoration-white/35 underline-offset-4 group-hover:underline">{shortName(entry, franchise)}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{entry.year ?? "?"} · {entry.episodes} eps</p>
              </TitleLink>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Club({ entries }: { entries: JellyfinAnimeEntry[] }) {
  const ranked = entries.filter((entry) => entry.rank).sort((a, b) => a.rank! - b.rank!);
  const ten = ranked.filter((entry) => entry.rank! <= 10);
  const club = (ten.length ? ten : ranked.filter((entry) => entry.rank! <= 100)).slice(0, CLUB_SIZE);
  if (!club.length) return null;
  return (
    <div className={`${YEAR_GLASS} min-w-0 flex-[1_1_520px] rounded-3xl p-5 sm:p-7`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-[15px] font-semibold">{ten.length ? "The top ten club" : "The top hundred club"}</h3>
        <span className="text-xs text-muted-foreground">MyAnimeList&apos;s all-time ranking</span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        {club.map((entry) => (
          <TitleLink key={entry.malId} title={entryTarget(entry)} name={entry.name} className="group block min-w-0">
            <div className="relative overflow-hidden rounded-[14px]">
              <Cover src={entry.image} className={`rounded-[14px] ${COVER_RING} transition-transform duration-300 group-hover:scale-[1.04]`} />
              <span className="absolute left-2 top-2 flex h-[30px] min-w-[30px] items-center justify-center rounded-full bg-pink-400 px-2 text-sm font-black text-background">#{entry.rank}</span>
            </div>
            <p className="mt-2.5 text-[13px] font-semibold leading-[1.3] decoration-white/35 underline-offset-4 group-hover:underline">{compactName(entry.name)}</p>
            {entry.japanese && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{entry.japanese}</p>}
            {entry.score && <p className="mt-1 text-xs font-semibold text-amber-300">MAL {entry.score.toFixed(2)}</p>}
          </TitleLink>
        ))}
      </div>
    </div>
  );
}

function Sources({ entries }: { entries: JellyfinAnimeEntry[] }) {
  const all = counted(entries.filter((entry) => entry.source && entry.source !== "Unknown"), (entry) => [entry.source!]);
  if (!all.length) return null;
  const rows = all.length > SOURCE_ROWS ? [...all.slice(0, SOURCE_ROWS - 1), ["Other", all.slice(SOURCE_ROWS - 1).reduce((total, [, n]) => total + n, 0)] as [string, number]] : all;
  return (
    <div className={`${YEAR_GLASS} rounded-3xl p-6`}>
      <h3 className="text-[15px] font-semibold">Where the stories came from</h3>
      <div role="img" aria-label={`Source material: ${rows.map(([name, n]) => `${n} ${name.toLowerCase()}`).join(", ")}`} className="mt-[18px] flex h-3.5 gap-[3px] overflow-hidden rounded-full">
        {rows.map(([name, n], i) => <span key={name} style={{ flex: `${n} 1 0`, background: SOURCE_COLOURS[i] }} />)}
      </div>
      <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2">
        {rows.map(([name, n], i) => (
          <span key={name} className="flex items-center gap-2 text-[13px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: SOURCE_COLOURS[i] }} />
            <span className="flex-1">{name}</span>
            <span className="tabular-nums text-muted-foreground">{n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Audience({ entries }: { entries: JellyfinAnimeEntry[] }) {
  const groups = counted(entries, (entry) => entry.demographics);
  if (!groups.length) return null;
  return (
    <div className={`${YEAR_GLASS} rounded-3xl p-6`}>
      <h3 className="text-[15px] font-semibold">Who it was made for</h3>
      <div className="mt-4 flex gap-2.5">
        {groups.slice(0, 4).map(([name, n], i) => (
          <div key={name} className={`min-w-0 rounded-2xl p-3.5 ${i ? "bg-white/[0.07]" : "bg-pink-400/[0.16]"}`} style={{ flex: `${Math.max(n, groups[0][1] / 4)} 1 0` }}>
            <p className="text-[28px] font-extrabold">{n}</p>
            <p className={`mt-0.5 truncate text-xs ${i ? "text-muted-foreground" : "text-pink-300"}`}>{name}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SeasonList({ shows }: { shows: JellyfinAnimeEntry[] }) {
  const [at, setAt] = useState<keyof typeof SEASON_FADES>("start");
  const scrolls = shows.length > SEASON_ROWS;
  const fade = scrolls ? SEASON_FADES[at] : undefined;
  return (
    <div
      tabIndex={scrolls ? 0 : undefined}
      aria-label={scrolls ? `${plural(shows.length, "show")}, scroll for more` : undefined}
      onScroll={scrolls ? (event) => {
        const list = event.currentTarget;
        setAt(list.scrollTop <= 4 ? "start" : list.scrollTop + list.clientHeight >= list.scrollHeight - 4 ? "end" : "middle");
      } : undefined}
      className={`flex min-w-0 flex-col gap-3 ${scrolls ? "-mr-2 overflow-y-auto overscroll-contain pr-2 [scrollbar-width:thin]" : ""}`}
      style={{ maxHeight: scrolls ? (SEASON_ROWS + 0.5) * SEASON_ROW_H : undefined, maskImage: fade, WebkitMaskImage: fade }}
    >
      {shows.map((entry) => (
        <TitleLink key={entry.malId} title={entryTarget(entry)} name={entry.name} className="group flex min-w-0 items-center gap-2.5">
          <div className="w-[38px] shrink-0"><Cover src={entry.image} className="rounded-md" /></div>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold decoration-white/35 underline-offset-4 group-hover:underline">{compactName(entry.name)}</p>
            <p className="mt-px text-[11px] text-muted-foreground">{plural(entry.episodes, "episode")}</p>
          </div>
        </TitleLink>
      ))}
    </div>
  );
}

function Seasons({ model, entries }: { model: YearModel; entries: JellyfinAnimeEntry[] }) {
  const ofYear = entries.filter((entry) => entry.year === model.year && seasonOf(entry));
  if (!ofYear.length) return null;
  const current = model.partial ? Math.floor(new Date(Date.UTC(model.year, 0, 1 + model.through)).getUTCMonth() / 3) : 4;
  const live = ofYear.filter((entry) => !entry.airedTo || entry.firstAt <= Date.parse(entry.airedTo) + 14 * 24 * 60 * 60 * 1000).length;
  return (
    <>
      <h3 className="mb-1.5 mt-14 text-[22px] font-bold tracking-[-0.02em]">Your {model.year} seasons</h3>
      <p className="mb-[18px] text-[13px] text-muted-foreground">{plural(ofYear.length, "show")} that aired this year{live * 2 > ofYear.length ? ", watched as they came out." : "."}</p>
      <Deck columns="lg:grid-cols-4">
        {SEASONS.map((season, i) => {
          const shows = ofYear.filter((entry) => seasonOf(entry) === season.key).sort((a, b) => b.episodes - a.episodes);
          const ahead = i > current;
          const now = i === current;
          return (
            <div key={season.key} className={`${YEAR_GLASS} flex min-w-0 flex-col gap-3 rounded-3xl p-5`}>
              <div className="flex items-center gap-3">
                <span aria-hidden="true" className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-2xl text-[28px] font-black text-background" style={{ background: season.colour }}>{season.kanji}</span>
                <div className="min-w-0">
                  <p className="text-[15px] font-bold">{season.label} {model.year}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{shows.length ? plural(shows.length, "show") : now ? "Just started" : ahead ? "Not yet" : "None watched"}</p>
                </div>
              </div>
              {shows.length > 0 && <SeasonList shows={shows} />}
              {!shows.length && (
                <div className="flex min-h-[120px] flex-1 items-center justify-center rounded-2xl border border-dashed border-white/[0.16] p-4 text-center text-xs leading-[1.5] text-muted-foreground">
                  {now || ahead ? "This season's shows land here as you start them." : "Nothing from this season."}
                </div>
              )}
            </div>
          );
        })}
      </Deck>
    </>
  );
}

function Studios({ entries, titleOf }: { entries: JellyfinAnimeEntry[]; titleOf: (entry: JellyfinAnimeEntry) => string }) {
  const rows = counted(entries, (entry) => entry.studios.slice(0, 1), (entry) => entry.episodes).slice(0, STUDIO_ROWS);
  if (!rows.length) return null;
  const top = rows[0][1];
  const lead = rows[0][0];
  const leadTitles = [...new Set(entries.filter((entry) => entry.studios[0] === lead).sort((a, b) => b.episodes - a.episodes).map(titleOf))];
  return (
    <div className={`${YEAR_GLASS} min-w-0 flex-[1_1_500px] rounded-3xl p-5 sm:p-7`}>
      <h3 className="text-[15px] font-semibold">Studios</h3>
      <p className="mt-1 text-xs text-muted-foreground">Episodes by the studio that animated them</p>
      <div className="mt-5 flex flex-col gap-3.5">
        {rows.map(([name, n], i) => {
          const covers = entries.filter((entry) => entry.studios[0] === name && entry.image).sort((a, b) => b.episodes - a.episodes).slice(0, STUDIO_COVERS);
          return (
            <div key={name} className="grid grid-cols-[100px_minmax(0,1fr)_72px] items-center gap-3.5 sm:grid-cols-[130px_minmax(0,1fr)_96px]">
              <span className="truncate text-sm font-semibold">{name}</span>
              <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.07]">
                <div className="h-full rounded-full" style={{ width: `${Math.round((n / top) * 100)}%`, background: i ? `rgba(249,168,212,${(0.7 - i * 0.08).toFixed(2)})` : "linear-gradient(90deg, #db2777, #f472b6)" }} />
              </div>
              <span className="flex justify-end">
                {covers.map((entry, j) => <TitleLink key={entry.malId} title={entryTarget(entry)} name={entry.name} className={`relative block transition-transform hover:z-10 hover:-translate-y-0.5 ${j ? "-ml-2" : ""}`}><img src={entry.image!} alt={entry.name} loading="lazy" className="block aspect-[2/3] w-[26px] rounded object-cover shadow-[0_0_0_2px_#17181b]" /></TitleLink>)}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-[18px] text-[13px] text-muted-foreground">{lead} animated {top.toLocaleString()} of your episodes{leadTitles.length ? `, across ${listed(leadTitles.slice(0, 3))}.` : "."}</p>
    </div>
  );
}

type Pick = { kind: "theme" | "genre"; name: string };

type Tile = { x: number; y: number; w: number; h: number };

function squarify(values: number[], width: number, height: number): Tile[] {
  const out: Tile[] = [];
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total || width <= 0 || height <= 0) return values.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const areas = values.map((value) => (value / total) * width * height);
  const worst = (sum: number, largest: number, smallest: number, side: number) => Math.max((side * side * largest) / (sum * sum), (sum * sum) / (side * side * smallest));
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    let end = i + 1;
    let sum = areas[i];
    while (end < areas.length && worst(sum + areas[end], areas[i], areas[end], side) <= worst(sum, areas[i], areas[end - 1], side)) {
      sum += areas[end];
      end += 1;
    }
    if (w >= h) {
      const strip = sum / h;
      let at = y;
      for (let k = i; k < end; k += 1) {
        const size = areas[k] / strip;
        out.push({ x, y: at, w: strip, h: size });
        at += size;
      }
      x += strip;
      w -= strip;
    } else {
      const strip = sum / w;
      let at = x;
      for (let k = i; k < end; k += 1) {
        const size = areas[k] / strip;
        out.push({ x: at, y, w: size, h: strip });
        at += size;
      }
      y += strip;
      h -= strip;
    }
    i = end;
  }
  return out;
}

function CoverTreemap({ entries, label }: { entries: JellyfinAnimeEntry[]; label: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [focus, setFocus] = useState<number | null>(null);
  const open = useDashboardOpen();
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const tiles = useMemo(() => squarify(entries.map((entry) => Math.sqrt(Math.max(1, entry.episodes))), box.w, box.h), [entries, box]);
  const placed = new Map(entries.map((entry, i) => [entry.malId, tiles[i]]));
  const focused = entries.find((entry) => entry.malId === focus) ?? null;
  return (
    <div className="mt-5 flex min-h-[220px] flex-1 flex-col">
      <div ref={stage} className="relative flex-1" style={{ minHeight: Math.max(200, Math.ceil(entries.length / TILE_ROW) * TILE_ROW_H) }} onPointerLeave={(event) => event.pointerType === "mouse" && setFocus(null)}>
        {entries.map((entry) => {
          const tile = placed.get(entry.malId);
          if (!tile) return null;
          const big = tile.w >= TILE_LABEL_W && tile.h >= TILE_LABEL_H;
          const on = focus === entry.malId;
          return (
            <button
              key={entry.malId}
              type="button"
              aria-label={`Open ${entry.name}, ${plural(entry.episodes, "episode")}`}
              onPointerEnter={(event) => event.pointerType === "mouse" && setFocus(entry.malId)}
              onFocus={() => setFocus(entry.malId)}
              onClick={() => {
                const target = entryTarget(entry);
                if (on && open) open(titlePage(metaIdOf(target.key), target.kind));
                else setFocus(entry.malId);
              }}
              className="absolute overflow-hidden rounded-lg transition-[left,top,width,height] duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
              style={{ left: tile.x + TILE_GAP / 2, top: tile.y + TILE_GAP / 2, width: Math.max(0, tile.w - TILE_GAP), height: Math.max(0, tile.h - TILE_GAP) }}
            >
              {entry.image
                ? <img src={sizedArt(entry.image, 342) ?? entry.image} alt="" loading="lazy" draggable={false} className={`h-full w-full object-cover object-top transition-transform duration-500 ${on ? "scale-105" : ""}`} />
                : <div className="h-full w-full bg-gradient-to-br from-zinc-700 to-zinc-900" />}
              <span aria-hidden="true" className={`pointer-events-none absolute inset-0 rounded-lg transition-shadow ${on ? "shadow-[inset_0_0_0_2px_rgba(244,114,182,0.85)]" : "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"}`} />
              {big && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-2 pb-1.5 pt-5 text-left">
                  <span className="block truncate text-[11px] font-semibold leading-tight">{compactName(entry.name)}</span>
                  <span className="block text-[10px] text-white/70">{plural(entry.episodes, "episode")}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[12px] text-muted-foreground">
        {focused
          ? <><TitleLink title={entryTarget(focused)} name={focused.name} className="font-semibold text-foreground decoration-white/35 underline-offset-4 hover:underline">{compactName(focused.name)}</TitleLink> · {plural(focused.episodes, "episode")}</>
          : <>{label}, larger for more episodes</>}
      </p>
    </div>
  );
}

function Themes({ entries }: { entries: JellyfinAnimeEntry[] }) {
  const tags = counted(entries, (entry) => entry.themes).slice(0, THEME_TAGS);
  const genres = counted(entries, (entry) => entry.genres).slice(0, 3).map(([name]) => name);
  const [picked, setPicked] = useState<Pick | null>(null);
  const current: Pick | null = picked ?? (tags[0] ? { kind: "theme", name: tags[0][0] } : genres[0] ? { kind: "genre", name: genres[0] } : null);
  const matching = useMemo(() => (current ? entries.filter((entry) => (current.kind === "theme" ? entry.themes : entry.genres).includes(current.name)).sort((a, b) => b.episodes - a.episodes || b.watchMs - a.watchMs) : []), [entries, current?.kind, current?.name]);
  if (!tags.length && !genres.length) return null;
  const most = tags[0]?.[1] ?? 1;
  const least = tags[tags.length - 1]?.[1] ?? 1;
  const tagName = (name: string) => name.split(" ").map((word, i) => (i && word !== word.toUpperCase() ? word.toLowerCase() : word)).join(" ");
  const isekai = entries.filter((entry) => entry.themes.includes("Isekai")).length;
  const chosen = (kind: Pick["kind"], name: string) => current?.kind === kind && current.name === name;
  return (
    <div className={`${YEAR_GLASS} flex min-w-0 flex-[1_1_380px] flex-col rounded-3xl p-5 sm:p-7`}>
      <h3 className="text-[15px] font-semibold">What the anime was about</h3>
      <p className="mt-1 text-xs text-muted-foreground">Themes tagged on MyAnimeList. Pick one to see its seasons.</p>
      <div className="mt-[18px] flex flex-wrap gap-2">
        {tags.map(([name, n]) => {
          const size = 12 + Math.round(((n - least) / Math.max(1, most - least)) * 12);
          const strong = n >= most * 0.35;
          const on = chosen("theme", name);
          return (
            <button key={name} type="button" aria-pressed={on} onClick={() => setPicked({ kind: "theme", name })} className={`inline-flex rounded-full transition-colors ${on ? "bg-pink-400/[0.28] text-foreground shadow-[inset_0_0_0_1px_rgba(244,114,182,0.55)]" : "bg-white/[0.07] hover:bg-white/[0.12]"} ${strong ? "font-bold text-foreground" : "font-medium text-foreground/80"}`} style={{ fontSize: size, padding: `${Math.round(size * 0.35)}px ${Math.round(size * 0.8)}px` }}>{tagName(name)}</button>
          );
        })}
      </div>
      {genres.length > 0 && (
        <p className="mt-[18px] text-[13px] text-muted-foreground">
          {genres.map((name, i) => (
            <span key={name}>
              {i > 0 && (i === genres.length - 1 ? " and " : ", ")}
              <button type="button" aria-pressed={chosen("genre", name)} onClick={() => setPicked({ kind: "genre", name })} className={`underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground ${chosen("genre", name) ? "text-pink-300 decoration-pink-300" : "decoration-white/30"}`}>{i === 0 ? name : name.toLowerCase()}</button>
            </span>
          ))}
          {" "}led the genres.
          {isekai >= 2 ? ` ${isekai} of your shows were isekai.` : ""}
        </p>
      )}
      {current && matching.length > 0 && <CoverTreemap entries={matching} label={`${plural(matching.length, "season")} ${current.kind === "theme" ? `tagged ${tagName(current.name)}` : `of ${current.name.toLowerCase()}`}`} />}
    </div>
  );
}

function Voices({ voices, entries, titleOf }: { voices: JellyfinAnimeVoice[]; entries: JellyfinAnimeEntry[]; titleOf: (entry: JellyfinAnimeEntry) => string }) {
  const shown = voices.slice(0, VOICE_CARDS);
  if (!shown.length) return null;
  const byId = new Map(entries.map((entry) => [entry.malId, entry]));
  const showOf = (ids: number[]): string => {
    const found = ids.map((id) => byId.get(id)).filter((entry): entry is JellyfinAnimeEntry => !!entry);
    if (!found.length) return "";
    if (found.length === 1) return compactName(found[0].name);
    const title = titleOf(found[0]);
    const all = entries.filter((entry) => titleOf(entry) === title).length;
    return found.every((entry) => titleOf(entry) === title) && found.length === all ? `Every ${title} season you watched` : listed(found.map((entry) => compactName(entry.name)));
  };
  return (
    <>
      <h3 className="mb-1.5 mt-14 text-[22px] font-bold tracking-[-0.02em]">Voices you kept hearing</h3>
      <p className="mb-[18px] text-[13px] text-muted-foreground">Japanese voice cast, matched to the characters they played for you</p>
      <Deck columns="lg:grid-cols-4">
        {shown.map((voice) => (
          <div key={voice.malId} className={`${YEAR_GLASS} flex min-w-0 flex-col gap-3.5 rounded-3xl p-5`}>
            <PersonLink person={{ id: voice.id, name: voice.name, photo: voice.image }} className="group flex items-center gap-3">
              {voice.image
                ? <img src={voice.image} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded-full object-cover object-top shadow-[0_0_0_3px_rgba(244,114,182,0.6)] transition-shadow group-hover:shadow-[0_0_0_3px_rgba(244,114,182,0.95)]" />
                : <span className="h-16 w-16 shrink-0 rounded-full bg-zinc-800 shadow-[0_0_0_3px_rgba(244,114,182,0.6)]" />}
              <div className="min-w-0">
                <p className="text-[15px] font-bold decoration-white/35 underline-offset-4 group-hover:underline">{voice.name}</p>
                {voice.japanese && <p className="mt-0.5 text-xs text-muted-foreground">{voice.japanese}</p>}
              </div>
            </PersonLink>
            {voice.roles.slice(0, VOICE_ROLES).map((role) => {
              const entry = byId.get(role.entries[0]);
              const body = (
                <>
                  {role.image
                    ? <img src={role.image} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded-xl object-cover object-top" />
                    : <span className="h-10 w-10 shrink-0 rounded-xl bg-zinc-800" />}
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold">{role.character}</p>
                    <p className="mt-px truncate text-[11px] text-muted-foreground decoration-white/35 underline-offset-4 group-hover:underline">{showOf(role.entries)}</p>
                  </div>
                </>
              );
              const key = `${role.character}-${role.entries[0]}`;
              return entry
                ? <TitleLink key={key} title={entryTarget(entry)} name={entry.name} className="group flex min-w-0 items-center gap-2.5">{body}</TitleLink>
                : <div key={key} className="flex min-w-0 items-center gap-2.5">{body}</div>;
            })}
          </div>
        ))}
      </Deck>
    </>
  );
}

export default function AnimeChapter({ model, number, label, accent }: YearChapterProps) {
  const anime = model.data.anime;
  const entries = useMemo(() => anime?.entries ?? [], [anime]);
  const byKey = useMemo(() => new Map(model.data.titles.map((title) => [title.key, title])), [model]);
  const franchises = useMemo(() => {
    const perTitle = new Map<string, JellyfinAnimeEntry[]>();
    for (const entry of entries) perTitle.set(entry.titleKey, [...(perTitle.get(entry.titleKey) ?? []), entry]);
    return new Map([...perTitle].map(([key, list]) => [key, franchiseOf(list)]));
  }, [entries]);
  const titleOf = (entry: JellyfinAnimeEntry) => franchises.get(entry.titleKey) ?? entry.name;
  const road = useMemo(() => {
    const perTitle = new Map<string, JellyfinAnimeEntry[]>();
    for (const entry of entries) perTitle.set(entry.titleKey, [...(perTitle.get(entry.titleKey) ?? []), entry]);
    const best = [...perTitle].filter(([key, list]) => list.length >= 2 && byKey.has(key)).sort((a, b) => b[1].length - a[1].length || b[1].reduce((t, e) => t + e.episodes, 0) - a[1].reduce((t, e) => t + e.episodes, 0))[0];
    return best ? { title: byKey.get(best[0])!, entries: best[1] } : null;
  }, [entries, byKey]);
  const plays = model.data.totals.anime.plays;
  const hours = hoursOf(model.plays.filter((play) => play.title.anime).reduce((total, play) => total + play.runtimeMs, 0));
  const ten = entries.filter((entry) => entry.rank && entry.rank <= 10).length;
  const hundred = entries.filter((entry) => entry.rank && entry.rank <= 100).length;
  const sub = entries.length ? `${plural(entries.length, "season")}${ten ? `, ${ten} from MAL's all-time top 10.` : hundred ? `, ${hundred} from MAL's top 100.` : "."}` : undefined;
  const club = <Club entries={entries} />;
  const sources = <Sources entries={entries} />;
  const audience = <Audience entries={entries} />;
  return (
    <div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute right-0 -top-[18px] hidden text-[132px] font-black leading-none tracking-[0.04em] lg:block" style={OUTLINE_PINK}>アニメ</span>
      <ChapterHeader number={number} label={label} accent={accent} title={`${plural(plays, "episode")} of anime.`} sub={sub} titleClassName="max-w-[900px]">
        About {plural(hours, "hour")}. Counted season by season, the way anime is released, so every sequel and cour is its own entry.
      </ChapterHeader>
      {!!anime?.unmatched && <p className="mt-3 max-w-[620px] text-[13px] text-muted-foreground">{plural(anime.unmatched, "episode")} had no MyAnimeList match, so {anime.unmatched === 1 ? "it counts" : "they count"} in the totals but not below.</p>}
      {road && <LongRoad title={road.title} entries={road.entries} />}
      <div className="mt-5 flex flex-wrap gap-5">
        {club}
        <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-5">
          {sources}
          {audience}
        </div>
      </div>
      <Seasons model={model} entries={entries} />
      <div className="mt-5 flex flex-wrap gap-5">
        <Studios entries={entries} titleOf={titleOf} />
        <Themes entries={entries} />
      </div>
      <Voices voices={anime?.voices ?? []} entries={entries} titleOf={titleOf} />
    </div>
  );
}
