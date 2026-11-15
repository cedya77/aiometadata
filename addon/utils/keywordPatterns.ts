// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { LRUCache } from 'lru-cache';

/** TMDB keyword exclusions: a plain entry matches one keyword name, an entry with `*` is a pattern. */
export const KEYWORD_PATTERN_MAX_LENGTH = 100;
const MIN_LITERAL_CHARACTERS = 2;
const MAX_PATTERNS = 50;

export function isKeywordPattern(entry: string): boolean {
  return String(entry).includes('*');
}

/** Why a pattern can't be used, or null when it can. */
export function keywordPatternProblem(entry: string): string | null {
  const text = String(entry).trim();
  if (text.length > KEYWORD_PATTERN_MAX_LENGTH) return `Patterns are limited to ${KEYWORD_PATTERN_MAX_LENGTH} characters`;
  if ((text.match(/[\p{L}\p{N}]/gu) || []).length < MIN_LITERAL_CHARACTERS) return `A pattern needs at least ${MIN_LITERAL_CHARACTERS} letters or digits besides *`;
  return null;
}

/** `*` stands for any run of characters; the whole keyword name has to fit, ignoring case. */
export function keywordPatternRegex(entry: string): RegExp | null {
  if (!isKeywordPattern(entry) || keywordPatternProblem(entry)) return null;
  const body = String(entry).trim().toLowerCase().split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`);
}

export interface KeywordMatcher {
  size: number;
  matches: (keyword: unknown) => boolean;
}

const matchers = new LRUCache<string, KeywordMatcher>({ max: 500 });

export function keywordMatcher(entries: unknown[]): KeywordMatcher {
  const list = entries.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  const key = list.join('\n');
  const held = matchers.get(key);
  if (held) return held;
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  for (const entry of list) {
    if (!isKeywordPattern(entry)) {
      exact.add(entry.toLowerCase());
      continue;
    }
    const regex = patterns.length < MAX_PATTERNS ? keywordPatternRegex(entry) : null;
    if (regex) patterns.push(regex);
  }
  const matcher: KeywordMatcher = {
    size: exact.size + patterns.length,
    matches: (keyword: unknown) => {
      const name = String(keyword).toLowerCase();
      return exact.has(name) || patterns.some((pattern) => pattern.test(name));
    },
  };
  matchers.set(key, matcher);
  return matcher;
}
