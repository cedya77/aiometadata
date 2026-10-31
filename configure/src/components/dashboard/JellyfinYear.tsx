import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useJellyfinYear, type DashboardTab, type JellyfinYearReview } from "@/hooks/useDashboardQueries";
import { sizedArt } from "./art";
import { DashboardLinks } from "./DashboardLink";
import { ACCENT_BADGE, YEAR_GLASS } from "./JellyfinYearShared";
import { YEAR_CHAPTERS } from "./yearChapters";
import { buildYearModel, capitalised, formatDay, hoursOf, inWords, type YearModel } from "./yearModel";
import { when } from "./jellyfinUtils";

const WALL_SIZE = 48;

function posters(model: YearModel): string[] {
  const out: string[] = [];
  for (const title of [...model.data.titles].sort((a, b) => b.watchMs - a.watchMs)) {
    const poster = title.facts?.poster;
    if (poster) out.push(sizedArt(poster, 342) ?? poster);
    if (out.length === WALL_SIZE) break;
  }
  while (out.length && out.length < WALL_SIZE) out.push(...out.slice(0, WALL_SIZE - out.length));
  return out;
}

function YearPicker({ years, year, onYear }: { years: number[]; year: number; onYear: (year: number) => void }) {
  const list = years.includes(year) ? years : [year, ...years];
  return (
    <div className={`${YEAR_GLASS} flex max-w-full overflow-x-auto rounded-full p-[3px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}>
      {list.map((y) => (
        <button key={y} type="button" onClick={() => onYear(y)} aria-pressed={y === year} className={`h-[34px] shrink-0 rounded-full px-4 text-sm tabular-nums transition ${y === year ? "bg-white/[0.16] font-semibold text-foreground" : "font-medium text-muted-foreground hover:text-foreground"}`}>{y}</button>
      ))}
    </div>
  );
}

const bulkNote = (plays: number) => `${plays.toLocaleString()} more ${plays === 1 ? "play was" : "plays were"} marked in bulk, so ${plays === 1 ? "it is" : "they are"} left out.`;

function Hero({ model, profileName, picker }: { model: YearModel; profileName: string; picker: ReactNode }) {
  const wall = useMemo(() => posters(model), [model]);
  const { totals } = model.data;
  const activeDays = useMemo(() => new Set(model.plays.map((play) => play.day)).size, [model]);
  const stats = [
    { value: hoursOf(totals.watchMs).toLocaleString(), label: "Hours watched" },
    { value: totals.plays.toLocaleString(), label: "Plays" },
    { value: totals.films.titles.toLocaleString(), label: "Films" },
    { value: totals.shows.plays.toLocaleString(), label: "Episodes" },
    { value: model.data.titles.length.toLocaleString(), label: "Titles" },
    { value: activeDays.toLocaleString(), label: "Days with a play" },
  ];
  const titles = model.data.titles.length;
  const ranked = useMemo(() => [...model.data.titles].sort((a, b) => b.watchMs - a.watchMs), [model]);
  const backdrop = ranked.find((title) => title.facts?.background)?.facts?.background ?? null;
  const topShow = ranked.find((title) => title.kind === "series");
  const gripped = !!topShow && totals.watchMs > 0 && topShow.watchMs / totals.watchMs >= 0.25;
  const months = model.partial ? new Date(Date.UTC(model.year, 0, 1 + model.through)).getUTCMonth() + 1 : 12;
  const span = months === 12 ? "A full year" : `${capitalised(inWords(months))} month${months === 1 ? "" : "s"}`;
  const yearFill = backdrop
    ? { backgroundImage: `linear-gradient(180deg, rgba(255,255,255,0.35), rgba(255,255,255,0) 70%), url("${sizedArt(backdrop, 1280) ?? backdrop}")`, backgroundSize: "cover", backgroundPosition: "center 30%" }
    : { backgroundImage: "linear-gradient(180deg, #ffffff, rgba(255,255,255,0.4))" };
  return (
    <section className="relative isolate overflow-hidden [clip-path:inset(0)]">
      {wall.length > 0 && (
        <div aria-hidden="true" className="pointer-events-none absolute -inset-x-[300px] -inset-y-[200px] grid grid-cols-8 gap-3.5 opacity-[0.42] sm:grid-cols-12" style={{ transform: "perspective(1400px) rotateX(32deg) rotateZ(-12deg) scale(1.15)" }}>
          {wall.map((src, i) => <img key={i} src={src} alt="" loading="lazy" className="block aspect-[2/3] w-full rounded-[10px] object-cover" />)}
        </div>
      )}
      <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_30%_55%,hsl(var(--background)/0.55),hsl(var(--background))_85%)]" />
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-background from-[4%] to-transparent to-45%" />
      <div className="relative flex min-h-[620px] flex-col px-4 pt-10 sm:min-h-[760px] sm:px-6 sm:pt-16 lg:px-12">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{profileName}'s year in review</span>
          {picker}
        </div>
        <h1 className="-ml-1 mt-7 w-fit bg-clip-text text-[112px] font-black leading-[0.82] tracking-[-0.065em] text-transparent sm:-ml-2.5 sm:text-[200px] lg:text-[248px]" style={yearFill}>{model.year}</h1>
        <p className="mt-[18px] max-w-[640px] text-lg leading-[1.4] text-foreground/85 sm:text-[22px]">
          {span}, {titles.toLocaleString()} title{titles === 1 ? "" : "s"}{gripped ? ", one show you could not put down." : "."}{" "}
          {model.partial && <span className="block text-muted-foreground">{formatDay(model.year, 0, false, "long")} to {formatDay(model.year, model.through, false, "long")}, still counting.</span>}
        </p>
        {!!totals.bulk?.plays && <p className="mt-3 max-w-[640px] text-sm text-muted-foreground">{bulkNote(totals.bulk.plays)}</p>}
        <div className="mt-auto grid grid-cols-2 gap-6 pb-10 pt-10 sm:grid-cols-3 lg:grid-cols-6">
          {stats.map((s) => (
            <div key={s.label} className="min-w-0">
              <p className="text-3xl font-bold leading-none tracking-[-0.03em] tabular-nums sm:text-[40px]">{s.value}</p>
              <p className="mt-2 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ChapterNav({ chapters }: { chapters: typeof YEAR_CHAPTERS }) {
  return (
    <div className="px-4 sm:px-6 lg:px-12">
      <nav aria-label="Chapters" className="flex flex-wrap gap-2 border-y border-white/[0.07] py-[18px]">
        {chapters.map((chapter, i) => (
          <a key={chapter.key} href={`#year-${chapter.key}`} onClick={(event) => { event.preventDefault(); document.getElementById(`year-${chapter.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }} className={`${YEAR_GLASS} flex h-10 items-center gap-2.5 rounded-full pl-1.5 pr-4 text-sm font-medium text-foreground/85 transition hover:text-foreground`}>
            <span className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold ${i === 0 ? ACCENT_BADGE[chapter.accent] : chapter.accent === "blue" ? "bg-white/10" : ACCENT_BADGE[chapter.accent]}`}>{String(i + 1).padStart(2, "0")}</span>
            {chapter.label}
          </a>
        ))}
      </nav>
    </div>
  );
}

function BuildState({ review, year }: { review: JellyfinYearReview | undefined; year: number }) {
  const status = review?.status;
  const failed = status === "failed";
  const text = status === "busy"
    ? "The server is busy building other reviews. This one will start as soon as there is room."
    : failed
      ? `Building ${year} failed. It will be tried again${review?.retryAt ? ` at ${new Date(review.retryAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : " soon"}.`
      : status === "queued"
      ? `Waiting to be built${review?.ahead ? `, ${review.ahead} ahead` : ""}.`
      : `Putting ${year} together from every play.`;
  return (
    <section className="flex min-h-[420px] flex-col items-start justify-center gap-4 px-4 sm:px-6">
      <p className="text-[112px] font-black leading-[0.82] tracking-[-0.065em] text-white/10 sm:text-[200px]">{year}</p>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">{!failed && <Loader2 className="h-4 w-4 animate-spin" />} {text}</p>
    </section>
  );
}

function Freshness({ review }: { review: JellyfinYearReview }) {
  if (!review.stale) return null;
  return (
    <div className="px-4 pt-4 sm:px-6 lg:px-12">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {review.rebuilding && review.rebuilding !== "busy" && review.rebuilding !== "failed"
          ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Adding your newest plays.</>
          : <>Built {review.builtAt ? when(review.builtAt) : "earlier"}. Newer plays show up on the next update.</>}
      </p>
    </div>
  );
}

export default function JellyfinYear({ userUUID, profile, profileName, activeTab }: { userUUID: string; profile: string | null; profileName: string; activeTab: DashboardTab }) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const { data: review, isLoading, isError } = useJellyfinYear(userUUID, profile, year, { activeTab });
  const current = review && review.year === year ? review : undefined;
  useEffect(() => {
    if (current?.years.length && !current.years.includes(year) && !current.data?.totals.plays) setYear(current.years[0]);
  }, [current, year]);
  const model = useMemo(() => (current?.data ? buildYearModel(current.data, current.ratings) : null), [current?.data, current?.ratings]);
  const chapters = useMemo(() => (model ? YEAR_CHAPTERS.filter((chapter) => !chapter.shows || chapter.shows(model)) : []), [model]);
  const picker = <YearPicker years={review?.years ?? []} year={year} onYear={setYear} />;

  if (isError) return <p className="px-4 py-3 text-xs text-red-500">Could not load the year in review.</p>;
  if (isLoading && !review) return <div className="space-y-4 px-4 py-10 sm:px-6"><Skeleton className="h-40 w-2/3 rounded-3xl" /><Skeleton className="h-10 w-1/2 rounded-full" /></div>;
  if (!current?.data || !model) {
    return (
      <div>
        <div className="flex justify-end px-4 pt-6 sm:px-6">{picker}</div>
        <BuildState review={current} year={year} />
      </div>
    );
  }
  if (!model.plays.length) {
    return (
      <div>
        <div className="flex justify-end px-4 pt-6 sm:px-6">{picker}</div>
        <section className="px-4 py-24 sm:px-6">
          <p className="text-[112px] font-black leading-[0.82] tracking-[-0.065em] text-white/10 sm:text-[200px]">{year}</p>
          <p className="mt-4 text-sm text-muted-foreground">Nothing played in {year} yet.{current.data.totals.bulk?.plays ? ` ${bulkNote(current.data.totals.bulk.plays)}` : ""}</p>
        </section>
      </div>
    );
  }
  return (
    <DashboardLinks>
      <div className="pb-24">
        <Hero model={model} profileName={profileName} picker={picker} />
        <ChapterNav chapters={chapters} />
        <Freshness review={current} />
        {chapters.map((chapter, i) => (
          <section key={chapter.key} id={`year-${chapter.key}`} className="scroll-mt-28 px-4 pb-10 pt-16 sm:px-6 sm:pt-[88px] lg:px-12">
            <chapter.Chapter model={model} number={i + 1} label={chapter.label} accent={chapter.accent} />
          </section>
        ))}
      </div>
    </DashboardLinks>
  );
}
