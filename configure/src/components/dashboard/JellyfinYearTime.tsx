import { useMemo, type CSSProperties } from "react";
import { ChapterHeader, Deck, HATCH, Panel, Swatch, TitleLink, type YearAccent } from "./JellyfinYearShared";
import { sizedArt } from "./art";
import { MONTH_NAMES, WEEKDAY_NAMES, WEEKDAY_SHORT, capitalised, displayName, episodeLabel, formatDay, formatHour, formatPlayTime, hoursOf, inWords, type YearModel, type YearPlay } from "./yearModel";

interface Week {
  start: number;
  episodes: number;
  films: number;
  catchUp: number;
}

function timeOf(model: YearModel) {
  const lastWeek = Math.floor(model.through / 7);
  const weeks: Week[] = Array.from({ length: lastWeek + 1 }, (_, i) => ({ start: i * 7, episodes: 0, films: 0, catchUp: 0 }));
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  const months = new Array<number>(12).fill(0);
  const catchUpDays = new Array<Set<number>>(12).fill(null as never).map(() => new Set<number>());
  const catchUpPlays = new Array<number>(12).fill(0);
  const catchUpFilms = new Array<number>(12).fill(0);
  const days = new Map<number, number>();
  let rhythm = 0;
  for (const play of model.plays) {
    const week = weeks[Math.min(lastWeek, Math.floor(play.day / 7))];
    if (play.catchUp) week.catchUp += 1;
    else if (play.film) week.films += 1;
    else week.episodes += 1;
    months[play.month] += 1;
    days.set(play.day, (days.get(play.day) ?? 0) + 1);
    if (play.catchUp) {
      catchUpDays[play.month].add(play.day);
      catchUpPlays[play.month] += 1;
      if (play.film) catchUpFilms[play.month] += 1;
      continue;
    }
    rhythm += 1;
    hours[play.hour] += 1;
    weekdays[play.weekday] += 1;
  }
  const sorted = [...days.keys()].sort((a, b) => a - b);
  let streak = { length: 0, from: 0, to: 0 };
  let runFrom = sorted[0] ?? 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i] !== sorted[i - 1] + 1) runFrom = sorted[i];
    const length = sorted[i] - runFrom + 1;
    if (length > streak.length) streak = { length, from: runFrom, to: sorted[i] };
  }
  const peak = (list: number[]) => list.reduce((best, n, i) => (n > list[best] ? i : best), 0);
  const busiestMonth = peak(months);
  const afterDark = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3].reduce((sum, h) => sum + hours[h], 0);
  return {
    weeks,
    hours,
    weekdays,
    rhythm,
    streak,
    activeDays: days.size,
    peakHour: peak(hours),
    peakDay: peak(weekdays),
    busiestMonth,
    busiestPlays: months[busiestMonth],
    busiestCatchUpDays: catchUpDays[busiestMonth].size,
    busiestCatchUpPlays: catchUpPlays[busiestMonth],
    busiestCatchUpEpisodesOnly: catchUpFilms[busiestMonth] === 0,
    playsOnDay: days,
    afterMidnight: hours[0] + hours[1] + hours[2] + hours[3],
    afterDark: rhythm > 0 && afterDark / rhythm > 0.5,
  };
}

type Time = ReturnType<typeof timeOf>;

function playName(play: YearPlay): string {
  const name = displayName(play.title);
  const episode = play.film ? null : episodeLabel(play.videoId);
  return episode ? `${name} ${episode}` : name;
}

const WEEK_CHART_PX = 190;

function WeekChart({ model, time }: { model: YearModel; time: Time }) {
  const top = Math.max(1, ...time.weeks.map((w) => w.episodes + w.films));
  const monthStarts = MONTH_NAMES.map((name, month) => ({ name, day: Math.round((Date.UTC(model.year, month, 1) - Date.UTC(model.year, 0, 1)) / 86_400_000) })).filter((m) => m.day <= model.through);
  const px = (n: number) => Math.round((n / top) * WEEK_CHART_PX);
  return (
    <Panel
      title="Every week of the year"
      aside={
        <div className="flex flex-wrap gap-[18px] text-xs text-muted-foreground">
          <Swatch className="bg-blue-400" label="Episodes" />
          <Swatch className="bg-amber-400" label="Films" />
          <Swatch style={HATCH} label="Catch-up marks" />
        </div>
      }
    >
      <div className="mt-6 flex items-end gap-px sm:gap-1" style={{ height: WEEK_CHART_PX }}>
        {time.weeks.map((week) => {
          const films = px(week.films);
          const episodes = px(week.episodes);
          const catchUp = Math.min(WEEK_CHART_PX - films - episodes, px(week.catchUp));
          const label = `Week of ${formatDay(model.year, week.start)}: ${week.episodes} episode${week.episodes === 1 ? "" : "s"}, ${week.films} film${week.films === 1 ? "" : "s"}, ${week.catchUp} catch-up mark${week.catchUp === 1 ? "" : "s"}`;
          return (
            <div key={week.start} title={label} className="flex h-full min-w-0 flex-1 flex-col-reverse transition-opacity hover:opacity-80">
              {films > 0 && <div className="rounded-b-[3px] bg-amber-400" style={{ height: films }} />}
              {episodes > 0 && <div className={`bg-blue-400 ${catchUp > 0 ? "" : "rounded-t-[3px]"}`} style={{ height: episodes }} />}
              {catchUp > 0 && <div className="rounded-t-[3px]" style={{ ...HATCH, height: catchUp }} />}
            </div>
          );
        })}
      </div>
      <div className="relative mt-2.5 h-4 text-[10px] uppercase tracking-[0.06em] text-muted-foreground sm:text-[11px]">
        {monthStarts.map((m) => <span key={m.name} className="absolute" style={{ left: `${(Math.floor(m.day / 7) / time.weeks.length) * 100}%` }}>{m.name.slice(0, 3)}</span>)}
      </div>
    </Panel>
  );
}

function Clock({ time }: { time: Time }) {
  const top = Math.max(1, ...time.hours);
  const size = 250;
  const center = size / 2;
  const inner = 60;
  const reach = 60;
  return (
    <Panel title="Your clock" padding="p-6" className="flex flex-col">
      <div className="relative mx-auto mt-3" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`Plays by hour of day, peaking at ${formatHour(time.peakHour)}`}>
          {time.hours.map((n, hour) => {
            const angle = (hour / 24) * Math.PI * 2 - Math.PI / 2;
            const length = 8 + (n / top) * (reach - 8);
            const x1 = center + Math.cos(angle) * inner;
            const y1 = center + Math.sin(angle) * inner;
            const x2 = center + Math.cos(angle) * (inner + length);
            const y2 = center + Math.sin(angle) * (inner + length);
            return (
              <g key={hour}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={7} strokeLinecap="round" className={hour === time.peakHour ? "stroke-amber-400" : hour >= 18 || hour === 0 ? "stroke-blue-400" : "stroke-blue-300/40"} />
                <line x1={x1} y1={y1} x2={center + Math.cos(angle) * (inner + reach + 4)} y2={center + Math.sin(angle) * (inner + reach + 4)} stroke="transparent" strokeWidth={14}>
                  <title>{`${formatHour(hour)}: ${n} play${n === 1 ? "" : "s"}`}</title>
                </line>
              </g>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-[30px] font-extrabold tracking-[-0.03em]">{formatHour(time.peakHour)}</p>
          <p className="mt-0.5 text-[11px] uppercase tracking-[0.1em] text-muted-foreground">peak hour</p>
        </div>
        <span className="absolute -top-1 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground">{formatHour(0)}</span>
        <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground">{formatHour(12)}</span>
        <span className="absolute -right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">{formatHour(6)}</span>
        <span className="absolute -left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">{formatHour(18)}</span>
      </div>
      {time.afterMidnight > 0 && <p className="mt-[18px] text-center text-[13px] text-muted-foreground">{time.afterMidnight.toLocaleString()} play{time.afterMidnight === 1 ? "" : "s"} started after midnight.</p>}
    </Panel>
  );
}

function WeekRhythm({ time }: { time: Time }) {
  const top = Math.max(1, ...time.weekdays);
  const ranked = time.weekdays.map((n, day) => ({ n, day })).sort((a, b) => b.n - a.n);
  const note = ranked[1].n >= ranked[0].n * 0.9 ? `${WEEKDAY_NAMES[ranked[0].day]} leads, ${WEEKDAY_NAMES[ranked[1].day]} close behind.` : `${WEEKDAY_NAMES[ranked[0].day]} leads.`;
  return (
    <Panel title="Your week" padding="p-6" className="flex flex-col">
      <div className="mt-[18px] flex min-h-[210px] flex-1 gap-2.5">
        {time.weekdays.map((n, day) => {
          const peak = day === time.peakDay;
          return (
            <div key={day} title={`${WEEKDAY_NAMES[day]}: ${n} play${n === 1 ? "" : "s"}`} className="flex h-full flex-1 flex-col items-center gap-2">
              <div className="relative w-full flex-1 pt-6">
                <div className={`absolute inset-x-0 bottom-0 h-[var(--fill)] rounded-[10px] lg:h-[var(--fixed)] ${peak ? "bg-gradient-to-b from-blue-300 to-blue-600" : "bg-white/[0.12]"}`} style={{ "--fill": `calc(${(n / top) * 100}% - ${(n / top) * 24}px)`, "--fixed": `${Math.round((n / top) * 150)}px`, minHeight: 4 } as CSSProperties}>
                  <span className={`absolute inset-x-0 -top-5 text-center text-[11px] tabular-nums ${peak ? "text-foreground" : "text-muted-foreground"}`}>{n.toLocaleString()}</span>
                </div>
              </div>
              <span className={`text-xs ${peak ? "font-bold text-foreground" : "font-medium text-muted-foreground"}`}>{WEEKDAY_SHORT[day]}</span>
            </div>
          );
        })}
      </div>
      <p className="mt-[18px] text-[13px] text-muted-foreground">{note}</p>
    </Panel>
  );
}

const STREAK_SQUARES = 90;

function Thumb({ play }: { play: YearPlay }) {
  const poster = play.title.facts?.poster;
  return poster
    ? <img src={sizedArt(poster, 92) ?? poster} alt="" loading="lazy" className="aspect-[2/3] w-7 shrink-0 rounded object-cover" />
    : <span className="aspect-[2/3] w-7 shrink-0 rounded bg-gradient-to-br from-zinc-700 to-zinc-900" />;
}

function Streak({ model, time }: { model: YearModel; time: Time }) {
  const first = model.plays[0];
  const last = model.plays[model.plays.length - 1];
  const { length, from } = time.streak;
  const squares = length > 1 && length <= STREAK_SQUARES ? Array.from({ length }, (_, i) => time.playsOnDay.get(from + i) ?? 0) : [];
  const busiest = Math.max(1, ...squares);
  return (
    <Panel title="Longest streak" padding="p-6" className="flex flex-col">
      <p className="mt-[18px] text-7xl font-black leading-[0.9] tracking-[-0.05em] tabular-nums sm:text-[88px]">{length}<span className="text-[22px] font-semibold tracking-normal text-muted-foreground"> day{length === 1 ? "" : "s"}</span></p>
      <p className="mt-2 text-sm text-foreground/80">
        {length > 1 ? `${formatDay(model.year, time.streak.from)} to ${formatDay(model.year, time.streak.to)}, without missing a day.` : "No two days in a row yet."}
      </p>
      {squares.length > 0 && (
        <div className={`mt-[18px] grid gap-[5px] ${squares.length > 40 ? "grid-cols-[repeat(15,minmax(0,1fr))]" : "grid-cols-10"}`}>
          {squares.map((n, i) => <span key={i} title={`${formatDay(model.year, from + i)}: ${n} play${n === 1 ? "" : "s"}`} className="aspect-square rounded bg-blue-400" style={{ opacity: 0.35 + 0.65 * (n / busiest) }} />)}
        </div>
      )}
      <div className="mt-auto flex flex-col gap-2.5 pt-[18px] text-[13px]">
        <TitleLink title={first.title} name={displayName(first.title)} className="group flex items-center gap-2.5"><Thumb play={first} /><span className="text-foreground/80"><span className="text-muted-foreground">First play, {formatPlayTime(first.at, model.timeZone)}:</span> <span className="decoration-white/35 underline-offset-4 group-hover:underline">{playName(first)}</span></span></TitleLink>
        <TitleLink title={last.title} name={displayName(last.title)} className="group flex items-center gap-2.5"><Thumb play={last} /><span className="text-foreground/80"><span className="text-muted-foreground">Latest, {formatPlayTime(last.at, model.timeZone)}:</span> <span className="decoration-white/35 underline-offset-4 group-hover:underline">{playName(last)}</span></span></TitleLink>
      </div>
    </Panel>
  );
}

export default function TimeChapter({ model, number, label, accent }: { model: YearModel; number: number; label: string; accent: YearAccent }) {
  const time = useMemo(() => timeOf(model), [model]);
  const hours = hoursOf(model.data.totals.watchMs);
  const lead = [
    time.afterDark ? "Mostly after dark." : null,
    time.rhythm > 0 ? `${formatHour(time.peakHour)} is your hour and ${WEEKDAY_NAMES[time.peakDay]} is your ${time.peakHour >= 18 || time.peakHour < 4 ? "night" : "day"}.` : null,
    time.busiestCatchUpDays
      ? `${MONTH_NAMES[time.busiestMonth]} was the big one: ${inWords(time.busiestCatchUpDays)} catch-up day${time.busiestCatchUpDays === 1 ? "" : "s"} put ${time.busiestCatchUpPlays.toLocaleString()} ${time.busiestCatchUpEpisodesOnly ? "episodes" : "plays"} on the board.`
      : `${MONTH_NAMES[time.busiestMonth]} was the big one, with ${time.busiestPlays.toLocaleString()} plays.`,
  ].filter(Boolean).join(" ");
  return (
    <>
      <ChapterHeader
        number={number}
        label={label}
        accent={accent}
        title={`${hours.toLocaleString()} hour${hours === 1 ? "" : "s"}.`}
        sub={hours >= 48 ? `${capitalised(inWords(Math.round(hours / 24)))} days of screen.` : `${model.plays.length.toLocaleString()} play${model.plays.length === 1 ? "" : "s"}.`}
      >
        {lead}
      </ChapterHeader>
      <div className="mt-10 space-y-5">
        <WeekChart model={model} time={time} />
        {time.rhythm > 0
          ? <Deck><Clock time={time} /><WeekRhythm time={time} /><Streak model={model} time={time} /></Deck>
          : <div className="grid gap-5 lg:grid-cols-3"><Streak model={model} time={time} /><p className="self-center text-sm text-muted-foreground lg:col-span-2">Every play this year arrived as a catch-up mark, so there is no clock or week to read yet.</p></div>}
      </div>
    </>
  );
}
