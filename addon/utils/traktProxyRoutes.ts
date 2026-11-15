// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
/**
 * Which credential the Trakt proxy has to present for a given endpoint. Trakt
 * rejects an unauthenticated call to a private route and ignores a token on a
 * public one, so the path decides before the request is built.
 */
export type TraktProxyAuthMode = 'required' | 'optional' | 'unauthed';

export function normalizeTraktEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== 'string') return '';
  const normalized = endpoint.trim();
  if (!normalized) return '';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function isOptionalUsersRoute(pathnameLower: string): boolean {
  const parts = pathnameLower.split('/').filter(Boolean);
  // /users/{id}
  if (parts.length === 2) return true;
  // /users/{id}/stats
  if (parts.length === 3 && parts[2] === 'stats') return true;
  // /users/{id}/lists
  if (parts.length === 3 && parts[2] === 'lists') return true;
  // /users/{id}/lists/{list_id}
  if (parts.length === 4 && parts[2] === 'lists') return true;
  // /users/{id}/lists/{list_id}/items[...]
  if (parts.length >= 5 && parts[2] === 'lists' && parts[4] === 'items') return true;
  return false;
}

export function resolveTraktProxyAuthMode(pathname: string): TraktProxyAuthMode {
  const pathnameLower = pathname.toLowerCase();

  // Auth required routes.
  if (
    pathnameLower.startsWith('/calendars/my/') ||
    pathnameLower.startsWith('/recommendations/') ||
    pathnameLower.startsWith('/sync/') ||
    pathnameLower.startsWith('/users/hidden/') ||
    pathnameLower.includes('/progress/watched')
  ) {
    return 'required';
  }

  // /users/me/* always needs OAuth (Trakt resolves "me" from the token).
  if (pathnameLower === '/users/me' || pathnameLower.startsWith('/users/me/')) {
    return 'required';
  }

  // OAuth optional routes we currently proxy.
  if (pathnameLower.startsWith('/users/') && isOptionalUsersRoute(pathnameLower)) {
    return 'optional';
  }

  // Known public/unauthed route groups we currently proxy.
  if (
    pathnameLower.startsWith('/genres/') ||
    pathnameLower.startsWith('/lists/') ||
    pathnameLower.startsWith('/movies/') ||
    pathnameLower.startsWith('/shows/') ||
    pathnameLower.startsWith('/search/') ||
    pathnameLower.startsWith('/people/')
  ) {
    return 'unauthed';
  }

  // Default to auth-required for unknown routes.
  return 'required';
}
