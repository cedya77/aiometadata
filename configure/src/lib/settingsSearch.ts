import { SETTINGS_SECTIONS, type SettingsSection, type SettingsSectionId } from './settingsRoute';

export interface SettingsSearchEntry {
  id: string;
  section: SettingsSectionId;
  anchor: string | null;
  label: string;
  description: string;
  keywords?: string[];
  /** Shown only while this section is, for a setting that exists only with it. */
  requires?: SettingsSectionId;
}

export const MAX_RESULTS = 10;

const RANK_LABEL_PREFIX = 4;
const RANK_LABEL_SUBSTRING = 3;
const RANK_KEYWORD_EXACT = 2;
const RANK_DESCRIPTION = 1;
const RANK_NONE = 0;


function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function scoreToken(token: string, entry: SettingsSearchEntry): number {
  const label = normalise(entry.label);
  if (label.startsWith(token)) return RANK_LABEL_PREFIX;
  if (label.includes(token)) return RANK_LABEL_SUBSTRING;
  if (entry.keywords?.some((keyword) => normalise(keyword) === token)) {
    return RANK_KEYWORD_EXACT;
  }
  if (normalise(entry.description).includes(token)) return RANK_DESCRIPTION;
  return RANK_NONE;
}

export function searchSettings(
  query: string,
  entries: SettingsSearchEntry[],
  sections: SettingsSection[] = SETTINGS_SECTIONS
): SettingsSearchEntry[] {
  const tokens = normalise(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const order = new Map<string, number>(sections.map((section, index) => [section.id, index]));

  const scored: { entry: SettingsSearchEntry; rank: number }[] = [];

  for (const entry of entries) {
    if (!order.has(entry.section) || (entry.requires && !order.has(entry.requires))) continue;
    let best = RANK_NONE;
    let all = true;
    for (const token of tokens) {
      const rank = scoreToken(token, entry);
      // AND, not OR: "hide watched" must narrow rather than widen.
      if (rank === RANK_NONE) { all = false; break; }
      if (rank > best) best = rank;
    }
    if (all) scored.push({ entry, rank: best });
  }

  scored.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    const orderA = order.get(a.entry.section) ?? Number.MAX_SAFE_INTEGER;
    const orderB = order.get(b.entry.section) ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB;
  });

  return scored.slice(0, MAX_RESULTS).map((s) => s.entry);
}
