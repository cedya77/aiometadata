// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export const MIN_ALIAS_LENGTH = 3;
export const MAX_ALIAS_LENGTH = 32;

export const ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESERVED_ALIASES = new Set([
  'api', 'anilist', 'background', 'bulk-delete-inactive', 'catalog', 'configure',
  'dashboard', 'export', 'health', 'logo', 'mal', 'manifest', 'meta', 'poster',
  'rating', 'stream', 'stremio', 'subtitles', 'user', 'users',
]);

export function looksLikeAlias(segment: string): boolean {
  if (typeof segment !== 'string') return false;
  if (!ALIAS_PATTERN.test(segment)) return false;
  return !UUID_PATTERN.test(segment);
}

export function normalizeAlias(raw: string): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export interface AliasValidation {
  valid: boolean;
  alias?: string;
  aliasLower?: string;
  reason?: string;
}

export function validateAlias(raw: unknown): AliasValidation {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { valid: false, reason: 'An alias is required.' };
  }

  const alias = raw.trim();

  if (alias.length < MIN_ALIAS_LENGTH || alias.length > MAX_ALIAS_LENGTH) {
    return { valid: false, reason: `Alias must be between ${MIN_ALIAS_LENGTH} and ${MAX_ALIAS_LENGTH} characters.` };
  }

  if (!ALIAS_PATTERN.test(alias)) {
    return { valid: false, reason: 'Alias may only contain letters, numbers, hyphens and underscores.' };
  }

  if (UUID_PATTERN.test(alias)) {
    return { valid: false, reason: 'Alias must not look like a UUID.' };
  }

  const aliasLower = alias.toLowerCase();

  if (RESERVED_ALIASES.has(aliasLower)) {
    return { valid: false, reason: `"${alias}" is a reserved word and cannot be used as an alias.` };
  }

  return { valid: true, alias, aliasLower };
}

export function parseAliasSeed(raw: string | undefined): {
  entries: Array<{ alias: string; userUUID: string }>;
  errors: string[];
} {
  const entries: Array<{ alias: string; userUUID: string }> = [];
  const errors: string[] = [];

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { entries, errors };
  }

  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) {
      errors.push('Empty entry in USER_ALIASES.');
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      errors.push(`Entry "${trimmed}" is missing "=" (expected alias=uuid).`);
      continue;
    }

    const validation = validateAlias(trimmed.slice(0, separator));
    if (!validation.valid) {
      errors.push(`Entry "${trimmed}": ${validation.reason}`);
      continue;
    }

    const userUUID = trimmed.slice(separator + 1).trim();
    if (!UUID_PATTERN.test(userUUID)) {
      errors.push(`Entry "${trimmed}": "${userUUID}" is not a valid UUID.`);
      continue;
    }

    entries.push({ alias: validation.alias, userUUID });
  }

  return { entries, errors };
}

module.exports = {
  MIN_ALIAS_LENGTH,
  MAX_ALIAS_LENGTH,
  ALIAS_PATTERN,
  looksLikeAlias,
  normalizeAlias,
  validateAlias,
  parseAliasSeed,
};
