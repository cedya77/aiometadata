// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
const TAGGED_PATH = /^(\/stremio\/[^/]+)((?:\/t\/[^/]+)+)(\/.*)?$/;

export function rewriteTagPath(url: string): string | null {
  const queryStart = url.indexOf('?');
  const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
  const match = TAGGED_PATH.exec(pathname);
  if (!match) return null;

  let tags: string[];
  try {
    tags = match[2].split('/t/').slice(1).map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }

  const params = new URLSearchParams(queryStart === -1 ? '' : url.slice(queryStart + 1));
  for (const tag of tags) params.append('tag', tag);
  return `${match[1]}${match[3] || ''}?${params}`;
}

export function createTagPathMiddleware() {
  return function tagPathMiddleware(req: any, _res: any, next: () => void): void {
    const rewritten = typeof req.url === 'string' ? rewriteTagPath(req.url) : null;
    if (rewritten) req.url = rewritten;
    next();
  };
}
