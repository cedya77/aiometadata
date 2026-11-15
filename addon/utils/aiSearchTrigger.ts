// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
const LEADING_SEPARATORS = /^[\s.,:;!?—–-]+/;
const SEPARATOR_CHAR = /^[\s.,:;!?—–-]/;
const MIN_AI_TRIGGER_KEYWORD_LENGTH = 2;
const MAX_AI_TRIGGER_KEYWORD_LENGTH = 24;

interface AiTriggerResult {
  matched: boolean;
  query: string;
}

// C0/C1 control characters, including newlines
function isControlChar(code: number): boolean {
  if (code <= 0x1f) return true;
  return code >= 0x7f && code <= 0x9f;
}

// Zero-width and invisible characters
function isInvisibleChar(code: number): boolean {
  if (code >= 0x200b && code <= 0x200d) return true;   // ZWSP, ZWNJ, ZWJ
  return code === 0x2060 || code === 0xfeff;           // word joiner, BOM
}

// Normalizes a raw keyword from config. Returns '' for anything unusable
function sanitizeAiTriggerKeyword(raw: any): string {
  if (typeof raw !== 'string') return '';

  const kept: string[] = [];
  for (const ch of Array.from(raw)) {
    const code = ch.codePointAt(0);
    if (code === undefined || isInvisibleChar(code)) continue;
    kept.push(isControlChar(code) ? ' ' : ch);
  }
  const collapsed = kept.join('').replace(/\s+/g, ' ').trim();
  const cleaned = Array.from(collapsed)
    .slice(0, MAX_AI_TRIGGER_KEYWORD_LENGTH)
    .join('')
    .trim();

  return Array.from(cleaned).length >= MIN_AI_TRIGGER_KEYWORD_LENGTH ? cleaned : '';
}

function getAiTriggerKeyword(config: any): string {
  return sanitizeAiTriggerKeyword(config?.search?.ai_trigger_keyword);
}

// Returns the keyword-stripped query when matched, and the untouched original
// when not. Matching is prefix-only and case-insensitive.
function applyAiTrigger(query: string, keyword: string): AiTriggerResult {
  const original = query || '';
  if (!keyword) return { matched: true, query: original };

  const noMatch: AiTriggerResult = { matched: false, query: original };
  const tokens = keyword.split(' ');
  let i = 0;

  while (i < original.length && /\s/.test(original[i])) i++;

  for (let t = 0; t < tokens.length; t++) {
    if (t > 0) {
      const wsStart = i;
      while (i < original.length && /\s/.test(original[i])) i++;
      if (i === wsStart) return noMatch; // keyword words must be separated
    }
    const token = tokens[t];
    if (original.slice(i, i + token.length).toLowerCase() !== token.toLowerCase()) {
      return noMatch;
    }
    i += token.length;
  }

  const rest = original.slice(i);
  // Boundary check, so the keyword "ai" does not match the title "Air".
  if (rest.length > 0 && !SEPARATOR_CHAR.test(rest)) return noMatch;

  return { matched: true, query: rest.replace(LEADING_SEPARATORS, '').trim() };
}

export {
  getAiTriggerKeyword,
  applyAiTrigger,
  sanitizeAiTriggerKeyword,
  MIN_AI_TRIGGER_KEYWORD_LENGTH,
  MAX_AI_TRIGGER_KEYWORD_LENGTH,
};
module.exports = {
  getAiTriggerKeyword,
  applyAiTrigger,
  sanitizeAiTriggerKeyword,
  MIN_AI_TRIGGER_KEYWORD_LENGTH,
  MAX_AI_TRIGGER_KEYWORD_LENGTH,
};
