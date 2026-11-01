import { useMemo, useState } from "react";
import type { JellyfinYearTitle } from "@/hooks/useDashboardQueries";
import { ChapterHeader, Panel, TitleList, YEAR_GLASS, plural } from "./JellyfinYearShared";
import type { YearChapterProps } from "./yearChapters";
import { displayName, tasteStats, type YearModel } from "./yearModel";

const SCORES = 10;
const BAR_MAX = 130;


function rated(model: YearModel): Array<{ title: JellyfinYearTitle; score: number }> {
  return model.data.titles.flatMap((title) => (typeof model.ratings[title.key] === "number" ? [{ title, score: Math.min(SCORES, Math.max(1, Math.round(model.ratings[title.key]))) }] : []));
}

function sublineOf(scores: number[]): string | undefined {
  if (scores.length < 2) return scores.length ? `A ${scores[0]}.` : undefined;
  const low = Math.min(...scores);
  if (scores.every((score) => score === low)) return `Every one a ${low}.`;
  return low >= 5 ? `Never below a ${low}.` : `As low as a ${low}.`;
}

function Ratings({ entries }: { entries: Array<{ title: JellyfinYearTitle; score: number }> }) {
  const [picked, setPicked] = useState<number | null>(null);
  const counts = Array.from({ length: SCORES }, (_, i) => entries.filter((entry) => entry.score === i + 1).length);
  const most = Math.max(1, ...counts);
  const top = Math.max(...entries.map((entry) => entry.score));
  const average = entries.reduce((sum, entry) => sum + entry.score, 0) / entries.length;
  const chosen = picked === null ? [] : entries.filter((entry) => entry.score === picked).map((entry) => entry.title);
  return (
    <Panel title="Your ratings" className="min-w-0 flex-[2_1_520px]" aside={<span className="text-[13px] text-muted-foreground">average <span className="font-bold text-amber-300">{average.toFixed(1)}</span></span>}>
      <p className="mt-1 text-xs text-muted-foreground">Ratings of the titles you played this year. Pick a score to see its titles.</p>
      <div className="mt-[22px] flex h-[180px] items-end gap-1.5 sm:gap-2.5">
        {counts.map((n, i) => {
          const score = i + 1;
          const on = picked === score;
          return (
            <button
              key={score}
              type="button"
              disabled={!n}
              aria-pressed={on}
              aria-label={`${score} out of 10: ${plural(n, "title")}`}
              onClick={() => setPicked((now) => (now === score ? null : score))}
              className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2 disabled:cursor-default"
            >
              <span className="text-xs tabular-nums text-foreground/80">{n || ""}</span>
              <span
                className={`w-full rounded-lg transition-[opacity,box-shadow] ${n ? "group-hover:opacity-90" : ""} ${on ? "shadow-[0_0_0_2px_rgba(252,211,77,0.9)]" : ""}`}
                style={{ height: n ? Math.round((n / most) * BAR_MAX) : 3, background: n ? (score === top ? "#fbbf24" : "rgba(251,191,36,0.55)") : "rgba(255,255,255,0.08)" }}
              />
              <span className={`text-xs ${on ? "font-semibold text-amber-300" : "text-muted-foreground"}`}>{score}</span>
            </button>
          );
        })}
      </div>
      {chosen.length > 0 && (
        <p className="mt-4 text-[13px] leading-relaxed text-foreground/80">
          <span className="font-semibold text-amber-300">Your {picked}s:</span> <TitleList titles={chosen} nameOf={displayName} />
        </p>
      )}
    </Panel>
  );
}

export default function TasteChapter({ model, number, label, accent }: YearChapterProps) {
  const entries = useMemo(() => rated(model), [model]);
  const stats = useMemo(() => tasteStats(model), [model]);
  const scores = entries.map((entry) => entry.score);
  return (
    <>
      <ChapterHeader number={number} label={label} accent={accent} title={entries.length ? `You rated ${plural(entries.length, "title")}.` : "How your shows landed."} sub={sublineOf(scores)} />
      <div className="mt-8 flex flex-wrap gap-5">
        {entries.length > 0 && <Ratings entries={entries} />}
        {stats.length > 0 && (
          <div className="grid min-w-0 flex-[1_1_320px] grid-cols-2 gap-3.5 self-start">
            {stats.map((stat) => (
              <div key={stat.label} className={`${YEAR_GLASS} rounded-[20px] p-5`}>
                <p className="text-[40px] font-extrabold leading-none tracking-[-0.03em] tabular-nums">{stat.value.toLocaleString()}</p>
                <p className="mt-2 text-xs text-muted-foreground">{stat.label}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
