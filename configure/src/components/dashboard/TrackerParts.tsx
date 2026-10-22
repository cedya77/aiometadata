import { useState } from "react";
import { Film } from "lucide-react";
import { CARD_SERVICES } from "@/lib/cardAccounts";
import { TRACKER_TILES, nameOf } from "./trackerNames";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export function Logo({ service, size = 36, className }: { service: string; size?: number; className?: string }) {
  const icon = (CARD_SERVICES as Record<string, { icon?: string }>)[service]?.icon;
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, borderRadius: Math.round(size * 0.28) };
  return (
    <span aria-hidden style={style} className={cx("inline-flex shrink-0 items-center justify-center overflow-hidden ring-1 ring-inset ring-white/10", TRACKER_TILES[service] ?? "bg-zinc-700", className)}>
      {icon && !failed
        ? <img src={icon} alt="" onError={() => setFailed(true)} className="size-full object-cover" />
        : <span className="text-xs font-black text-white">{nameOf(service).slice(0, 1)}</span>}
    </span>
  );
}

export function Still({ src, className }: { src: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  return src && !failed
    ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className={cx("aspect-video shrink-0 rounded-md object-cover", className)} />
    : <span className={cx("flex aspect-video shrink-0 items-center justify-center rounded-md bg-white/5", className)}><Film className="size-4 text-muted-foreground" /></span>;
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{children}</p>;
}

export function Toggle<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, React.ComponentType<{ className?: string }>, string]>; onChange: (next: T) => void }) {
  return (
    <div className="glass flex h-9 items-center rounded-full p-0.5">
      {options.map(([key, Icon, label]) => (
        <button key={key} type="button" onClick={() => onChange(key)} aria-pressed={value === key} className={cx("flex h-full items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors", value === key ? "bg-white/15 text-foreground" : "text-muted-foreground hover:text-foreground")}>
          <Icon className="size-3.5" /> <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}
