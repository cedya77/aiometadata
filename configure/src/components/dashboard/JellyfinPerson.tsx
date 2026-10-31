import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDownWideNarrow, ArrowLeft, ArrowUpNarrowWide, Check, ChevronLeft, ChevronRight, ImageOff, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { nameDashboardPage } from "@/lib/dashboardRoute";
import {
  useJellyfinPerson,
  useJellyfinPersonTitles,
  type DashboardTab,
  type JellyfinLibraryKind,
  type JellyfinPerson,
  type JellyfinPersonRole,
  type JellyfinPersonTitle,
  type JellyfinTitlePerson,
  type JellyfinTitleRef,
} from "@/hooks/useDashboardQueries";
import { reloadPages } from "./jellyfinUtils";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
const SECTION_TITLE = "text-xl font-bold sm:text-3xl";
const GRID = "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-9";
const ROLES = ["Actor", "Director", "Writer", "Producer", "Composer"] as const;
const ROLE_LABELS: Record<JellyfinPersonRole, string> = { all: "All roles", Actor: "Acting", Director: "Directing", Writer: "Writing", Producer: "Production", Composer: "Music" };
const KIND_LABELS: Record<JellyfinLibraryKind, string> = { all: "All", movie: "Movies", series: "Shows" };

const initials = (name: string) => name.split(" ").map((part) => part[0]).join("").toUpperCase();
const sized = (url: string | null, width: number) => (url ? `${url}&maxWidth=${width}` : null);
const inRole = (roles: string[], role: JellyfinPersonRole) =>
  role === "all" || (role === "Actor" ? roles.includes("Actor") || roles.includes("GuestStar") : roles.includes(role));

function Portrait({ src, name, className }: { src: string | null; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cx("overflow-hidden", className)}>
      {src && !failed ? (
        <img src={src} alt={name} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover transition-[opacity,transform] duration-300 ease-out will-change-transform group-hover:scale-105 group-hover:opacity-75" />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-muted text-2xl">{name ? initials(name) : <ImageOff className="size-12 text-muted-foreground" />}</div>
      )}
    </div>
  );
}

export const CastRow = memo(function CastRow({ people, onPerson }: { people: JellyfinTitlePerson[]; onPerson: (person: JellyfinTitlePerson) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: true });
  useEffect(() => {
    const row = track.current;
    if (!row) return;
    const check = () => setEdges({ left: row.scrollLeft > 0, right: row.scrollLeft + row.clientWidth < row.scrollWidth - 1 });
    check();
    row.addEventListener("scroll", check);
    window.addEventListener("resize", check);
    return () => {
      row.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, [people.length]);
  const scroll = (offset: number) => track.current?.scrollBy({ left: offset, behavior: "smooth" });
  const arrow = "glass flex size-9 items-center justify-center rounded-md transition hover:bg-white/15 disabled:opacity-40 max-sm:hidden pointer-coarse:hidden";
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className={SECTION_TITLE}>Cast and Crew</h3>
        <div className="flex gap-2">
          <button type="button" onClick={() => scroll(-300)} disabled={!edges.left} aria-label="Scroll left" className={arrow}><ChevronLeft className="size-4" /></button>
          <button type="button" onClick={() => scroll(300)} disabled={!edges.right} aria-label="Scroll right" className={arrow}><ChevronRight className="size-4" /></button>
        </div>
      </div>
      <div ref={track} className="flex gap-2 overflow-x-auto scroll-smooth sm:gap-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {people.map((person) => (
          <button key={`${person.id}-${person.type}-${person.role}`} type="button" onClick={() => onPerson(person)} className="group flex w-22 min-w-22 flex-col items-stretch justify-start text-center sm:w-30 sm:min-w-30">
            <Portrait src={sized(person.photo, 240)} name={person.name} className="aspect-square w-full rounded-full" />
            <p className="mt-2 line-clamp-1 break-all text-sm sm:text-base">{person.name || "No Name"}</p>
            {person.role && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground sm:text-sm">{person.role}</p>}
          </button>
        ))}
      </div>
    </section>
  );
});

function Segment({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cx("rounded-md px-3 py-1.5 text-sm font-medium transition-colors", active ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:text-foreground")}>
      {children}
    </button>
  );
}

function PosterCard({ row, onOpen }: { row: JellyfinPersonTitle; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  const src = sized(row.posterUrl, 300);
  return (
    <button type="button" onClick={onOpen} className="group flex min-w-0 flex-col items-stretch justify-start text-left">
      <div data-poster className="relative aspect-[2/3] w-full overflow-hidden rounded-md">
        {src && !failed ? (
          <>
            <img src={src} alt={row.title} loading="lazy" onError={() => setFailed(true)} className="relative z-10 h-full w-full rounded-md object-cover transition-all group-hover:scale-105 group-hover:opacity-75" />
            <Skeleton className="absolute inset-0" />
          </>
        ) : (
          <div className="flex h-full w-full items-center justify-center rounded-md bg-foreground/[0.04]"><ImageOff className="text-muted-foreground" /></div>
        )}
        <div className="pointer-events-none absolute inset-0 z-20 rounded-md ring-1 ring-inset ring-white/10" />
        {row.played && <span className="absolute right-1.5 top-1.5 z-20 flex size-6 items-center justify-center rounded-full bg-blue-500 text-white shadow"><Check className="size-3.5" strokeWidth={3} /></span>}
        {!row.played && row.progress > 0 && (
          <div className="absolute inset-x-0 bottom-0 z-20 h-1 bg-gray-700"><div className="h-full bg-blue-500" style={{ width: `${Math.min(100, row.progress)}%` }} /></div>
        )}
      </div>
      <p className="mt-2 line-clamp-2 break-words text-sm leading-snug" title={row.title}>{row.title || "No title"}</p>
      <span className="line-clamp-1 text-xs text-muted-foreground">{row.type === "series" ? "Show" : "Movie"}</span>
    </button>
  );
}

interface YearGroup {
  year: number | null;
  rows: JellyfinPersonTitle[];
  decade?: number;
}

function groupByYear(rows: JellyfinPersonTitle[], order: "newest" | "oldest"): YearGroup[] {
  const byYear = new Map<number | null, JellyfinPersonTitle[]>();
  for (const row of rows) byYear.set(row.year, [...(byYear.get(row.year) ?? []), row]);
  const direction = order === "newest" ? -1 : 1;
  return [...byYear.entries()]
    .map(([year, list]) => ({ year, rows: list.sort((a, b) => a.title.localeCompare(b.title)) }))
    .sort((a, b) => (a.year === null ? 1 : b.year === null ? -1 : (a.year - b.year) * direction))
    .map((group, index, groups) => {
      if (group.year === null) return group;
      const decade = Math.floor(group.year / 10) * 10;
      const previous = groups[index - 1]?.year;
      return previous == null || Math.floor(previous / 10) * 10 !== decade ? { ...group, decade } : group;
    });
}

const YearRow = memo(function YearRow({ group, onOpen }: { group: YearGroup; onOpen: (row: JellyfinPersonTitle) => void }) {
  return (
    <li data-decade={group.decade} data-year={group.year ?? undefined} className="relative grid scroll-mt-24 grid-cols-[3.5rem_1fr] gap-4 pb-10 [contain-intrinsic-size:auto_320px] [content-visibility:auto] sm:grid-cols-[5rem_1fr] sm:gap-8">
      <div className="relative flex flex-col items-end pt-0.5 text-right">
        <span className="text-lg font-semibold leading-none tabular-nums sm:text-2xl">{group.year ?? "TBA"}</span>
        <span className="mt-1.5 text-xs text-muted-foreground tabular-nums">{group.rows.length}</span>
        <span className="absolute -right-[calc(0.5rem+5px)] top-1.5 size-2.5 rounded-full bg-blue-500 ring-4 ring-background sm:-right-[calc(1rem+5px)]" />
      </div>
      <div className={`grid gap-4 ${GRID}`}>
        {group.rows.map((row) => <PosterCard key={row.id} row={row} onOpen={() => onOpen(row)} />)}
      </div>
    </li>
  );
});

function TimelineSkeleton() {
  return (
    <div className="grid grid-cols-[3.5rem_1fr] gap-4 sm:grid-cols-[5rem_1fr] sm:gap-8">
      <Skeleton className="ml-auto h-6 w-12" />
      <div className={`grid gap-4 ${GRID}`}>{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="aspect-[2/3] w-full" />)}</div>
    </div>
  );
}

function Timeline({ userUUID, profile, personId, kind, role, order, jump, activeTab, onOpen }: {
  userUUID: string;
  profile: string | null;
  personId: string;
  kind: JellyfinLibraryKind;
  role: JellyfinPersonRole;
  order: "newest" | "oldest";
  jump: { decade: number; at: number } | null;
  activeTab: DashboardTab;
  onOpen: (row: JellyfinPersonTitle) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState(0);
  const [rows, setRows] = useState<JellyfinPersonTitle[]>([]);
  const target = useRef<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const page = useJellyfinPersonTitles(userUUID, profile, personId, kind, role, order, offset, { activeTab });
  const total = page.data?.total ?? null;
  const loading = page.isLoading || (page.isFetching && page.data?.offset !== offset);
  const more = total !== null && next < total;

  const queryClient = useQueryClient();
  const loaded = useRef<number[]>([]);
  useEffect(() => {
    const data = page.data;
    if (!data || data.offset !== offset) return;
    if (offset !== 0 && loaded.current.includes(offset)) {
      const offsets = [...loaded.current];
      void reloadPages<JellyfinPersonTitle>(queryClient, ["dashboard", "jellyfin", "person-titles", userUUID, profile, personId, kind, role, order], offsets).then((pages) => {
        if (!pages) return;
        const seen = new Set<string>();
        setRows(pages.flat().filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id))));
      });
      return;
    }
    if (!loaded.current.includes(offset)) loaded.current = [...loaded.current, offset];
    setNext(data.next ?? offset + data.rows.length);
    setRows((held) => {
      const kept = offset === 0 ? [] : held;
      const seen = new Set(kept.map((row) => row.id));
      return [...kept, ...data.rows.filter((row) => !seen.has(row.id))];
    });
  }, [page.data, offset]);

  const loadMore = () => { if (more && !loading) setOffset(next); };

  // A page the profile's cap emptied shows nothing to scroll past, so the next one is asked for straight away.
  useEffect(() => {
    if (more && !loading && page.data?.offset === offset && page.data.rows.length === 0) setOffset(next);
  }, [more, loading, page.data, offset, next]);

  useEffect(() => {
    const end = endRef.current;
    if (!end || !more || loading) return;
    const observer = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) setOffset(next); }, { rootMargin: "1200px 0px" });
    observer.observe(end);
    return () => observer.disconnect();
  }, [more, loading, next]);

  useEffect(() => {
    if (jump) target.current = jump.decade;
  }, [jump]);

  useEffect(() => {
    const decade = target.current;
    if (decade === null) return;
    const found = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-year]") ?? [])].find((row) => {
      const year = Number(row.dataset.year);
      return order === "newest" ? year < decade + 10 : year >= decade;
    });
    if (found) {
      target.current = null;
      found.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (more) {
      loadMore();
    } else {
      target.current = null;
    }
  });

  const groups = useMemo(() => groupByYear(rows, order), [rows, order]);

  if (page.isError && rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Could not load this filmography. <button type="button" onClick={() => void page.refetch()} className="underline">Retry</button></p>;
  }
  if (rows.length === 0) return loading || more || total === null ? <TimelineSkeleton /> : <p className="text-sm text-muted-foreground">Nothing in this view.</p>;
  return (
    <>
      <ol ref={listRef} className="relative">
        <span aria-hidden className="absolute bottom-10 left-[calc(3.5rem+0.5rem)] top-2 w-px bg-foreground/10 sm:left-[calc(5rem+1rem)]" />
        {groups.map((group) => <YearRow key={group.year ?? "unknown"} group={group} onOpen={onOpen} />)}
      </ol>
      <div ref={endRef} aria-hidden />
      {loading && <TimelineSkeleton />}
      {page.isError && <p className="text-sm text-muted-foreground">Could not load more. <button type="button" onClick={() => void page.refetch()} className="underline">Retry</button></p>}
    </>
  );
}

function Filmography({ userUUID, profile, person, activeTab, onOpen }: { userUUID: string; profile: string | null; person: JellyfinPerson; activeTab: DashboardTab; onOpen: (row: JellyfinPersonTitle) => void }) {
  const [kind, setKind] = useState<JellyfinLibraryKind>("all");
  const [picked, setPicked] = useState<JellyfinPersonRole | null>(null);
  const [order, setOrder] = useState<"newest" | "oldest">("newest");
  const [jump, setJump] = useState<{ decade: number; at: number } | null>(null);
  const roleCounts = useMemo(() => Object.fromEntries(ROLES.map((role) => [role, person.credits.filter((c) => inRole(c.roles, role)).length])) as Record<(typeof ROLES)[number], number>, [person.credits]);
  const known = ROLES.find((role) => role === person.knownFor);
  const role: JellyfinPersonRole = picked ?? (known && roleCounts[known] > 0 ? known : "all");
  const roles = ROLES.filter((value) => roleCounts[value] > 0);
  const inView = useMemo(() => person.credits.filter((c) => role === "all" || inRole(c.roles, role)), [person.credits, role]);
  const counts = { all: inView.length, movie: inView.filter((c) => c.type === "movie").length, series: inView.filter((c) => c.type === "series").length };
  const decades = useMemo(() => {
    const years = inView.filter((c) => kind === "all" || c.type === kind).map((c) => c.year).filter((y): y is number => y !== null);
    if (!years.length) return [];
    const list: number[] = [];
    for (let decade = Math.floor(Math.max(...years) / 10) * 10; decade >= Math.floor(Math.min(...years) / 10) * 10; decade -= 10) list.push(decade);
    return order === "newest" ? list : list.reverse();
  }, [inView, kind, order]);

  if (person.credits.length === 0) return null;
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h3 className="text-3xl font-bold">Filmography</h3>
          <span className="text-sm text-muted-foreground tabular-nums">{counts.all} {counts.all === 1 ? "title" : "titles"}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {roles.length > 0 && (
            <div className="flex flex-wrap rounded-lg border border-foreground/10 p-0.5">
              {(["all", ...roles] as const).map((value) => (
                <Segment key={value} active={role === value} onClick={() => { setPicked(value); setKind("all"); }}>
                  {ROLE_LABELS[value]}
                  {value !== "all" && <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{roleCounts[value]}</span>}
                </Segment>
              ))}
            </div>
          )}
          {counts.movie > 0 && counts.series > 0 && (
            <div className="flex rounded-lg border border-foreground/10 p-0.5">
              {(["all", "movie", "series"] as const).map((value) => (
                <Segment key={value} active={kind === value} onClick={() => setKind(value)}>
                  {KIND_LABELS[value]}
                  <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{counts[value]}</span>
                </Segment>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setOrder(order === "newest" ? "oldest" : "newest")} className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium hover:bg-white/10">
            {order === "newest" ? <ArrowDownWideNarrow className="size-4" /> : <ArrowUpNarrowWide className="size-4" />}
            {order === "newest" ? "Newest first" : "Oldest first"}
          </button>
        </div>
      </div>
      {decades.length > 2 && (
        <div className="flex flex-wrap gap-1.5">
          {decades.map((decade) => (
            <button key={decade} type="button" onClick={() => setJump({ decade, at: Date.now() })} className="rounded-md border border-foreground/10 px-2.5 py-1 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground">
              {decade}s
            </button>
          ))}
        </div>
      )}
      <Timeline key={`${role}|${kind}|${order}`} userUUID={userUUID} profile={profile} personId={person.id} kind={kind} role={role} order={order} jump={jump} activeTab={activeTab} onOpen={onOpen} />
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      <p className="text-muted-foreground">{label}:</p>
      <p>{value}</p>
    </div>
  );
}

// A birth or death date is a bare day, sent as midnight UTC, so it is read in UTC or it falls a day early west of it.
const longDate = (value: string) => new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

export default function JellyfinPersonView({ userUUID, profile, profileName, person: cast, activeTab, shown, onBack, onCloseAll, onOpenTitle }: {
  userUUID: string;
  profile: string | null;
  profileName: string;
  person: JellyfinTitlePerson;
  activeTab: DashboardTab;
  shown: boolean;
  onBack: () => void;
  onCloseAll: () => void;
  onOpenTitle: (ref: JellyfinTitleRef) => void;
}) {
  const { data: person, isLoading, isError, refetch } = useJellyfinPerson(userUUID, profile, cast.id, { activeTab });
  const [expanded, setExpanded] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const photo = sized(person?.photo ?? cast.photo, 576);
  const name = person?.name || cast.name;
  useEffect(() => {
    if (shown && person?.name) nameDashboardPage(person.name);
  }, [shown, person?.name]);

  return createPortal(
    <div className={cx("fixed inset-0 z-[100] overflow-y-auto overflow-x-hidden overscroll-contain bg-background animate-fade-in", !shown && "invisible")} aria-hidden={!shown} role="dialog" aria-modal="true" aria-label={name}>
      <div className="relative isolate min-h-full">
        {photo && (
          <div aria-hidden className="pointer-events-none fixed inset-0 -z-20 overflow-hidden">
            <img src={sized(person?.photo ?? cast.photo, 400) ?? undefined} alt="" className="h-full w-full scale-110 object-cover opacity-40 blur-3xl" />
            <div className="absolute inset-0 bg-gradient-to-b from-background/80 via-background/50 to-background" />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
          </div>
        )}
        <div className="sticky top-0 z-40 flex items-center justify-between gap-3 px-4 pt-4 sm:px-12 sm:pt-6">
          <button type="button" onClick={onBack} aria-label="Back" className="glass flex size-11 items-center justify-center rounded-full hover:bg-black/50"><ArrowLeft className="size-5" /></button>
          <div className="flex items-center gap-2">
            <span className="glass rounded-full px-3.5 py-2 text-xs text-muted-foreground">Viewing as <span className="font-semibold text-foreground">{profileName}</span></span>
            <button type="button" onClick={onCloseAll} aria-label="Close" className="glass flex size-11 items-center justify-center rounded-full hover:bg-black/50"><X className="size-5" /></button>
          </div>
        </div>

        <div className="relative z-10 px-4 pb-32 pt-6 sm:px-12">
          <div className="flex w-full flex-col gap-8 rounded-md bg-background/30 p-4 backdrop-blur-md sm:p-8">
            <div className="flex max-w-7xl flex-col gap-6 md:flex-row">
              <div className="relative hidden h-90 w-60 min-w-60 sm:block sm:h-108 sm:w-72 sm:min-w-72">
                {photo && !photoFailed ? (
                  <>
                    <img src={photo} alt={name} onError={() => setPhotoFailed(true)} className="h-full w-full rounded-md object-cover" />
                    <Skeleton className="absolute inset-0 -z-10 h-full w-full rounded-md" />
                  </>
                ) : (
                  <div className="flex h-full w-full items-center justify-center rounded-md bg-muted">
                    {name ? <span className="text-5xl font-bold text-muted-foreground">{initials(name)}</span> : <ImageOff className="size-12 text-muted-foreground" />}
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <h2 className="mb-4 mt-2 text-4xl font-bold sm:text-5xl">{name}</h2>
                {isLoading && (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-full max-w-xl" />
                    <Skeleton className="h-4 w-full max-w-xl" />
                    <Skeleton className="h-4 w-5/6 max-w-xl" />
                  </div>
                )}
                {isError && !person && <p className="text-sm text-muted-foreground">Could not load this person. <button type="button" onClick={() => void refetch()} className="underline">Retry</button></p>}
                {person?.overview && (
                  <div className="mb-4">
                    <p className={cx("text-base", !expanded && "line-clamp-5")}>{person.overview}</p>
                    <button type="button" onClick={() => setExpanded(!expanded)} className="text-sm font-medium text-blue-300 hover:underline">{expanded ? "Show less" : "Show more"}</button>
                  </div>
                )}
                {person?.born && <Fact label="Born" value={longDate(person.born)} />}
                {person?.died && <Fact label="Died" value={longDate(person.died)} />}
                {person?.birthplace && <Fact label="Birth Place" value={person.birthplace} />}
                {cast.role && <Fact label="In this title" value={cast.role} />}
              </div>
            </div>
            {isLoading ? <TimelineSkeleton /> : person && <Filmography userUUID={userUUID} profile={profile} person={person} activeTab={activeTab} onOpen={(row) => onOpenTitle({ item: row.id })} />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

