import type { JellyfinYearTitle } from "@/hooks/useDashboardQueries";

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

export const codeOf = (name: string): string | undefined => countryCodes().get(name.toLowerCase());

let regionNames: Intl.DisplayNames | null = null;

export function regionName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(undefined, { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Countries of origin ranked by how many titles came from each, and how many original languages the titles span. */
export function yearPlaces(titles: JellyfinYearTitle[]): { ranked: Array<[code: string, titles: number]>; languages: number } {
  const counts = new Map<string, number>();
  const spoken = new Set<string>();
  for (const title of titles) {
    if (title.facts?.language) spoken.add(title.facts.language);
    const found = new Set((title.facts?.countries ?? []).map(codeOf).filter((code): code is string => !!code));
    for (const code of found) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return { ranked: [...counts].sort((a, b) => b[1] - a[1]), languages: spoken.size };
}
