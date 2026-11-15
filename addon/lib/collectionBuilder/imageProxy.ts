// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { allFolders, mapFoldersDeep, type BuilderEntry, type FolderDraft } from './types';

const IMAGE_URL = /^https?:\/\//i;

/** Every image address a layout carries, deduplicated. */
export function collectionImageUrls(entries: BuilderEntry[] | undefined): string[] {
  const out = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && IMAGE_URL.test(value.trim())) out.add(value.trim());
  };
  for (const entry of entries || []) {
    if (entry?.kind === 'collection') {
      add(entry.backdropImageUrl);
      for (const folder of allFolders(entry.folders || [])) {
        add(folder.coverImageUrl);
        add(folder.heroBackdropUrl);
        add(folder.titleLogoUrl);
        add(folder.focusGifUrl);
      }
    }
  }
  return [...out];
}

/** The address an image is served from through the instance's image cache; `prefix` already names the class. */
export function proxiedImageUrl(prefix: string, url: string): string {
  const base = prefix.replace(/\/+$/, '');
  if (!base || !IMAGE_URL.test(url) || url.startsWith(base)) return url;
  return `${base}/${url}`;
}

/** The layout with every image address pointed at the instance's image cache. */
export function proxyCollectionImages(entries: BuilderEntry[], prefix: string): BuilderEntry[] {
  const via = (value: string | undefined) => (typeof value === 'string' && value.trim() ? proxiedImageUrl(prefix, value.trim()) : value);
  const folder = (f: FolderDraft): FolderDraft => ({
    ...f,
    coverImageUrl: via(f.coverImageUrl),
    heroBackdropUrl: via(f.heroBackdropUrl),
    titleLogoUrl: via(f.titleLogoUrl),
    focusGifUrl: via(f.focusGifUrl),
  });
  return entries.map((entry) => {
    if (entry?.kind === 'collection') {
      return { ...entry, backdropImageUrl: via(entry.backdropImageUrl), folders: mapFoldersDeep(entry.folders || [], folder) };
    }
    return entry;
  });
}
