import React, { useEffect, useRef, useState } from "react";
import { DashboardLink, personPage, titlePage } from "./DashboardLink";
import { metaIdOf } from "./yearModel";

export type YearAccent = "blue" | "pink";

export const ACCENT_TEXT: Record<YearAccent, string> = { blue: "text-blue-400", pink: "text-pink-400" };
export const ACCENT_BADGE: Record<YearAccent, string> = { blue: "bg-blue-400 text-background", pink: "bg-pink-400/25 text-pink-300" };

export const YEAR_GLASS = "bg-white/[0.055] backdrop-blur-[18px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]";

export const TEXT_LINK = "decoration-white/35 underline-offset-4 hover:underline focus-visible:underline";

type TitleTarget = { key: string; kind: "movie" | "series" };

export function TitleLink({ title, name, className = TEXT_LINK, children }: { title: TitleTarget; name?: string; className?: string; children: React.ReactNode }) {
  return <DashboardLink page={titlePage(metaIdOf(title.key), title.kind)} name={name ?? (typeof children === "string" ? children : undefined)} className={className}>{children}</DashboardLink>;
}

export function PersonLink({ person, className = TEXT_LINK, children }: { person: { id: string; name: string; photo?: string | null }; className?: string; children: React.ReactNode }) {
  return <DashboardLink page={personPage(person.id, person.name, person.photo ?? null)} name={person.name} className={className}>{children}</DashboardLink>;
}

export function TitleList<T extends TitleTarget>({ titles, nameOf, separator = " · " }: { titles: T[]; nameOf: (title: T) => string; separator?: string }) {
  return <>{titles.map((title, i) => <React.Fragment key={title.key}>{i > 0 && separator}<TitleLink title={title}>{nameOf(title)}</TitleLink></React.Fragment>)}</>;
}

export const HATCH: React.CSSProperties = { backgroundImage: "repeating-linear-gradient(135deg, rgba(147,197,253,0.6) 0 2px, rgba(147,197,253,0.08) 2px 6px)" };

export function ChapterHeader({ number, label, accent, title, sub, children, titleClassName = "" }: { number: number; label: string; accent: YearAccent; title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode; titleClassName?: string }) {
  return (
    <header>
      <span className={`text-xs font-semibold uppercase tracking-[0.16em] ${ACCENT_TEXT[accent]}`}>{String(number).padStart(2, "0")} · {label}</span>
      <h2 className={`mt-3 text-4xl font-extrabold leading-none tracking-[-0.04em] sm:text-[64px] ${titleClassName}`}>
        {title}
        {sub && <><br /><span className="text-muted-foreground">{sub}</span></>}
      </h2>
      {children && <p className="mt-5 max-w-[620px] text-base leading-[1.5] text-foreground/75 sm:text-lg">{children}</p>}
    </header>
  );
}

export function Panel({ title, aside, className = "", padding = "p-5 sm:px-7 sm:pb-5 sm:pt-7", children }: { title: string; aside?: React.ReactNode; className?: string; padding?: string; children: React.ReactNode }) {
  return (
    <div className={`${YEAR_GLASS} rounded-3xl ${padding} ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  );
}

export function Swatch({ className = "", style, label }: { className?: string; style?: React.CSSProperties; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-[3px] ${className}`} style={style} />
      {label}
    </span>
  );
}

export function Deck({ children, columns = "lg:grid-cols-3" }: { children: React.ReactNode; columns?: string }) {
  const cards = React.Children.toArray(children);
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const strip = scroller.current;
    if (!strip) return;
    const items = Array.from(strip.children);
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) setActive(items.indexOf(entry.target));
    }, { root: strip, threshold: 0.6 });
    items.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, [cards.length]);
  const show = (index: number) => {
    const strip = scroller.current;
    const card = strip?.children[index] as HTMLElement | undefined;
    if (strip && card) strip.scrollTo({ left: card.offsetLeft - strip.offsetLeft - (strip.clientWidth - card.clientWidth) / 2, behavior: "smooth" });
  };
  return (
    <div>
      <div ref={scroller} className={`-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 [scrollbar-width:none] sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:gap-5 lg:overflow-visible lg:px-0 [&::-webkit-scrollbar]:hidden ${columns}`}>
        {cards.map((card, i) => (
          <div key={i} className={`flex w-[86%] shrink-0 snap-center snap-always transition-[opacity,transform] duration-300 ease-out sm:w-[60%] lg:w-auto lg:scale-100 lg:opacity-100 [&>*]:w-full ${i === active ? "" : "scale-[0.95] opacity-50"}`}>
            {card}
          </div>
        ))}
      </div>
      {cards.length > 1 && (
        <div className="mt-4 flex justify-center gap-1.5 lg:hidden">
          {cards.map((_, i) => (
            <button key={i} type="button" aria-label={`Show card ${i + 1} of ${cards.length}`} aria-current={i === active} onClick={() => show(i)} className={`h-1.5 rounded-full transition-all duration-300 ease-out ${i === active ? "w-6 bg-foreground" : "w-1.5 bg-white/25 hover:bg-white/40"}`} />
          ))}
        </div>
      )}
    </div>
  );
}
