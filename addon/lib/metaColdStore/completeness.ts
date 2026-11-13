// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
/**
 * Whether a payload is worth freezing on disk. Judges language only: a verdict here is
 * applied to rows shared between profiles that differ in artwork, so artwork must not
 * decide it. See docs/superpowers/specs/2026-09-20-cold-store-completeness-gating-design.md
 */

export type CompletenessStamp = {
  titleLang: 'exact' | 'fallback';
  overviewLang: 'exact' | 'fallback';
  /** TVDB paths only: false when to3LetterCode degraded to 'eng' for a non-English config. */
  langResolved?: boolean;
};

export type CompletenessResult = {
  verdict: 'complete' | 'partial' | 'skip';
  reasons: string[];
};

export function classifyMetaCompleteness(meta: any): CompletenessResult {
  const stamp: CompletenessStamp | undefined = meta?._completeness;

  // Wrong language rather than unlocalized, so a short TTL is the wrong remedy.
  if (stamp?.langResolved === false) {
    return { verdict: 'skip', reasons: ['language resolution degraded to eng'] };
  }

  // No stamp means a provider with no locale layer (Kitsu/MAL/TVMAZE/IMDb): never demoted.
  const reasons: string[] = [];
  if (stamp?.titleLang === 'fallback') reasons.push('title from language fallback');
  if (stamp?.overviewLang === 'fallback') reasons.push('overview from language fallback');

  return { verdict: reasons.length > 0 ? 'partial' : 'complete', reasons };
}

module.exports = { classifyMetaCompleteness };
