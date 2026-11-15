// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
// Timezone choices for the configure UI. Values are IANA zone names.

export interface TimezoneOption {
  value: string;
  label: string;
}

// Obsolete IANA aliases that some browsers still list, mapped to the current
// zone name. The picker offers and saves only the current name.
const legacyTimezoneAliases: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Ponape': 'Pacific/Pohnpei',
};

/** The current IANA name for a zone, replacing a known obsolete alias. */
export function canonicalTimezone(zone: string): string {
  return Object.prototype.hasOwnProperty.call(legacyTimezoneAliases, zone)
    ? legacyTimezoneAliases[zone]
    : zone;
}

// Used when the browser cannot list its zones (Intl.supportedValuesOf missing).
// Current IANA names only.
const fallbackTimezones = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Ho_Chi_Minh',
  'Asia/Jakarta',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

function listRuntimeTimezones(): string[] {
  // The project's TS lib (ES2020) does not declare supportedValuesOf yet.
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  if (typeof intl.supportedValuesOf !== 'function') return fallbackTimezones;
  try {
    const zones = intl.supportedValuesOf('timeZone');
    return Array.isArray(zones) && zones.length > 0 ? zones : fallbackTimezones;
  } catch {
    return fallbackTimezones;
  }
}

/**
 * Readable label for an IANA zone: the city with underscores as spaces,
 * followed by its region, e.g. "Asia/Ho_Chi_Minh" -> "Ho Chi Minh, Asia" and
 * "America/Argentina/Buenos_Aires" -> "Buenos Aires, Argentina, America".
 */
export function formatTimezoneLabel(zone: string): string {
  const parts = zone.split('/').map(part => part.replace(/_/g, ' '));
  if (parts.length < 2) return parts[0];
  const city = parts[parts.length - 1];
  const region = parts.slice(0, -1).reverse().join(', ');
  return `${city}, ${region}`;
}

function buildTimezoneOptions(): TimezoneOption[] {
  // Aliases collapse onto their current name, so each zone is listed once.
  const zones = new Set(listRuntimeTimezones().map(canonicalTimezone));
  zones.delete('UTC');
  const options = Array.from(zones)
    .map(zone => ({ value: zone, label: formatTimezoneLabel(zone) }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  // UTC is the picker's default, so always offer it and keep it on top.
  return [{ value: 'UTC', label: 'UTC' }, ...options];
}

export const timezoneOptions: TimezoneOption[] = buildTimezoneOptions();

/**
 * The options to show for a given saved value. A zone missing from the
 * generated list (older browser, or saved elsewhere) is added so the picker
 * still shows and keeps it. An obsolete alias is matched by its current name.
 */
export function timezoneOptionsWith(selected: string | undefined): TimezoneOption[] {
  if (selected) selected = canonicalTimezone(selected);
  if (!selected || timezoneOptions.some(opt => opt.value === selected)) return timezoneOptions;
  return [{ value: selected, label: formatTimezoneLabel(selected) }, ...timezoneOptions];
}
