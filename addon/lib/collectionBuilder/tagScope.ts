// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE

/** The tags a person is shown and the ones kept from them; an empty side limits nothing. */
export interface TagScope {
  show?: readonly string[];
  hide?: readonly string[];
}

function lowered(tags: unknown): Set<string> {
  const out = new Set<string>();
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (typeof tag === 'string' && tag) out.add(tag.toLowerCase());
  }
  return out;
}

/**
 * Whether a catalog, collection or search carrying `tags` is listed: it carries none of the
 * hidden tags, and one of the shown ones once any are picked. Untagged entries are listed
 * only while nothing is picked to show.
 */
export function tagsAllow(scope: TagScope, tags: unknown): boolean {
  const own = lowered(tags);
  if ((scope.hide ?? []).some((tag) => own.has(tag.toLowerCase()))) return false;
  const show = scope.show ?? [];
  return show.length === 0 || show.some((tag) => own.has(tag.toLowerCase()));
}

/** A stable spelling of the scope, for cache keys and ETags. */
export function tagScopeKey(scope: TagScope): string {
  const side = (tags: readonly string[] | undefined) => [...lowered(tags)].sort().join(',');
  return `${side(scope.show)}|${side(scope.hide)}`;
}
