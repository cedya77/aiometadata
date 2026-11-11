import { useEffect, useRef, useState } from "react";
import { ArrowRight, Film, Layers, LayoutGrid, Star, Tv } from "lucide-react";
import { sizedArt } from "./art";
import { cx } from "./titleHelpers";

// The deck and wall a shelf of titles is shown as: the library's lists and a user's playlists.

export type ShelfView = "deck" | "wall";

/** One title on a deck or wall. */
export interface DeckItem {
  key: string;
  title: string;
  posterUrl: string | null;
  meta: string;
  rating: number | null;
}

export function Poster({ item, className, label = true, width = 342 }: { item: DeckItem; className?: string; label?: boolean; width?: number }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (!item.posterUrl || failed) {
    return (
      <div className={cx("flex items-end bg-gradient-to-br from-zinc-700 to-zinc-900 p-3", className)}>
        {label && <span className="line-clamp-3 text-sm font-semibold leading-tight text-white/90">{item.title}</span>}
      </div>
    );
  }
  return (
    <img
      src={sizedArt(item.posterUrl, width) ?? item.posterUrl}
      alt=""
      loading="lazy"
      draggable={false}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
      className={cx("object-cover", loaded ? "image-in" : "opacity-0", className)}
    />
  );
}

export function ListRow({ item, number, active, onPick, onOpen, trailing }: { item: DeckItem; number: number; active: boolean; onPick: () => void; onOpen: () => void; trailing?: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current;
    const box = el?.parentElement?.closest("[data-deck-list]") ?? el?.parentElement;
    if (!active || !el || !box) return;
    const row = el.getBoundingClientRect();
    const view = box.getBoundingClientRect();
    if (row.top < view.top) box.scrollBy({ top: row.top - view.top - 4, behavior: "smooth" });
    else if (row.bottom > view.bottom) box.scrollBy({ top: row.bottom - view.bottom + 4, behavior: "smooth" });
  }, [active]);
  // A list scrolled under a resting pointer moves rows beneath it without the pointer moving, which is not a pick.
  const pickOnMove = (event: React.MouseEvent) => { if (!active && (event.movementX || event.movementY)) onPick(); };
  const button = (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      onMouseMove={pickOnMove}
      onFocus={onPick}
      className={cx(
        "group relative isolate flex w-full shrink-0 items-center gap-3 overflow-hidden rounded-xl py-2 pl-2 pr-3 text-left transition-all duration-300",
        active ? "ring-1 ring-blue-400/50 shadow-[0_10px_40px_-12px_rgba(59,130,246,0.55)]" : "hover:bg-white/[0.05]",
        trailing && active && "pr-28"
      )}
    >
      {active && item.posterUrl && (
        <span aria-hidden className="absolute inset-0 -z-10">
          <img src={sizedArt(item.posterUrl, 185) ?? item.posterUrl} alt="" className="size-full scale-150 object-cover opacity-40 blur-xl saturate-150" />
          <span className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/40 to-black/10" />
        </span>
      )}
      <span className={cx("w-7 shrink-0 text-right font-mono text-sm tabular-nums transition-colors", active ? "text-blue-300" : "text-muted-foreground/50")}>{String(number).padStart(2, "0")}</span>
      <Poster item={item} label={false} width={185} className={cx("aspect-[2/3] w-9 shrink-0 rounded-md transition-transform duration-300", active && "scale-110 shadow-lg")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold leading-tight">{item.title}</span>
        <span className={cx("block truncate text-[11px]", active ? "text-white/70" : "text-muted-foreground")}>{item.meta}</span>
      </span>
      {item.rating !== null && <span className="shrink-0 rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-amber-300">{item.rating}/10</span>}
    </button>
  );
  if (!trailing) return button;
  return <div className="relative flex w-full shrink-0 items-center">{button}{active && <div className="absolute right-2 flex items-center gap-1">{trailing}</div>}</div>;
}

export function Fan({ items }: { items: DeckItem[] }) {
  const shown = items.slice(0, 4);
  return (
    <span className="relative block h-16 w-24 shrink-0" style={{ perspective: "500px" }}>
      {shown.length === 0 && <span className="absolute inset-y-0 left-6 w-11 rounded-md bg-white/5 ring-1 ring-white/10" />}
      {shown.map((item, i) => (
        <span
          key={item.key}
          className="absolute top-0 w-11 overflow-hidden rounded-md shadow-lg ring-1 ring-white/15 transition-transform duration-500"
          style={{ left: i * 14, zIndex: 10 - i, transform: `rotateY(${-22 - i * 6}deg) translateZ(${-i * 12}px)`, filter: `brightness(${1 - i * 0.15})` }}
        >
          <Poster item={item} label={false} width={185} className="aspect-[2/3] w-full" />
        </span>
      ))}
    </span>
  );
}

export function Deck({ items, index, onPick, onOpen }: { items: DeckItem[]; index: number; onPick: (i: number) => void; onOpen: (i: number) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const wheel = useRef(0);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const now = Date.now();
      if (now - wheel.current < 140) return;
      wheel.current = now;
      const step = Math.sign(event.deltaX);
      onPick(Math.max(0, Math.min(items.length - 1, index + step)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [index, items.length, onPick]);

  const reach = width < 520 ? 3 : 5;
  const card = width < 520 ? 160 : 230;
  const first = Math.max(card * 0.62, Math.min(width * 0.2, card * 0.95));
  const step = Math.max(36, Math.min(90, (width / 2 - first - card * 0.35) / Math.max(1, reach - 2)));
  return (
    <div ref={stage} className="relative h-[330px] select-none sm:h-[470px]" style={{ perspective: "1400px" }}>
      {items.map((item, i) => {
        const d = i - index;
        if (Math.abs(d) > reach) return null;
        const side = Math.sign(d);
        const depth = Math.abs(d);
        const transform = d === 0
          ? "translate(-50%, -50%) translateZ(90px) rotateY(0deg)"
          : `translate(-50%, -50%) translateX(${side * (first + (depth - 1) * step)}px) translateZ(${-140 - depth * 70}px) rotateY(${-side * 58}deg)`;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => (d === 0 ? onOpen(i) : onPick(i))}
            title={d === 0 ? `Open ${item.title}` : item.title}
            aria-label={item.title}
            className="absolute left-1/2 top-1/2 transition-[transform,opacity,filter] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{ width: card, transform, zIndex: 20 - depth, opacity: depth === reach ? 0 : 1 - depth * 0.12, filter: d === 0 ? "none" : `brightness(${1 - depth * 0.16})`, transformStyle: "preserve-3d" }}
          >
            <div className={cx("relative overflow-hidden rounded-xl ring-1 ring-white/10", d === 0 && "shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)] ring-white/25")}>
              <Poster item={item} width={500} className="aspect-[2/3] w-full" />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-transparent via-transparent to-white/15" />
            </div>
            {d === 0 && (
              <div
                aria-hidden
                className="pointer-events-none mt-1 h-16 overflow-hidden rounded-xl opacity-30"
                style={{ transform: "scaleY(-1)", maskImage: "linear-gradient(to top, black, transparent 80%)", WebkitMaskImage: "linear-gradient(to top, black, transparent 80%)" }}
              >
                <Poster item={item} width={500} className="aspect-[2/3] w-full object-bottom" />
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TiltCard({ item, onPick, active, action }: { item: DeckItem; onPick: () => void; active: boolean; action?: React.ReactNode }) {
  const [tilt, setTilt] = useState({ x: 0, y: 0, glare: 50 });
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(event) => { if (event.key === "Enter") onPick(); }}
      onMouseMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const px = (event.clientX - box.left) / box.width;
        const py = (event.clientY - box.top) / box.height;
        setTilt({ x: (0.5 - py) * 14, y: (px - 0.5) * 18, glare: px * 100 });
      }}
      onMouseLeave={() => setTilt({ x: 0, y: 0, glare: 50 })}
      className="group relative cursor-pointer text-left outline-none [perspective:900px]"
    >
      <div
        className={cx("relative overflow-hidden rounded-xl ring-1 transition-transform duration-200 ease-out", active ? "ring-2 ring-blue-400" : "ring-white/10")}
        style={{ transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg) scale(${tilt.x || tilt.y ? 1.04 : 1})` }}
      >
        <Poster item={item} className="aspect-[2/3] w-full" />
        <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100" style={{ background: `radial-gradient(circle at ${tilt.glare}% 0%, rgba(255,255,255,0.28), transparent 55%)` }} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2.5 pt-10 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <p className="truncate text-xs font-semibold text-white">{item.title}</p>
          <p className="truncate text-[10px] text-white/70">{item.meta}</p>
        </div>
        {item.rating !== null && <span className="glass absolute right-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-300">{item.rating}</span>}
      </div>
      {action && <div className="absolute inset-x-1.5 top-1.5 z-10 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100">{action}</div>}
    </div>
  );
}

const SHELF_VIEWS: ReadonlyArray<readonly [ShelfView, typeof Layers, string]> = [["deck", Layers, "Deck"], ["wall", LayoutGrid, "Wall"]];

export function ViewToggle<V extends string = ShelfView>({ view, onView, options = SHELF_VIEWS as unknown as ReadonlyArray<readonly [V, typeof Layers, string]> }: { view: V; onView: (view: V) => void; options?: ReadonlyArray<readonly [V, typeof Layers, string]> }) {
  return (
    <div className="glass flex h-9 items-center rounded-full p-0.5">
      {options.map(([key, ViewIcon, label]) => (
        <button key={key} type="button" onClick={() => onView(key)} aria-label={label} className={cx("flex h-full items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors", view === key ? "bg-white/15 text-foreground" : "text-muted-foreground hover:text-foreground")}>
          <ViewIcon className="size-3.5" /> <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}

export function Stars({ value }: { value: number }) {
  const out = Math.max(0, Math.min(10, value));
  return (
    <span className="inline-flex items-center gap-0.5" title={`${out}/10`}>
      {Array.from({ length: 5 }, (_, i) => {
        const fill = Math.max(0, Math.min(1, out / 2 - i));
        return (
          <span key={i} className="relative inline-block size-3.5">
            <Star className="absolute inset-0 size-3.5 text-white/20" strokeWidth={0} fill="currentColor" />
            <span className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
              <Star className="size-3.5 text-amber-400" strokeWidth={0} fill="currentColor" />
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** What the panel under a deck says of the title in focus. */
export interface DeckDetailInfo {
  key: string;
  title: string;
  logoUrl: string | null;
  kind: "movie" | "series" | "episode";
  kindLabel: string;
  /** An episode's code and name, after its kind. */
  part?: string | null;
  year: string | null;
  score: string | null;
  scoreLabel: string;
  genres: string[];
  overview: string | null;
  rating: number | null;
  note: string | null;
}

export function DeckDetail({ info, onOpen, action, aside }: { info: DeckDetailInfo; onOpen?: () => void; action?: React.ReactNode; aside?: React.ReactNode }) {
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [info.key]);
  const body = (
    <>
      {info.logoUrl && !logoFailed
        ? <img src={sizedArt(info.logoUrl, 500) ?? info.logoUrl} alt={info.title} onError={() => setLogoFailed(true)} className="mb-2 max-h-14 max-w-[70%] object-contain object-left drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]" />
        : <h3 className="mb-1 text-2xl font-bold leading-tight tracking-tight">{info.title}</h3>}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">{info.kind === "movie" ? <Film className="size-3.5" /> : <Tv className="size-3.5" />}{info.kindLabel}</span>
        {info.part && <span>· {info.part}</span>}
        {info.year && <span>· {info.year}</span>}
        {info.score && <span>· {info.scoreLabel} {info.score}</span>}
        {info.genres.length > 0 && <span>· {info.genres.join(", ")}</span>}
      </div>
      {info.overview && <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-foreground/85">{info.overview}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {info.rating !== null && <span className="inline-flex items-center gap-2"><Stars value={info.rating} /><span className="tabular-nums text-foreground">{info.rating}/10</span></span>}
        {info.note && <span>{info.note}</span>}
        <span className="ml-auto flex items-center gap-2">
          {onOpen && <button type="button" onClick={onOpen} className="glass inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium hover:bg-white/15">Open <ArrowRight className="size-3.5" /></button>}
          {action}
        </span>
      </div>
    </>
  );
  return (
    <div key={info.key} className="glass animate-fade-in rounded-2xl p-4 sm:p-5">
      {aside ? <div className="flex gap-4">{aside}<div className="min-w-0 flex-1">{body}</div></div> : body}
    </div>
  );
}
