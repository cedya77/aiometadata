export type Ref = { season: number; episode: number };
export type OurEpisode = { number: number; name: string | null; airsAt: number | null };
export type TheirEpisode = { season: number; number: number; title: string | null; airedAt: number | null; norm: string; words: Set<string> };
export type Status = "same" | "part" | "close" | "shift" | "number" | "missing" | "none" | "later" | "chosen";
export type Row = { key: string; ours: OurEpisode; target: TheirEpisode | null; status: Status; part: number };
export type SeasonPlan = { season: number; theirs: number; rows: Row[] };

export const LOOK: ReadonlySet<Status> = new Set(["close", "shift", "missing"]);
export const GUESSED: ReadonlySet<Status> = new Set(["close", "shift", "missing", "number"]);
const STOP = new Set(["the", "a", "an", "and", "of"]);
export const keyOf = (season: number, episode: number) => `${season}:${episode}`;

export function norm(title: string | null | undefined): string {
  return String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\((?:\d+|part \d+|pt\.? ?\d+)\)/g, " ")
    .replace(/[,:-]?\s*(?:part|pt\.?)\s*(?:\d+|one|two|three|i{1,3})\s*$/, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(?:the|a|an) /, "");
}

const generic = (normed: string) => !normed || /^(?:episode|ep|chapter)? ?\d+$|^(?:tba|tbd)$/.test(normed);
export const wordsOf = (normed: string) => new Set(normed.split(" ").filter((word) => word && !STOP.has(word)));

function closeness(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function planSeason(season: number, episodes: OurEpisode[], theirs: TheirEpisode[], numbers: number[], prefer: number | undefined, chosen: Record<string, Ref | null>, held: Record<string, Ref | null> | null, now: number): SeasonPlan {
  const find = (ref: Ref | null) => (ref ? theirs.find((t) => t.season === ref.season && t.number === ref.episode) ?? null : null);
  const named = episodes.map((episode) => ({ episode, normed: norm(episode.name) }));
  let linked = prefer;
  if (linked === undefined) {
    const votes = new Map<number, number>();
    for (const { normed } of named) {
      if (generic(normed)) continue;
      for (const t of theirs) if (t.norm === normed) votes.set(t.season, (votes.get(t.season) ?? 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0] - season) - Math.abs(b[0] - season))[0];
    linked = best ? best[0] : numbers.includes(season) ? season : numbers[0] ?? season;
  }
  const inLinked = theirs.filter((t) => t.season === linked);
  const byNumber = new Map(inLinked.map((t) => [t.number, t]));
  const titled = (list: TheirEpisode[]) => {
    const out = new Map<string, TheirEpisode[]>();
    for (const t of list) out.set(t.norm, [...(out.get(t.norm) ?? []), t]);
    return out;
  };
  const ownTitles = titled(inLinked);
  const allTitles = titled(theirs);
  const rows: Row[] = [];
  const claimed = new Set<TheirEpisode>();
  const raw = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();
  let last: { ours: number; target: TheirEpisode } | null = null;
  for (const { episode, normed } of named) {
    const key = keyOf(season, episode.number);
    let target: TheirEpisode | null = null;
    let status: Status;
    const expected: Ref = last ? { season: last.target.season, episode: last.target.number + (episode.number - last.ours) } : { season: linked, episode: episode.number };
    if (key in chosen) {
      target = find(chosen[key]);
      status = chosen[key] ? "chosen" : "none";
    } else if (held && key in held && prefer === undefined) {
      target = find(held[key]);
      status = held[key] ? (target && target.norm === normed ? "same" : "chosen") : "none";
    } else {
      const own = generic(normed) ? [] : ownTitles.get(normed) ?? [];
      const elsewhere = own.length || generic(normed) || prefer !== undefined ? [] : allTitles.get(normed) ?? [];
      const nearest = (list: TheirEpisode[]) => [...list].sort((a, b) => Math.abs(a.number - expected.episode) - Math.abs(b.number - expected.episode))[0] ?? null;
      const free = own.filter((t) => !claimed.has(t));
      const exact = own.length
        ? free.find((t) => raw(t.title) === raw(episode.name)) ?? nearest(free) ?? nearest(own)
        : elsewhere.length === 1 ? elsewhere[0] : null;
      if (exact) {
        target = exact;
        status = "same";
      } else {
        const words = wordsOf(normed);
        const near = generic(normed) || expected.season !== linked ? null : [-3, -2, -1, 0, 1, 2, 3]
          .map((step) => byNumber.get(expected.episode + step))
          .filter((t): t is TheirEpisode => Boolean(t))
          .map((t) => ({ t, score: closeness(words, t.words), gap: Math.abs(t.number - expected.episode) }))
          .filter((entry) => entry.score >= 0.6)
          .sort((a, b) => b.score - a.score || a.gap - b.gap)[0];
        const shifted = find(expected);
        if (near) {
          target = near.t;
          status = "close";
        } else if (shifted) {
          target = shifted;
          status = generic(normed) || generic(shifted.norm) ? "number" : "shift";
        } else {
          status = episode.airsAt === null || episode.airsAt > now ? "later" : "missing";
        }
      }
    }
    if (target) {
      last = { ours: episode.number, target };
      claimed.add(target);
    }
    rows.push({ key, ours: episode, target, status, part: 0 });
  }
  if (prefer === undefined && !rows.some((row) => row.status === "same" || row.status === "close")) {
    for (const row of rows) if (row.status === "shift") row.status = "number";
  }
  const sharing = new Map<string, Row[]>();
  for (const row of rows) if (row.target) sharing.set(keyOf(row.target.season, row.target.number), [...(sharing.get(keyOf(row.target.season, row.target.number)) ?? []), row]);
  for (const group of sharing.values()) {
    if (group.length < 2) continue;
    group.forEach((row, index) => {
      row.part = index + 1;
      if (row.status === "same") row.status = "part";
    });
  }
  return { season, theirs: linked, rows };
}

export function strayEpisodes(plans: SeasonPlan[], theirs: TheirEpisode[], now: number): Map<number, TheirEpisode[]> {
  const used = new Set<TheirEpisode>();
  const top = new Map<number, number>();
  for (const plan of plans) {
    for (const row of plan.rows) {
      if (!row.target) continue;
      used.add(row.target);
      top.set(row.target.season, Math.max(top.get(row.target.season) ?? 0, row.target.number));
    }
  }
  const out = new Map<number, TheirEpisode[]>();
  for (const season of new Set(plans.map((plan) => plan.theirs))) {
    out.set(season, theirs.filter((t) => t.season === season && !used.has(t) && (t.number <= (top.get(season) ?? 0) || (t.airedAt !== null && t.airedAt <= now))));
  }
  return out;
}
