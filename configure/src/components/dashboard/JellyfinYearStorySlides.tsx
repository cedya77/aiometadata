import { useMemo, type CSSProperties, type ReactNode } from "react";
import { Download, RotateCcw } from "lucide-react";
import type { JellyfinYearTitle } from "@/hooks/useDashboardQueries";
import { artAt } from "./art";
import { plural, yearFill } from "./JellyfinYearShared";
import { regionName, yearPlaces } from "./yearPlaces";
import { WEEKDAY_NAMES, byWatchTime, displayName, formatHour, hoursOf, rankedAnime, seasonOf, topShowOf, wallPosters, yearBackdrop, yearTime, type YearModel } from "./yearModel";

export interface StorySlideProps {
  model: YearModel;
  owner: string;
  onShare: () => void;
  onReplay: () => void;
}

const GLASS = "bg-white/[0.08] backdrop-blur-[18px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]";
const KICKER = "text-xs font-bold uppercase tracking-[0.18em]";
const HEADLINE = "text-[clamp(30px,9cqw,40px)] font-extrabold leading-[1.05] tracking-[-0.035em]";
const WALL_SIZE = 36;
const CLOCK_BARS_AT_HALF = 0.5;
const POSTER_SHADOW = "shadow-[0_16px_30px_-12px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.12)]";

/** Lifts a piece of a slide in, one step after another. */
function Rise({ step, className = "", style, children }: { step: number; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <div className={`motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:fill-mode-both motion-safe:duration-700 ${className}`} style={{ ...style, animationDelay: `${120 + step * 110}ms` }}>
      {children}
    </div>
  );
}

function Wall({ model, className = "" }: { model: YearModel; className?: string }) {
  const posters = useMemo(() => wallPosters(model, WALL_SIZE), [model]);
  if (!posters.length) return null;
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute -inset-x-[220px] -inset-y-[120px] z-[-2] ${className}`} style={{ transform: "perspective(900px) rotateX(30deg) rotateZ(-14deg)" }}>
      <div className="grid grid-cols-6 gap-2.5 motion-safe:animate-story-drift">
        {posters.map((src, i) => <img key={i} src={src} alt="" className="block aspect-[2/3] w-full rounded-lg object-cover" />)}
      </div>
    </div>
  );
}

function Continue() {
  return (
    <p className="mt-6 text-xs text-[#8f949c]">
      <span className="[@media(pointer:fine)]:hidden">Tap to continue</span>
      <span className="hidden [@media(pointer:fine)]:inline">Click or press → to continue</span>
    </p>
  );
}

export function IntroSlide({ model, owner }: StorySlideProps) {
  const { totals } = model.data;
  const titles = model.data.titles.length;
  return (
    <>
      <Wall model={model} className="opacity-50" />
      <div aria-hidden="true" className="absolute inset-0 z-[-1] bg-[linear-gradient(to_top,#0c0d0f_30%,rgba(12,13,15,0.3)_70%,rgba(12,13,15,0.75))]" />
      <div className="absolute inset-x-7 bottom-10">
        <Rise step={0}><span className="text-xs uppercase tracking-[0.18em] text-[#c4c8ce]">{owner} · year in review</span></Rise>
        <Rise step={1}><p className="-ml-1.5 mt-2 w-fit bg-clip-text text-[clamp(104px,34cqw,136px)] font-black leading-[0.85] tracking-[-0.07em] text-transparent" style={yearFill(yearBackdrop(model))}>{model.year}</p></Rise>
        <Rise step={2}>
          <p className="mt-[18px] text-[26px] font-bold leading-[1.2] tracking-[-0.02em]">
            {plural(hoursOf(totals.watchMs), "hour")}.<br />{plural(titles, "title")}.<br /><span className="text-[#9ca1a9]">{model.partial ? "So far. " : ""}Let's look back.</span>
          </p>
        </Rise>
        <Rise step={3}><Continue /></Rise>
      </div>
    </>
  );
}

function aheadOfTheRest(show: JellyfinYearTitle, model: YearModel): string {
  const others = model.data.titles.filter((title) => title.kind === "series" && title !== show).map((title) => title.episodes).sort((a, b) => b - a);
  let sum = 0;
  let beaten = 0;
  for (const episodes of others) {
    if (sum + episodes >= show.episodes) break;
    sum += episodes;
    beaten += 1;
  }
  if (beaten >= 2 && beaten === others.length) return "More episodes than every other show you watched put together.";
  if (beaten >= 2) return `More episodes than your next ${beaten} shows put together.`;
  const second = model.data.titles.find((title) => title.key === model.data.topShows[1]);
  if (second && show.episodes > second.episodes) return `${plural(show.episodes - second.episodes, "more episode")} than ${displayName(second)}, your number two.`;
  const share = model.data.totals.shows.plays ? Math.round((show.plays.length / model.data.totals.shows.plays) * 100) : 0;
  return `${share}% of every episode you played this year.`;
}

export function TopShowSlide({ model }: StorySlideProps) {
  const show = topShowOf(model)!;
  const backdrop = artAt(show.facts?.background ?? show.facts?.poster, "w1280", 1280);
  const logo = artAt(show.facts?.logo, "w500", 500);
  const episodes = show.plays.length;
  const seasons = new Set(show.plays.map(([videoId]) => seasonOf(videoId)).filter((season) => season !== null)).size;
  const progress = show.progress && show.progress.aired > 0 ? show.progress : null;
  const left = progress ? Math.max(0, progress.aired - progress.seen) : 0;
  const share = progress ? Math.min(100, Math.round((progress.seen / progress.aired) * 100)) : 0;
  const unit = episodes === 1 ? "episode" : "episodes";
  return (
    <>
      {backdrop && <img src={backdrop} alt="" className="absolute inset-x-0 top-0 z-[-2] h-[62%] w-full object-cover object-[60%_center] motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-105 motion-safe:duration-1000" />}
      <div aria-hidden="true" className="absolute inset-0 z-[-1] bg-[linear-gradient(to_top,#0c0d0f_42%,rgba(12,13,15,0.2)_75%,rgba(12,13,15,0.6))]" />
      <div className="absolute inset-x-7 bottom-10">
        <Rise step={0}><span className={`${KICKER} text-amber-400`}>Your number one show</span></Rise>
        <Rise step={1}>
          {logo
            ? <img src={logo} alt={displayName(show)} className="mt-3.5 block max-h-[120px] max-w-[82%] object-contain object-left drop-shadow-[0_4px_16px_rgba(0,0,0,0.7)]" />
            : <p className="mt-3.5 text-[34px] font-extrabold leading-[1.05] tracking-[-0.03em]">{displayName(show)}</p>}
        </Rise>
        <Rise step={2}>
          <p className="mt-7 text-[clamp(84px,28cqw,110px)] font-black leading-[0.85] tracking-[-0.06em] tabular-nums">{episodes.toLocaleString()}</p>
          <p className="mt-2 text-lg text-[#c4c8ce]">{seasons > 1 ? `${unit}. ${seasons} seasons deep.` : seasons === 1 ? `${unit}, all in one season.` : `${unit}.`}</p>
        </Rise>
        {progress && (
          <Rise step={3}>
            <div className="mt-[22px] h-1.5 overflow-hidden rounded-full bg-white/[0.12]">
              <div className="h-full rounded-full bg-[linear-gradient(90deg,#2563eb,#60a5fa)] motion-safe:animate-in motion-safe:slide-in-from-left-full motion-safe:duration-1000" style={{ width: `${Math.max(2, share)}%` }} />
            </div>
            <p className="mt-2.5 text-[13px] text-[#a3a8b0]">{left === 0 ? `All ${plural(progress.aired, "episode")}. Fully caught up.` : `${share}% of the show. ${plural(left, "episode")} left.`}</p>
          </Rise>
        )}
        <Rise step={4}><div className={`${GLASS} mt-[22px] rounded-[18px] px-4 py-3.5 text-sm leading-[1.45]`}>{aheadOfTheRest(show, model)}</div></Rise>
      </div>
    </>
  );
}

function Clock({ hours, peak }: { hours: number[]; peak: number }) {
  const most = Math.max(1, ...hours);
  const marks = [0, 6, 12, 18];
  return (
    <svg viewBox="0 0 300 300" className="h-full w-full overflow-visible" aria-hidden="true">
      {hours.map((plays, hour) => {
        const angle = (hour * 15 * Math.PI) / 180;
        const inner = 66;
        const outer = inner + 8 + (plays / most) * 66;
        const color = hour === peak ? "#fbbf24" : plays / most >= CLOCK_BARS_AT_HALF ? "#60a5fa" : "rgba(147,197,253,0.35)";
        return <line key={hour} x1={150 + inner * Math.sin(angle)} y1={150 - inner * Math.cos(angle)} x2={150 + outer * Math.sin(angle)} y2={150 - outer * Math.cos(angle)} stroke={color} strokeWidth={9} strokeLinecap="round" />;
      })}
      {marks.map((hour) => {
        const angle = (hour * 15 * Math.PI) / 180;
        return <text key={hour} x={150 + 158 * Math.sin(angle)} y={150 - 158 * Math.cos(angle) + 4} textAnchor="middle" fontSize={10} fill="#8f949c">{formatHour(hour)}</text>;
      })}
    </svg>
  );
}

export function RhythmSlide({ model }: StorySlideProps) {
  const time = useMemo(() => yearTime(model), [model]);
  const first = model.plays.find((play) => !play.catchUp);
  const peak = formatHour(time.peakHour);
  return (
    <>
      <div aria-hidden="true" className="absolute inset-0 z-[-1] bg-[radial-gradient(circle_at_50%_38%,#1e3a8a_0%,#0c0d0f_62%)]" />
      <div className="px-7 pt-[60px]">
        <Rise step={0}><span className={`${KICKER} text-blue-300`}>Your rhythm</span></Rise>
        <Rise step={1}><p className={`mt-2.5 ${HEADLINE}`}>You're a {peak} person.</p></Rise>
      </div>
      <Rise step={2} className="relative mx-auto mt-10 aspect-square w-[min(320px,74cqw,40cqh)]">
        <div role="img" aria-label={`Plays by hour of day, peaking at ${peak}`} className="h-full w-full"><Clock hours={time.hours} peak={time.peakHour} /></div>
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
          <p className="text-[clamp(28px,9cqw,38px)] font-black tracking-[-0.04em]">{peak}</p>
          <p className="mt-0.5 text-[11px] uppercase tracking-[0.12em] text-[#a3a8b0]">peak hour</p>
        </div>
      </Rise>
      <div className="absolute inset-x-7 bottom-10 grid grid-cols-2 gap-2.5">
        <Rise step={3} className={`${GLASS} rounded-[18px] p-3.5`}>
          <p className="text-[26px] font-extrabold">{WEEKDAY_NAMES[time.peakDay]}</p>
          <p className="mt-0.5 text-xs text-[#a3a8b0]">{time.afterDark ? "your busiest night" : "your busiest day"}</p>
        </Rise>
        <Rise step={4} className={`${GLASS} rounded-[18px] p-3.5`}>
          {time.streak.length > 1
            ? <><p className="text-[26px] font-extrabold">{plural(time.streak.length, "day")}</p><p className="mt-0.5 text-xs text-[#a3a8b0]">longest streak</p></>
            : <><p className="text-[26px] font-extrabold">{time.activeDays.toLocaleString()}</p><p className="mt-0.5 text-xs text-[#a3a8b0]">days with a play</p></>}
        </Rise>
        {first && (
          <Rise step={5} className={`${GLASS} col-span-2 rounded-[18px] p-3.5`}>
            <p className="text-sm leading-[1.45]">
              Your year started with <span className="font-bold">{displayName(first.title)}</span> at{" "}
              <span className="font-bold">{new Date(first.at).toLocaleTimeString(undefined, { timeZone: model.timeZone, hour: "numeric", minute: "2-digit" })} on {new Date(first.at).toLocaleDateString(undefined, { timeZone: model.timeZone, month: "long", day: "numeric" })}</span>.
            </p>
          </Rise>
        )}
      </div>
    </>
  );
}

export function AnimeSlide({ model }: StorySlideProps) {
  const { entries, studios, hours } = useMemo(() => {
    const ranked = rankedAnime(model);
    const byStudio = new Map<string, number>();
    for (const entry of ranked) for (const studio of entry.studios) byStudio.set(studio, (byStudio.get(studio) ?? 0) + entry.plays);
    return {
      entries: ranked,
      studios: [...byStudio].sort((a, b) => b[1] - a[1]).slice(0, 3),
      hours: hoursOf(ranked.reduce((sum, entry) => sum + entry.watchMs, 0)),
    };
  }, [model]);
  const fan = entries.filter((entry) => entry.image).slice(0, 5);
  const lead = entries[0];
  const order = [3, 1, 0, 2, 4].filter((i) => i < fan.length);
  return (
    <>
      <div aria-hidden="true" className="absolute inset-0 z-[-1] bg-[radial-gradient(circle_at_50%_40%,rgba(219,39,119,0.45)_0%,#0c0d0f_60%)]" />
      <div className="px-7 pt-[60px]">
        <Rise step={0}><span className={`${KICKER} text-pink-400`}>Your anime year</span></Rise>
        <Rise step={1}><p className={`mt-2.5 ${HEADLINE}`}>{plural(model.data.totals.anime.plays, "episode")} of anime.</p></Rise>
        <Rise step={1}><p className="mt-2 text-[15px] text-[#c4c8ce]">{plural(entries.length, "series", "series")}, {plural(hours, "hour")}.</p></Rise>
      </div>
      {fan.length > 0 && (
        <Rise step={2} className="relative mx-auto mt-8 h-[min(220px,27cqh)] w-full">
          {order.map((i) => {
            const offset = i === 0 ? 0 : (i % 2 ? -1 : 1) * Math.ceil(i / 2);
            return (
              <img
                key={fan[i].malId}
                src={fan[i].image!}
                alt={i === 0 ? fan[i].name : ""}
                className={`absolute left-1/2 top-0 aspect-[2/3] h-full rounded-xl object-cover ${POSTER_SHADOW}`}
                style={{ transform: `translateX(calc(-50% + ${offset * 34}%)) rotate(${offset * 6}deg) scale(${1 - Math.abs(offset) * 0.12})`, zIndex: 10 - i, filter: i === 0 ? undefined : "brightness(0.7)" }}
              />
            );
          })}
        </Rise>
      )}
      {lead && (
        <Rise step={3} className="mt-5 px-7 text-center">
          <p className="line-clamp-2 text-xl font-bold leading-tight">{lead.name}</p>
          <p className="mt-1 text-[13px] text-[#a3a8b0]">your most watched, {plural(lead.plays, "episode")}</p>
        </Rise>
      )}
      {studios.length > 0 && (
        <div className="absolute inset-x-7 bottom-10 flex flex-col gap-2.5">
          <Rise step={4}><p className="text-[11px] uppercase tracking-[0.14em] text-[#8f949c]">The studios behind it</p></Rise>
          {studios.map(([name, plays], i) => (
            <Rise key={name} step={5 + i} className={`${GLASS} flex items-center gap-3 rounded-2xl px-3.5 py-3`}>
              <span className="flex size-[34px] items-center justify-center rounded-[10px] bg-pink-400/20 text-xs font-extrabold text-pink-300">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{name}</span>
              <span className="text-[13px] text-[#a3a8b0]">{plural(plays, "episode")}</span>
            </Rise>
          ))}
        </div>
      )}
    </>
  );
}

export function FaceSlide({ model }: StorySlideProps) {
  const people = model.data.people!;
  const face = people.cast[0];
  const photo = artAt(face.photo, "h632", 632);
  const shown = face.shown.filter((title) => title.poster);
  const posters = face.titles <= 3 ? shown.slice(0, 3) : shown.slice(0, 2);
  const rest = face.titles - posters.length;
  const span = face.shown.length > 1 ? `, from ${face.shown[0].name} to ${face.shown[face.shown.length - 1].name}` : face.shown.length ? `: ${face.shown[0].name}` : "";
  const also = people.cast.slice(1, 6);
  const tilt = (i: number, count: number) => (count === 1 ? "" : i === 0 ? "rotate(-6deg)" : i === count - 1 ? "rotate(6deg)" : "translateY(-6px)");
  return (
    <>
      {photo && <img src={photo} alt="" aria-hidden="true" className="absolute -inset-10 z-[-1] h-[60%] w-[calc(100%+80px)] object-cover opacity-55 blur-[40px] saturate-[1.4]" />}
      <div className="px-7 pt-[60px]">
        <Rise step={0}><span className={`${KICKER} text-amber-400`}>The face of your year</span></Rise>
      </div>
      <Rise step={1} className="mt-7 flex justify-center">
        <div className="relative">
          {photo
            ? <img src={photo} alt="" className="block size-[min(200px,24cqh)] rounded-full object-cover shadow-[0_0_0_6px_rgba(251,191,36,0.9),0_30px_60px_-20px_rgba(0,0,0,0.9)]" />
            : <div className="size-[min(200px,24cqh)] rounded-full bg-gradient-to-br from-zinc-600 to-zinc-800 shadow-[0_0_0_6px_rgba(251,191,36,0.9)]" />}
          <span className="absolute bottom-1.5 right-1 flex size-14 items-center justify-center rounded-full bg-amber-400 text-[26px] font-black text-[#0c0d0f] shadow-[0_0_0_5px_#0c0d0f]">{face.titles}</span>
        </div>
      </Rise>
      <Rise step={2} className="px-7 pt-[26px] text-center">
        <p className="text-[clamp(28px,9cqw,36px)] font-extrabold tracking-[-0.03em]">{face.name}</p>
        <p className="mt-2 text-[15px] leading-[1.45] text-[#c4c8ce]">{face.voiced ? `voiced ${face.titles} of your shows` : `showed up in ${face.titles} of your titles`}{span}.</p>
      </Rise>
      {posters.length > 0 && (
        <Rise step={3} className="mt-[22px] flex justify-center gap-2">
          {posters.map((title, i) => <img key={title.key} src={artAt(title.poster, "w185", 185)!} alt={title.name} className="aspect-[2/3] w-[70px] rounded-[10px] object-cover" style={{ transform: tilt(i, posters.length + (rest > 0 ? 1 : 0)) }} />)}
          {rest > 0 && <span className="flex aspect-[2/3] w-[70px] items-center justify-center rounded-[10px] bg-white/[0.08] text-[15px] font-bold text-[#c4c8ce]" style={{ transform: "rotate(6deg)" }}>+{rest}</span>}
        </Rise>
      )}
      {also.length > 0 && (
        <Rise step={4} className="absolute inset-x-7 bottom-10">
          <p className="mb-2.5 text-[11px] uppercase tracking-[0.14em] text-[#8f949c]">Also in your year</p>
          <div className="flex justify-between">
            {also.map((person) => (
              <div key={person.id} className="flex w-[60px] flex-col items-center gap-1.5">
                {person.photo
                  ? <img src={artAt(person.photo, "w185", 185)!} alt="" className="size-[52px] rounded-full object-cover shadow-[0_0_0_2px_rgba(255,255,255,0.15)]" />
                  : <div className="size-[52px] rounded-full bg-gradient-to-br from-zinc-600 to-zinc-800" />}
                <span className="line-clamp-2 text-center text-[10px] leading-[1.2] text-[#c4c8ce]">{person.name}</span>
              </div>
            ))}
          </div>
        </Rise>
      )}
    </>
  );
}

const TIMELINE = 6;

/** Up to six titles spread from the oldest to the newest release. */
function timelineOf(titles: JellyfinYearTitle[]): JellyfinYearTitle[] {
  const dated = titles.filter((title) => title.facts?.year && title.facts.poster).sort((a, b) => a.facts!.year! - b.facts!.year! || b.watchMs - a.watchMs);
  if (dated.length <= TIMELINE) return dated;
  const picked = new Set<JellyfinYearTitle>();
  for (let i = 0; i < TIMELINE; i += 1) picked.add(dated[Math.round((i * (dated.length - 1)) / (TIMELINE - 1))]);
  return [...picked];
}

export function MapSlide({ model }: StorySlideProps) {
  const { timeline, span, films, places, countries, languages } = useMemo(() => {
    const titles = model.data.titles;
    const filmTitles = titles.filter((title) => title.kind === "movie" && title.facts?.year);
    const pool = filmTitles.length >= 2 ? filmTitles : titles;
    const years = pool.map((title) => title.facts?.year).filter((year): year is number => !!year);
    const { ranked, languages } = yearPlaces(titles);
    return { timeline: timelineOf(pool), span: years.length ? Math.max(...years) - Math.min(...years) : 0, films: pool === filmTitles, places: ranked.slice(0, 3), countries: ranked.length, languages };
  }, [model]);
  const headline = span > 0
    ? `${plural(span, "year")} of ${films ? "film" : "TV"}${languages > 1 ? `, ${languages} languages` : ""}.`
    : countries > 1 ? `Titles from ${plural(countries, "country", "countries")}.` : "Where your year came from.";
  return (
    <>
      <div className="px-7 pt-[60px]">
        <Rise step={0}><span className={`${KICKER} text-blue-300`}>Your map</span></Rise>
        <Rise step={1}><p className={`mt-2.5 ${HEADLINE}`}>{headline}</p></Rise>
      </div>
      {timeline.length > 0 && (
        <>
          <div className="relative mx-7 mt-[30px] aspect-[10/7] max-h-[34cqh]">
            {timeline.map((title, i) => (
              <Rise key={title.key} step={2 + i} className="absolute bottom-0" style={{ left: `${(i / Math.max(1, timeline.length - 1)) * 64}%`, width: `${26 + i * 2}%`, zIndex: i + 1, bottom: i % 2 ? "13%" : 0 }}>
                <div style={{ transform: `rotate(${i % 2 ? 4 : -4}deg)` }}>
                  <img src={artAt(title.facts?.poster, "w185", 185)!} alt={`${displayName(title)}, ${title.facts?.year}`} className={`block aspect-[2/3] w-full rounded-[10px] object-cover ${POSTER_SHADOW}`} />
                </div>
              </Rise>
            ))}
          </div>
          <div className="mx-7 mt-[18px] h-0.5 bg-[linear-gradient(90deg,rgba(255,255,255,0.1),#60a5fa)]" />
          {timeline.length > 1 && (
            <div className="mx-7 mt-2 flex justify-between text-[11px] font-bold tabular-nums text-[#c4c8ce]">
              <span>{timeline[0].facts?.year}</span>
              <span>{timeline[timeline.length - 1].facts?.year}</span>
            </div>
          )}
        </>
      )}
      {places.length > 0 && (
        <div className="absolute inset-x-7 bottom-10 flex flex-col gap-2.5">
          {places.map(([code, n], i) => (
            <Rise key={code} step={4 + i} className={`${GLASS} flex items-center gap-3 rounded-2xl px-3.5 py-3`}>
              <span className="flex size-[34px] items-center justify-center rounded-[10px] bg-blue-400/[0.18] text-xs font-extrabold text-blue-300">{code}</span>
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{regionName(code)}</span>
              <span className="text-[13px] text-[#a3a8b0]">{plural(n, "title")}</span>
            </Rise>
          ))}
        </div>
      )}
    </>
  );
}

export function OutroSlide({ model, owner, onShare, onReplay }: StorySlideProps) {
  const days = useMemo(() => new Set(model.plays.map((play) => play.day)).size, [model]);
  const lead = byWatchTime(model)[0];
  return (
    <>
      <Wall model={model} className="opacity-25 blur-[2px]" />
      <div aria-hidden="true" className="absolute inset-0 z-[-1] bg-[radial-gradient(ellipse_at_50%_45%,rgba(12,13,15,0.55),#0c0d0f_75%)]" />
      <div className="absolute inset-x-7 top-1/2 -translate-y-1/2 text-center">
        <Rise step={0}><span className="text-xs uppercase tracking-[0.18em] text-[#c4c8ce]">{owner} · {model.year}</span></Rise>
        <Rise step={1}><p className="mt-4 text-[clamp(40px,12cqw,52px)] font-black leading-[0.95] tracking-[-0.045em]">{model.partial ? "That's your year so far." : "That was your year."}</p></Rise>
        <Rise step={2}>
          <p className="mt-4 text-[15px] leading-[1.5] text-[#c4c8ce]">
            {plural(model.data.totals.plays, "play")} across {plural(days, "day")}{lead ? <>, with <span className="font-semibold text-foreground">{displayName(lead)}</span> on top</> : null}.
          </p>
        </Rise>
        <Rise step={3} className="mt-9 flex flex-col items-center gap-3">
          <button type="button" onClick={onShare} className="inline-flex h-12 items-center gap-2 rounded-full bg-[#f1f2f4] px-6 text-[15px] font-semibold text-[#0c0d0f] transition-opacity hover:opacity-90">
            <Download className="size-4" /> Make a share card
          </button>
          <button type="button" onClick={onReplay} className={`${GLASS} inline-flex h-12 items-center gap-2 rounded-full px-6 text-[15px] font-semibold transition-colors hover:bg-white/[0.12]`}>
            <RotateCcw className="size-4" /> Watch again
          </button>
        </Rise>
      </div>
    </>
  );
}
