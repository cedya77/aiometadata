import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, ChevronDown, Film, Layers, Loader2, Search, Sparkles, Tv, Users, Zap } from "lucide-react";
import { useJellyfinFind, useJellyfinSearches, type DashboardTab, type JellyfinSearchCatalog, type JellyfinTitleRef } from "@/hooks/useDashboardQueries";
import { sizedArt } from "./art";
import { useOpenTitle } from "./jellyfinUtils";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export interface LocalTitle {
  id: string;
  type: "movie" | "series";
  title: string;
  posterUrl: string | null;
  state: string | null;
}

interface Result {
  key: string;
  ref: JellyfinTitleRef;
  title: string;
  sub: string;
  posterUrl: string | null;
  state: string | null;
  group: "profile" | "everywhere";
}

function Thumb({ src, type }: { src: string | null; type: "movie" | "series" }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <span className="flex aspect-[2/3] w-9 shrink-0 items-center justify-center rounded-md bg-white/10">{type === "movie" ? <Film className="size-3.5 text-muted-foreground" /> : <Tv className="size-3.5 text-muted-foreground" />}</span>;
  }
  return <img src={sizedArt(src, 185) ?? src} alt="" loading="lazy" onError={() => setFailed(true)} className="aspect-[2/3] w-9 shrink-0 rounded-md object-cover" />;
}

const QUICK = "quick";

function SourceIcon({ source }: { source: JellyfinSearchCatalog | null }) {
  const cls = "size-3.5 shrink-0";
  if (!source) return <Zap className={cls} />;
  if (source.id.startsWith("people_search")) return <Users className={cls} />;
  if (source.id === "gemini.search") return <Bot className={cls} />;
  if (source.type.startsWith("anime")) return <Sparkles className={cls} />;
  if (source.type === "collection") return <Layers className={cls} />;
  return source.type === "movie" ? <Film className={cls} /> : <Tv className={cls} />;
}

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export default function JellyfinSearch({ userUUID, profile, profileName, local, activeTab }: { userUUID: string; profile: string | null; profileName: string; local: LocalTitle[]; activeTab: DashboardTab }) {
  const open = useOpenTitle();
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const sourceKey = `jellyfin.search.${userUUID}.${profile ?? ""}`;
  const [picked, setPicked] = useState<string | null>(() => remembered(sourceKey));
  const [menu, setMenu] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searches = useJellyfinSearches(userUUID, profile, { activeTab });
  const catalogs = searches.data?.catalogs ?? [];
  const quick = searches.data?.quick ?? true;
  const chosen = picked && picked !== QUICK ? catalogs.find((c) => c.id === picked) ?? null : null;
  const source: JellyfinSearchCatalog | null = chosen ?? (!quick && catalogs[0] ? catalogs[0] : null);
  const { data, isFetching, isError } = useJellyfinFind(userUUID, profile, query, source?.id ?? null, { activeTab });
  const chooseSource = (id: string) => {
    setPicked(id);
    setMenu(false);
    try { localStorage.setItem(sourceKey, id); } catch { /* storage may be unavailable */ }
    input.current?.focus();
  };

  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), source ? 450 : 250);
    return () => clearTimeout(timer);
  }, [typed, source]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, select, [contenteditable='true']");
      if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !panel.current?.contains(target)) setFocused(false);
      if (!trigger.current?.contains(target) && !menuRef.current?.contains(target)) setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", away);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", away);
    };
  }, []);

  const results = useMemo<Result[]>(() => {
    const needle = typed.trim().toLowerCase();
    if (needle.length < 2) return [];
    const mine = local.filter((t) => t.title.toLowerCase().includes(needle)).slice(0, 5).map<Result>((t) => ({
      key: `p:${t.id}`, ref: { id: t.id, type: t.type }, title: t.title, sub: t.type === "movie" ? "Movie" : "Show", posterUrl: t.posterUrl, state: t.state, group: "profile",
    }));
    const seen = new Set(mine.map((r) => ("id" in r.ref ? r.ref.id : "")));
    // The query keeps the last answer while the next loads, which is shown only for the words it answered.
    const everywhere = (query === typed.trim() && data?.query === query ? data.results : []).filter((r) => !seen.has(r.id)).map<Result>((r) => ({
      key: `e:${r.id}`, ref: { id: r.id, type: r.type }, title: r.title, sub: [r.type === "movie" ? "Movie" : "Show", r.year].filter(Boolean).join(" · "), posterUrl: r.posterUrl, state: null, group: "everywhere",
    }));
    return [...mine, ...everywhere];
  }, [typed, query, local, data]);

  useEffect(() => setActive(0), [typed]);

  const choose = (result: Result) => {
    open?.(result.ref);
    setTyped("");
    setFocused(false);
    input.current?.blur();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (event.key === "Enter" && results[active]) { event.preventDefault(); choose(results[active]); }
    else if (event.key === "Escape") { setTyped(""); input.current?.blur(); setFocused(false); }
  };

  const showPanel = focused && typed.trim().length >= 2;
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!showPanel) return;
    const measure = () => {
      const rect = box.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(window.innerWidth - 16, Math.max(rect.width, 416));
      setPlace({ top: rect.bottom + 8, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [showPanel]);
  const waiting = isFetching || query !== typed.trim();
  const groups: Array<["profile" | "everywhere", string]> = [["profile", `In ${profileName}'s history`], ["everywhere", source ? source.name : "Everywhere"]];
  const menuPlace = menu ? trigger.current?.getBoundingClientRect() : null;
  const options: Array<{ id: string; label: string; source: JellyfinSearchCatalog | null }> = [
    ...(quick ? [{ id: QUICK, label: "Quick", source: null }] : []),
    ...catalogs.map((c) => ({
      id: c.id,
      label: catalogs.filter((other) => other.name === c.name).length > 1 ? `${c.name} · ${c.type.includes("movie") ? "Movies" : "Shows"}` : c.name,
      source: c,
    })),
  ];

  return (
    <div ref={box} className="relative mr-auto w-full sm:w-[30rem]">
      <div className={cx("glass flex h-10 items-center gap-2 rounded-full pl-1 pr-4 transition-shadow", focused && "ring-2 ring-blue-500/60")}>
        <button
          ref={trigger}
          type="button"
          onClick={() => setMenu((v) => !v)}
          title="Choose what to search"
          className="flex h-8 max-w-[55%] shrink-0 items-center gap-1.5 rounded-full bg-white/10 pl-2.5 pr-2 text-xs font-medium text-foreground transition hover:bg-white/15"
        >
          <SourceIcon source={source} />
          <span className="truncate">{source ? source.name : "Quick"}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={input}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={onKeyDown}
          placeholder="Search titles"
          aria-label="Search titles"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        {waiting && typed.trim().length >= 2
          ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          : <kbd className="hidden shrink-0 rounded border border-white/15 px-1.5 text-[10px] text-muted-foreground sm:block">/</kbd>}
      </div>
      {menu && menuPlace && options.length > 0 && createPortal(
        <div ref={menuRef} style={{ position: "fixed", top: menuPlace.bottom + 8, left: Math.max(8, menuPlace.left), minWidth: 240 }} className="z-[95] max-h-[60vh] overflow-y-auto rounded-2xl border border-white/10 bg-popover/95 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl animate-fade-in">
          <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Search with</p>
          {options.map((option) => {
            const selected = (source?.id ?? QUICK) === option.id;
            return (
              <button key={option.id} type="button" onClick={() => chooseSource(option.id)} className={cx("flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors", selected ? "bg-white/[0.12]" : "hover:bg-white/[0.06]")}>
                <span className="text-muted-foreground"><SourceIcon source={option.source} /></span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.id === QUICK && <span className="text-[11px] text-muted-foreground">as you type</span>}
                {selected && <Check className="size-3.5 text-blue-400" />}
              </button>
            );
          })}
        </div>,
        document.body
      )}
      {showPanel && place && createPortal(
        <div ref={panel} style={{ position: "fixed", top: place.top, left: place.left, width: place.width }} className="z-[90] max-h-[60vh] overflow-y-auto rounded-2xl border border-white/10 bg-popover/95 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl animate-fade-in">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {waiting ? "Searching…" : isError ? "Search is unavailable right now." : data && !data.available ? "Search needs LumiereDB, which this server has not set up." : `Nothing matches "${typed.trim()}".`}
            </p>
          ) : groups.map(([group, label]) => {
            const rows = results.filter((r) => r.group === group);
            if (!rows.length) return null;
            return (
              <div key={group} className="py-1">
                <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
                {rows.map((row) => {
                  const index = results.indexOf(row);
                  return (
                    <button
                      key={row.key}
                      type="button"
                      onMouseEnter={() => setActive(index)}
                      onClick={() => choose(row)}
                      className={cx("flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors", index === active ? "bg-white/[0.12]" : "hover:bg-white/[0.06]")}
                    >
                      <Thumb src={row.posterUrl} type={"type" in row.ref ? row.ref.type : "series"} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{row.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{row.sub}</span>
                      </span>
                      {row.state && <span className="shrink-0 rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] font-medium text-blue-300">{row.state}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {waiting && results.length > 0 && <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Searching everywhere…</p>}
        </div>,
        document.body
      )}
    </div>
  );
}
