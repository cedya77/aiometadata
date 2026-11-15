// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export interface IdMap {
  imdbId: string;
  tmdbId: string;
  tvdbId: string;
  tvmazeId?: string;
}

export type IdField = 'imdbId' | 'tmdbId' | 'tvdbId' | 'tvmazeId';

const ID_FIELDS: IdField[] = ['imdbId', 'tmdbId', 'tvdbId', 'tvmazeId'];

// Ids are stored as uint32 per row; 0 means missing.
export interface MappingColumns {
  count: number;
  imdbId: Uint32Array;
  tmdbId: Uint32Array;
  tvdbId: Uint32Array;
  tvmazeId: Uint32Array | null;
}

export interface ParsedMappings extends MappingColumns {
  invalid: number;
}

export interface SortedIds {
  ids: Uint32Array;
  rows: Uint32Array;
}

export interface IndexStats {
  primaryRows: number;
  backfilledRows: number;
  totalRows: number;
  filled: Record<IdField, number>;
  conflicts: number;
}

export interface MappingIndex extends MappingColumns {
  byId: Record<IdField, SortedIds | null>;
  stats: IndexStats;
}

const HEADER_ALIASES: Record<string, IdField> = {
  imdb_id: 'imdbId', imdbId: 'imdbId',
  tmdb_id: 'tmdbId', tmdbId: 'tmdbId',
  tvdb_id: 'tvdbId', tvdbId: 'tvdbId',
  tvmaze_id: 'tvmazeId', tvmazeId: 'tvmazeId',
};

const MAX_ID = 0xffffffff;

const formatImdb = (id: number) => `tt${String(id).padStart(7, '0')}`;

const formatId = (field: IdField, id: number) => (!id ? '' : field === 'imdbId' ? formatImdb(id) : String(id));

// Returns -1 for anything that can't round-trip through a uint32.
function encodeId(field: IdField, value: string): number {
  let digits = value;
  if (field === 'imdbId') {
    if (!value.startsWith('tt')) return -1;
    digits = value.slice(2);
  } else if (field === 'tvmazeId') {
    digits = value.split('/', 1)[0];
  }
  if (!/^\d+$/.test(digits)) return -1;
  const id = Number(digits);
  if (id === 0 || id > MAX_ID) return -1;
  if (field === 'imdbId' && formatImdb(id) !== value) return -1;
  return id;
}

function allocateColumns(capacity: number, withTvmaze: boolean): MappingColumns {
  return {
    count: 0,
    imdbId: new Uint32Array(capacity),
    tmdbId: new Uint32Array(capacity),
    tvdbId: new Uint32Array(capacity),
    tvmazeId: withTvmaze ? new Uint32Array(capacity) : null,
  };
}

function trimColumns(columns: MappingColumns): MappingColumns {
  const { count } = columns;
  return {
    count,
    imdbId: columns.imdbId.slice(0, count),
    tmdbId: columns.tmdbId.slice(0, count),
    tvdbId: columns.tvdbId.slice(0, count),
    tvmazeId: columns.tvmazeId ? columns.tvmazeId.slice(0, count) : null,
  };
}

const valueAt = (columns: MappingColumns, field: IdField, row: number) => (columns[field] ? columns[field][row] : 0);

export function rowAt(columns: MappingColumns, row: number): IdMap {
  const ids: IdMap = {
    imdbId: formatId('imdbId', columns.imdbId[row]),
    tmdbId: formatId('tmdbId', columns.tmdbId[row]),
    tvdbId: formatId('tvdbId', columns.tvdbId[row]),
  };
  if (columns.tvmazeId) ids.tvmazeId = formatId('tvmazeId', columns.tvmazeId[row]);
  return ids;
}

export function parseMappingCsv(csv: string): ParsedMappings {
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  let position = 0;
  const readLine = (): string | null => {
    if (position >= text.length) return null;
    const newline = text.indexOf('\n', position);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(position, text.charCodeAt(end - 1) === 13 ? end - 1 : end);
    position = end + 1;
    return line;
  };

  const header = (readLine() ?? '').split(',').map((name) => HEADER_ALIASES[name.trim()]);
  if (!header.includes('imdbId')) throw new Error('Mapping CSV has no imdb column');

  let capacity = 1;
  for (let i = text.indexOf('\n', position); i !== -1; i = text.indexOf('\n', i + 1)) capacity++;
  const columns = allocateColumns(capacity, header.includes('tvmazeId'));

  let invalid = 0;
  for (let line = readLine(); line !== null; line = readLine()) {
    if (!line.trim()) continue;
    const values = line.split(',');
    const row = columns.count;
    let valid = values.length === header.length;
    let hasId = false;
    for (let column = 0; valid && column < header.length; column++) {
      const field = header[column];
      const value = values[column].trim();
      if (!field || !value) continue;
      const id = encodeId(field, value);
      if (id < 0) valid = false;
      else {
        columns[field][row] = id;
        hasId = true;
      }
    }
    if (valid && hasId) {
      columns.count++;
      continue;
    }
    invalid++;
    for (const field of ID_FIELDS) if (columns[field]) columns[field][row] = 0;
  }

  return { ...trimColumns(columns), invalid };
}

function sortIds(owners: Map<number, number>): SortedIds {
  const ids = Uint32Array.from(owners.keys()).sort();
  const rows = new Uint32Array(ids.length);
  for (let i = 0; i < ids.length; i++) rows[i] = owners.get(ids[i]);
  return { ids, rows };
}

// `fillable` lists the fields a backfill row may write into an existing primary row.
export function buildIndex(primary: MappingColumns, backfill: MappingColumns, withTvmaze: boolean, fillable: IdField[]): MappingIndex {
  const fields: IdField[] = withTvmaze ? ID_FIELDS : ['imdbId', 'tmdbId', 'tvdbId'];
  const columns = allocateColumns(primary.count + backfill.count, withTvmaze);
  const owners = {} as Record<IdField, Map<number, number>>;
  for (const field of fields) owners[field] = new Map();
  const stats: IndexStats = { primaryRows: 0, backfilledRows: 0, totalRows: 0, filled: { imdbId: 0, tmdbId: 0, tvdbId: 0, tvmazeId: 0 }, conflicts: 0 };

  for (let source = 0; source < primary.count; source++) {
    const row = columns.count;
    let indexed = false;
    for (const field of fields) {
      const id = valueAt(primary, field, source);
      if (!id) continue;
      columns[field][row] = id;
      if (!owners[field].has(id)) {
        owners[field].set(id, row);
        indexed = true;
      }
    }
    if (indexed) columns.count++;
    else for (const field of fields) columns[field][row] = 0;
  }
  stats.primaryRows = columns.count;

  for (let source = 0; source < backfill.count; source++) {
    let target = -1;
    let matches = 0;
    for (const field of fields) {
      const id = valueAt(backfill, field, source);
      const owner = id ? owners[field].get(id) : undefined;
      if (owner === undefined || owner === target) continue;
      target = owner;
      matches++;
    }

    if (matches === 0) {
      const row = columns.count;
      let hasId = false;
      for (const field of fields) {
        const id = valueAt(backfill, field, source);
        if (!id) continue;
        columns[field][row] = id;
        owners[field].set(id, row);
        hasId = true;
      }
      if (hasId) {
        columns.count++;
        stats.backfilledRows++;
      }
      continue;
    }

    const disagrees = fields.some((field) => {
      const id = valueAt(backfill, field, source);
      const current = columns[field][target];
      return id && current && id !== current;
    });
    if (matches > 1 || disagrees) {
      stats.conflicts++;
      continue;
    }

    // Any id owned by another row would have been a second match, so empty fields are safe to fill.
    for (const field of fillable) {
      if (!fields.includes(field)) continue;
      const id = valueAt(backfill, field, source);
      if (id && !columns[field][target]) {
        columns[field][target] = id;
        owners[field].set(id, target);
        stats.filled[field]++;
      }
    }
  }

  stats.totalRows = columns.count;
  return {
    ...trimColumns(columns),
    byId: {
      imdbId: sortIds(owners.imdbId),
      tmdbId: sortIds(owners.tmdbId),
      tvdbId: sortIds(owners.tvdbId),
      tvmazeId: withTvmaze ? sortIds(owners.tvmazeId) : null,
    },
    stats,
  };
}

export function lookup(index: MappingIndex, field: IdField, value: string): IdMap | undefined {
  const sorted = index.byId[field];
  if (!sorted) return undefined;
  const id = field === 'imdbId' ? encodeId('imdbId', String(value)) : parseInt(value);
  if (!(id > 0)) return undefined;
  const { ids, rows } = sorted;
  let low = 0;
  let high = ids.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (ids[middle] === id) return rowAt(index, rows[middle]);
    if (ids[middle] < id) low = middle + 1;
    else high = middle - 1;
  }
  return undefined;
}
