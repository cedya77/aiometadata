import React, { memo, useEffect, useRef, useState } from "react";
import { sizedArt } from "./art";
import { ChevronDown } from "lucide-react";
import { duration } from "./jellyfinUtils";

export function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-muted/30 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
export function Art({ src, title, wide }: { src: string | null; title: string; wide: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const shape = wide ? "aspect-video" : "aspect-[2/3]";
  if (!src || failed) {
    return (
      <div className={`${shape} w-full rounded-md bg-muted/60 flex items-end p-2`}>
        <span className="text-[11px] leading-tight text-muted-foreground line-clamp-2">{title}</span>
      </div>
    );
  }
  return <img src={sizedArt(src, wide ? 780 : 342) ?? src} alt="" loading="lazy" onError={() => setFailed(true)} className={`${shape} w-full rounded-md object-cover bg-muted/60`} />;
}
function Caption({ title, episode, meta }: { title: string; episode: string | null; meta: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium leading-tight truncate" title={title}>{title}</p>
      {episode && <p className="text-[11px] text-muted-foreground leading-tight truncate" title={episode}>{episode}</p>}
      <p className="text-[11px] text-muted-foreground leading-tight truncate">{meta}</p>
    </div>
  );
}
export function Sentinel({ onVisible, root, margin = "600px" }: { onVisible: () => void; root?: React.RefObject<HTMLElement | null>; margin?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(onVisible);
  latest.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && latest.current(), { root: root?.current ?? null, rootMargin: margin });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root, margin]);
  return <div ref={ref} className="h-px w-px shrink-0" />;
}
export function ShelfTitle({ title, count, folded, onFold }: { title: string; count: number | null; folded?: boolean; onFold?: () => void }) {
  const label = (
    <>
      {title}{count !== null && <span className="tabular-nums"> ({count})</span>}
    </>
  );
  if (!onFold) return <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>;
  return (
    <button type="button" onClick={onFold} aria-expanded={!folded} className="group/fold flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground">
      <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${folded ? "-rotate-90" : ""}`} />
      {label}
    </button>
  );
}
export function Shelf({ title, count, action, folded = false, onFold, children }: { title: string; count: number | null; action?: React.ReactNode; folded?: boolean; onFold?: () => void; children: React.ReactNode }) {
  return (
    <section className="px-4 py-3 sm:px-6">
      <div className={`flex flex-wrap items-center justify-between gap-2 ${folded ? "" : "mb-2"}`}>
        <ShelfTitle title={title} count={count} folded={folded} onFold={onFold} />
        {!folded && action}
      </div>
      {!folded && children}
    </section>
  );
}

export const Ambient = memo(({ src }: { src: string | null }) => {
  const [layers, setLayers] = useState<string[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  if (src !== shown) {
    setShown(src);
    if (src) setLayers((previous) => [...previous.filter((layer) => layer !== src), src].slice(-2));
  }
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {layers.map((layer) => <img key={layer} src={sizedArt(layer, 342) ?? layer} alt="" className="image-in absolute inset-0 size-full scale-110 object-cover opacity-45 blur-2xl saturate-150" />)}
      <div className="absolute inset-0 bg-gradient-to-r from-background via-background/75 to-background/40" />
      <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-background/60" />
    </div>
  );
});
Ambient.displayName = "Ambient";
