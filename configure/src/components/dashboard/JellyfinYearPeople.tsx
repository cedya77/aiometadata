import { lazy, Suspense, useMemo, type CSSProperties } from "react";
import type { JellyfinYearPeople, JellyfinYearTitle } from "@/hooks/useDashboardQueries";
import { ChapterHeader, Deck, PersonLink, TitleLink, TitleList, YEAR_GLASS } from "./JellyfinYearShared";
import { sizedArt } from "./art";
import type { YearChapterProps } from "./yearChapters";
import { displayName, type YearModel } from "./yearModel";

const Globe = lazy(() => import("./JellyfinYearGlobe"));

const GENRES = 7;
const COUNTRIES = 5;
const MORE_COUNTRIES = 5;
const NETWORK_LOGO: CSSProperties = { filter: "brightness(0) invert(1)" };
const COUNTRY_ALIASES: Record<string, string> = {
  "united states of america": "US",
  usa: "US",
  uk: "GB",
  "great britain": "GB",
  "republic of korea": "KR",
  "korea, republic of": "KR",
  korea: "KR",
  "russian federation": "RU",
  "czech republic": "CZ",
  "viet nam": "VN",
  "iran, islamic republic of": "IR",
  "taiwan, province of china": "TW",
};

const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

function listed(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const codeOf = (name: string): string | undefined => countryCodes().get(name.toLowerCase());

const countryCodes = (() => {
  let codes: Map<string, string> | null = null;
  return (): Map<string, string> => {
    if (codes) return codes;
    codes = new Map(Object.entries(COUNTRY_ALIASES));
    try {
      const english = new Intl.DisplayNames(["en"], { type: "region" });
      for (let a = 65; a <= 90; a += 1) {
        for (let b = 65; b <= 90; b += 1) {
          const code = String.fromCharCode(a, b);
          const name = english.of(code);
          if (name && name !== code && !codes.has(name.toLowerCase())) codes.set(name.toLowerCase(), code);
        }
      }
    } catch {
      return codes;
    }
    return codes;
  };
})();

let regionNames: Intl.DisplayNames | null = null;

function regionName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(undefined, { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

function Face({ src, className = "" }: { src: string | null; className?: string }) {
  return src
    ? <img src={sizedArt(src, 185) ?? src} alt="" loading="lazy" className={`block object-cover ${className}`} />
    : <div className={`bg-gradient-to-br from-zinc-600 to-zinc-800 ${className}`} />;
}

function CastGrid({ people }: { people: JellyfinYearPeople }) {
  if (!people.cast.length) return null;
  return (
    <div className="mt-10">
      <Deck columns="lg:grid-cols-4">
        {people.cast.map((person, i) => (
          <div key={person.id} className={`${YEAR_GLASS} flex min-w-0 flex-col gap-3.5 rounded-3xl p-5`}>
            <PersonLink person={person} className="group flex items-center gap-3.5">
              <div className="relative shrink-0">
                <Face src={person.photo} className="h-[76px] w-[76px] rounded-full shadow-[0_0_0_3px_rgba(255,255,255,0.1)] transition-shadow group-hover:shadow-[0_0_0_3px_rgba(255,255,255,0.35)]" />
                <span className={`absolute -bottom-0.5 -right-1 flex h-[26px] min-w-[26px] items-center justify-center rounded-full px-1.5 text-[13px] font-extrabold text-[#0c0d0f] shadow-[0_0_0_3px_#17181b] ${i === 0 ? "bg-amber-400" : "bg-blue-300"}`}>{person.titles}</span>
              </div>
              <div className="min-w-0">
                <p className="text-base font-bold leading-tight decoration-white/35 underline-offset-4 group-hover:underline">{person.name}</p>
                <p className="mt-[3px] text-xs text-muted-foreground">{person.voiced ? `Voiced ${plural(person.titles, "of your shows", "of your shows")}` : `In ${plural(person.titles, "of your titles", "of your titles")}`}</p>
              </div>
            </PersonLink>
            <p className="text-xs leading-[1.5] text-foreground/80"><TitleList titles={person.shown} nameOf={(title) => title.name} separator=", " /></p>
          </div>
        ))}
      </Deck>
    </div>
  );
}

function Pairings({ people }: { people: JellyfinYearPeople }) {
  const { together, link } = people;
  if (!together && !link) return null;
  const kicker = "text-[11px] font-bold uppercase tracking-[0.14em] text-amber-400";
  return (
    <div className="mt-5 flex flex-wrap gap-5">
      {together && (
        <div className={`${YEAR_GLASS} flex min-w-0 flex-[1_1_360px] items-center gap-[18px] rounded-3xl p-6`}>
          <div className="flex shrink-0">
            <PersonLink person={together.people[0]} className="block rounded-full"><Face src={together.people[0].photo} className="h-14 w-14 rounded-full shadow-[0_0_0_3px_#17181b]" /></PersonLink>
            <PersonLink person={together.people[1]} className="-ml-4 block rounded-full"><Face src={together.people[1].photo} className="h-14 w-14 rounded-full shadow-[0_0_0_3px_#17181b]" /></PersonLink>
          </div>
          <div className="min-w-0">
            <p className={kicker}>On screen together</p>
            <p className="mt-1.5 text-[15px] leading-[1.45]"><PersonLink person={together.people[0]}>{together.people[0].name}</PersonLink> and <PersonLink person={together.people[1]}>{together.people[1].name}</PersonLink> shared <span className="font-bold">{plural(together.films, "of your films", "of your films")}</span>.</p>
          </div>
        </div>
      )}
      {link && (
        <div className={`${YEAR_GLASS} flex min-w-0 flex-[1_1_360px] items-center gap-[18px] rounded-3xl p-6`}>
          <div className="flex shrink-0 items-center gap-1.5">
            {link.show.poster && <TitleLink title={link.show} name={link.show.name} className="block"><img src={sizedArt(link.show.poster, 185) ?? link.show.poster} alt="" loading="lazy" className="aspect-[2/3] w-9 rounded-md object-cover" /></TitleLink>}
            <PersonLink person={link} className="block rounded-full"><Face src={link.photo} className="h-12 w-12 rounded-full" /></PersonLink>
            {link.films[0]?.poster && <TitleLink title={link.films[0]} name={link.films[0].name} className="block"><img src={sizedArt(link.films[0].poster, 185) ?? link.films[0].poster} alt="" loading="lazy" className="aspect-[2/3] w-9 rounded-md object-cover" /></TitleLink>}
          </div>
          <div className="min-w-0">
            <p className={kicker}>The link</p>
            <p className="mt-1.5 text-[15px] leading-[1.45]"><PersonLink person={link}>{link.name}</PersonLink> connected <TitleLink title={link.show}>{link.show.name}</TitleLink> to <TitleList titles={link.films.slice(0, 2)} nameOf={(film) => film.name} separator=" and " />.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Directors({ people }: { people: JellyfinYearPeople }) {
  if (!people.directors.length) return null;
  return (
    <>
      <h3 className="mb-[18px] mt-14 text-[22px] font-bold tracking-[-0.02em]">Behind the camera</h3>
      <div className="flex flex-wrap gap-4">
        {people.directors.map((director) => (
          <PersonLink key={director.id} person={director} className={`${YEAR_GLASS} group flex min-w-0 flex-[1_1_240px] items-center gap-3.5 rounded-[20px] py-3.5 pl-3.5 pr-[18px] transition-colors hover:bg-white/[0.08]`}>
            <Face src={director.photo} className="h-[52px] w-[52px] shrink-0 rounded-[14px]" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold decoration-white/35 underline-offset-4 group-hover:underline">{director.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Directed {plural(director.films, "of your films", "of your films")}</p>
            </div>
            <span className="text-[30px] font-extrabold tracking-[-0.04em] text-blue-400">{director.films}</span>
          </PersonLink>
        ))}
      </div>
    </>
  );
}

function Genres({ model }: { model: YearModel }) {
  const rows = useMemo(() => {
    const plays = new Map<string, number>();
    let total = 0;
    for (const title of model.data.titles) {
      total += title.plays.length;
      for (const genre of new Set(title.facts?.genres ?? [])) plays.set(genre, (plays.get(genre) ?? 0) + title.plays.length);
    }
    return [...plays].sort((a, b) => b[1] - a[1]).slice(0, GENRES).map(([name, n]) => [name, total ? Math.round((n / total) * 100) : 0] as const);
  }, [model]);
  if (!rows.length) return null;
  return (
    <div className={`${YEAR_GLASS} min-w-0 flex-[1_1_520px] rounded-3xl p-5 sm:p-7`}>
      <h3 className="text-[15px] font-semibold">Genres in your plays</h3>
      <p className="mt-1 text-xs text-muted-foreground">Share of plays that carried each genre. A title can carry several.</p>
      <div className="mt-[22px] flex flex-col gap-3.5">
        {rows.map(([name, pct], i) => (
          <div key={name} className="grid grid-cols-[110px_minmax(0,1fr)_44px] items-center gap-3.5 sm:grid-cols-[150px_minmax(0,1fr)_44px]">
            <span className="truncate text-sm font-medium">{name}</span>
            <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.07]">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: i === 0 ? "linear-gradient(90deg,#2563eb,#60a5fa)" : `rgba(147,197,253,${(0.75 - i * 0.08).toFixed(2)})` }} />
            </div>
            <span className="text-right text-[13px] tabular-nums text-foreground/80">{pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Themes({ people }: { people: JellyfinYearPeople }) {
  const { themes, books, manga } = people;
  if (!themes.length) return null;
  const most = themes[0][1];
  const least = themes[themes.length - 1][1];
  return (
    <div className={`${YEAR_GLASS} min-w-0 flex-[1_1_400px] rounded-3xl p-5 sm:p-7`}>
      <h3 className="text-[15px] font-semibold">What your year was about</h3>
      <p className="mt-1 text-xs text-muted-foreground">The themes tagged on your titles, sized by how many carried them.</p>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {themes.map(([name, n], i) => {
          const size = 12 + Math.round(((n - least) / Math.max(1, most - least)) * 18);
          return (
            <span key={name} className={`inline-flex items-center rounded-full ${i ? "bg-white/[0.07]" : "bg-blue-400/[0.22]"} ${n >= most * 0.4 ? "font-bold" : "font-medium"} ${n >= most * 0.33 ? "text-foreground" : "text-foreground/80"}`} style={{ fontSize: size, padding: `${Math.round(size * 0.35)}px ${Math.round(size * 0.8)}px` }}>{name}</span>
          );
        })}
      </div>
      {(books > 0 || manga > 0) && (
        <p className="mt-5 text-sm text-foreground/80">
          {books > 0 && <><span className="font-bold text-foreground">{plural(books, "title")}</span> started life as a book.</>}
          {manga > 0 && ` ${manga.toLocaleString()} ${manga === 1 ? "was" : "were"} manga first.`}
        </p>
      )}
    </div>
  );
}

function Networks({ people }: { people: JellyfinYearPeople }) {
  if (!people.networks.length) return null;
  return (
    <>
      <h3 className="mb-1.5 mt-14 text-[22px] font-bold tracking-[-0.02em]">Where it aired</h3>
      <p className="mb-[18px] text-[13px] text-muted-foreground">Plays by the network or service that first aired each show.</p>
      <div className="grid auto-rows-[88px] grid-cols-3 gap-3 sm:auto-rows-[104px] sm:grid-cols-6">
        {people.networks.map((network, i) => (
          <div key={network.name} className={`${YEAR_GLASS} relative flex items-center justify-center rounded-[20px] ${i === 0 ? "col-span-2 row-span-2" : i < 3 ? "sm:col-span-2" : ""}`} style={i === 0 ? { background: "linear-gradient(135deg,rgba(96,165,250,0.18),rgba(255,255,255,0.04))" } : undefined}>
            {network.logo
              ? <img src={network.logo} alt={network.name} loading="lazy" className={`object-contain ${i === 0 ? "max-h-24 max-w-[55%]" : "max-h-[34px] max-w-[58%] opacity-85"}`} style={NETWORK_LOGO} />
              : <span className={`px-3 text-center font-bold ${i === 0 ? "text-2xl" : "text-sm"}`}>{network.name}</span>}
            <span className="absolute bottom-2.5 left-3.5 text-xs tabular-nums text-muted-foreground">{plural(network.plays, "play")}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Countries({ titles }: { titles: JellyfinYearTitle[] }) {
  const { rows, more, languages, shading } = useMemo(() => {
    const codes = countryCodes();
    const counts = new Map<string, number>();
    const spoken = new Set<string>();
    for (const title of titles) {
      if (title.facts?.language) spoken.add(title.facts.language);
      const found = new Set((title.facts?.countries ?? []).map((name) => codes.get(name.toLowerCase())).filter((code): code is string => !!code));
      for (const code of found) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    const shading = new Map(ranked.map(([code], rank) => [code, { rank, shaded: rank < COUNTRIES }]));
    return { rows: ranked.slice(0, COUNTRIES), more: ranked.slice(COUNTRIES), languages: spoken.size, shading };
  }, [titles]);
  if (!rows.length) return null;
  const top = rows[0][1];
  return (
    <div className={`${YEAR_GLASS} min-w-0 flex-[1_1_560px] rounded-3xl p-5 sm:p-7`}>
      <h3 className="text-[15px] font-semibold">Around the world</h3>
      <p className="mt-1 text-xs text-muted-foreground">Titles by country of origin{languages > 1 ? ` · ${languages} original languages` : ""}</p>
      <div className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-5">
        <div className="mx-auto shrink-0 sm:mx-0">
          <Suspense fallback={<div className="h-[220px] w-[220px] rounded-full bg-white/[0.04]" />}>
            <Globe countries={shading} codeOf={codeOf} />
          </Suspense>
        </div>
        <div className="flex min-w-[240px] flex-1 flex-col gap-3">
          {rows.map(([code, n], i) => (
            <div key={code} className="grid grid-cols-[28px_96px_minmax(0,1fr)_36px] items-center gap-3 sm:grid-cols-[34px_120px_minmax(0,1fr)_36px]">
              <span className="text-[11px] font-bold tracking-[0.08em] text-muted-foreground">{code}</span>
              <span className="truncate text-sm">{regionName(code)}</span>
              <div className="h-2 overflow-hidden rounded-full bg-white/[0.07]">
                <div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.round((n / top) * 100))}%`, background: i === 0 ? "#60a5fa" : i === 1 ? "#fbbf24" : "rgba(147,197,253,0.55)" }} />
              </div>
              <span className="text-right text-[13px] tabular-nums text-foreground/80">{n}</span>
            </div>
          ))}
        </div>
      </div>
      {more.length > 0 && <p className="mt-[18px] text-[13px] text-muted-foreground">Plus {listed([...more.slice(0, MORE_COUNTRIES).map(([code]) => regionName(code)), ...(more.length > MORE_COUNTRIES ? ["more"] : [])])}.</p>}
    </div>
  );
}

function Decades({ titles }: { titles: JellyfinYearTitle[] }) {
  const { decades, median } = useMemo(() => {
    const groups = new Map<number, JellyfinYearTitle[]>();
    const years: number[] = [];
    for (const title of titles) {
      const year = title.facts?.year;
      if (!year) continue;
      years.push(year);
      const decade = Math.floor(year / 10) * 10;
      groups.set(decade, [...(groups.get(decade) ?? []), title]);
    }
    years.sort((a, b) => a - b);
    const list = [...groups].sort((a, b) => a[0] - b[0]).map(([decade, members]) => ({
      decade,
      count: members.length,
      pin: [...members].filter((title) => title.facts?.poster).sort((a, b) => b.plays.length - a.plays.length || b.watchMs - a.watchMs)[0] ?? null,
    }));
    return { decades: list, median: years.length ? years[Math.floor((years.length - 1) / 2)] : null };
  }, [titles]);
  if (!decades.length) return null;
  const most = Math.max(...decades.map((entry) => entry.count));
  const latest = decades[decades.length - 1].decade;
  return (
    <div className={`${YEAR_GLASS} min-w-0 flex-[2_1_560px] rounded-3xl p-5 sm:p-7`}>
      <h3 className="text-[15px] font-semibold">Across the decades</h3>
      <p className="mt-1 text-xs text-muted-foreground">When your titles first came out{median ? ` · half were from ${median} or later` : ""}</p>
      <div className="mt-5 flex h-[250px] items-end gap-2 sm:gap-3.5">
        {decades.map(({ decade, count, pin }) => (
          <div key={decade} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2">
            {pin?.facts?.poster && <TitleLink title={pin} name={displayName(pin)} className="block w-full max-w-16 transition-transform hover:-translate-y-0.5"><img src={sizedArt(pin.facts.poster, 185) ?? pin.facts.poster} alt="" loading="lazy" className="block aspect-[2/3] w-full rounded-lg object-cover shadow-[0_12px_24px_-10px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.12)]" /></TitleLink>}
            {pin && <TitleLink title={pin} name={displayName(pin)} className="max-w-full truncate text-center text-[10px] text-muted-foreground decoration-white/35 underline-offset-4 hover:text-foreground hover:underline">{decade === latest ? displayName(pin) : `${displayName(pin)}, ${pin.facts?.year}`}</TitleLink>}
            <div className="w-full rounded-t-[10px] rounded-b-[4px]" style={{ height: Math.max(6, Math.round((count / most) * 96)), background: count === most ? "linear-gradient(180deg,#93c5fd,#2563eb)" : "rgba(255,255,255,0.14)" }} />
            <span className="text-[13px] font-semibold">{decade}s</span>
            <span className="-mt-1.5 text-[11px] text-muted-foreground">{plural(count, "title")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PeopleChapter({ model, number, label, accent }: YearChapterProps) {
  const people = model.data.people;
  const titles = model.data.titles;
  return (
    <>
      <ChapterHeader number={number} label={label} accent={accent} title="The faces of your year.">
        Read from the cast and crew of every title you played, not just the ones you finished.
      </ChapterHeader>
      {people && <CastGrid people={people} />}
      {people && <Pairings people={people} />}
      {people && <Directors people={people} />}
      <div className="mt-14 flex flex-wrap gap-5">
        <Genres model={model} />
        {people && <Themes people={people} />}
      </div>
      {people && <Networks people={people} />}
      <div className="mt-5 flex flex-wrap gap-5">
        <Countries titles={titles} />
        <Decades titles={titles} />
      </div>
    </>
  );
}
