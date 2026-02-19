const TMDB_DISCOVER_DATE_TOKEN_PREFIX = '__tmdb_date__';

const RELATIVE_DATE_PRESET_KEYS = new Set([
  'today',
  'last_month',
  'last_year',
  'last_5_years',
  'last_10_years'
]);

const TMDB_DYNAMIC_DATE_FIELDS = new Set([
  'release_date.lte',
  'primary_release_date.gte',
  'primary_release_date.lte',
  'first_air_date.gte',
  'first_air_date.lte'
]);
const DATE_TOKEN_PATTERN = new RegExp(
  `^${TMDB_DISCOVER_DATE_TOKEN_PREFIX}:(today|last_month|last_year|last_5_years|last_10_years):(from|to)$`
);

function parseDateToken(value) {
  if (typeof value !== 'string') return null;

  const tokenMatch = value.match(DATE_TOKEN_PATTERN);

  if (!tokenMatch) return null;

  return {
    preset: tokenMatch[1],
    bound: tokenMatch[2]
  };
}

function getDatePartsInTimezone(date, timezone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
  } catch (_error) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
  }

  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error('Could not parse timezone-adjusted date parts.');
  }

  return { year, month, day };
}

function formatUtcDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDateRangeFromRelativePreset(preset, timezone, nowInput) {
  const now = nowInput instanceof Date ? nowInput : new Date();
  const { year, month, day } = getDatePartsInTimezone(now, timezone || 'UTC');
  const toDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const fromDate = new Date(toDate.getTime());

  switch (preset) {
    case 'today':
      break;
    case 'last_month':
      fromDate.setUTCDate(fromDate.getUTCDate() - 30);
      break;
    case 'last_year':
      fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 1);
      break;
    case 'last_5_years':
      fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 5);
      break;
    case 'last_10_years':
      fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 10);
      break;
    default:
      return null;
  }

  return {
    from: formatUtcDate(fromDate),
    to: formatUtcDate(toDate)
  };
}

function resolveDynamicTmdbDiscoverParams(rawParams, options = {}) {
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return {};
  }

  const timezone = options.timezone || 'UTC';
  const now = options.now instanceof Date ? options.now : new Date();
  const resolved = { ...rawParams };

  for (const [key, value] of Object.entries(rawParams)) {
    if (!TMDB_DYNAMIC_DATE_FIELDS.has(key)) continue;

    const token = parseDateToken(value);
    if (!token) continue;
    if (!RELATIVE_DATE_PRESET_KEYS.has(token.preset)) continue;

    const range = getDateRangeFromRelativePreset(token.preset, timezone, now);
    if (!range) continue;

    resolved[key] = token.bound === 'from' ? range.from : range.to;
  }

  return resolved;
}

module.exports = {
  TMDB_DISCOVER_DATE_TOKEN_PREFIX,
  RELATIVE_DATE_PRESET_KEYS,
  TMDB_DYNAMIC_DATE_FIELDS,
  parseDateToken,
  getDateRangeFromRelativePreset,
  resolveDynamicTmdbDiscoverParams
};
