import type { JellyfinTitleRating } from "@/hooks/useDashboardQueries";
import { iconOf, knownRatings, LABELS, textOf } from "./criticRatingSources";
import { cx } from "./titleHelpers";

export default function CriticRatings({ ratings, className, iconClassName = "h-4" }: { ratings: JellyfinTitleRating[]; className?: string; iconClassName?: string }) {
  const shown = knownRatings(ratings);
  if (!shown.length) return null;
  return (
    <ul aria-label="Ratings" className={cx("flex flex-wrap items-center gap-x-3.5 gap-y-2", className)}>
      {shown.map((rating) => {
        const { value, suffix } = textOf(rating);
        const label = LABELS[rating.source] ?? rating.source;
        const content = (
          <>
            <img src={iconOf(rating)!} alt={label} draggable={false} className={cx("w-auto shrink-0 select-none", iconClassName)} />
            <span className="font-semibold tabular-nums">{value}</span>
            {suffix && <span className="-ml-1 text-[0.75em] font-medium opacity-55">{suffix}</span>}
          </>
        );
        return (
          <li key={rating.source} title={label} className="flex items-center">
            {rating.url && /^https:\/\//.test(rating.url)
              ? <a href={rating.url} target="_blank" rel="noreferrer" aria-label={`Open on ${label}`} className="flex items-center gap-[5px] rounded-sm transition-opacity hover:opacity-80">{content}</a>
              : <span className="flex items-center gap-[5px]">{content}</span>}
          </li>
        );
      })}
    </ul>
  );
}
