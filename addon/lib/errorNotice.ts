// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
/**
 * A client has no error channel for a catalog or a meta: an empty list reads as
 * "nothing found", whatever went wrong. A notice is a placeholder item carrying
 * the reason, in the shape the requested resource expects.
 */
export const ERROR_ID_PREFIX = 'aiom.error.';

export type NoticeResource = 'catalog' | 'meta' | 'stream' | 'subtitles';

export interface NoticeOptions {
  title?: string;
  description?: string;
  url?: string;
}

const DEFAULTS = {
  title: 'AIOMetadata',
  description: 'Something went wrong',
};

function noticeId(options: NoticeOptions): string {
  return `${ERROR_ID_PREFIX}${encodeURIComponent(JSON.stringify(options))}`;
}

export function readNoticeId(id: string): NoticeOptions | null {
  if (!id?.startsWith(ERROR_ID_PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(id.slice(ERROR_ID_PREFIX.length)));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function noticeMeta(options: NoticeOptions = {}, type = 'movie'): any {
  const title = options.title || DEFAULTS.title;
  const description = options.description || DEFAULTS.description;
  return {
    id: noticeId({ title, description, ...(options.url ? { url: options.url } : {}) }),
    type,
    name: `⚠️ ${title}`,
    description,
    posterShape: 'poster',
  };
}

export function noticeStream(options: NoticeOptions = {}): any {
  const title = options.title || DEFAULTS.title;
  const description = options.description || DEFAULTS.description;
  return {
    name: `⚠️ ${title}`,
    description,
    ...(options.url ? { externalUrl: options.url } : {}),
  };
}

export function noticeSubtitle(options: NoticeOptions = {}): any {
  const title = options.title || DEFAULTS.title;
  return {
    id: noticeId({ title, description: options.description || DEFAULTS.description }),
    lang: `⚠️ ${title}: ${options.description || DEFAULTS.description}`,
    url: options.url || '',
  };
}

/** The notice in the shape that resource answers with; null when the caller hides errors. */
export function dynamicError(resource: NoticeResource, options: NoticeOptions = {}, type = 'movie'): any {
  switch (resource) {
    case 'catalog': return { metas: [noticeMeta(options, type)] };
    case 'meta': return { meta: { ...noticeMeta(options, type), background: null, released: null } };
    case 'stream': return { streams: [noticeStream(options)] };
    case 'subtitles': return { subtitles: [noticeSubtitle(options)] };
    default: return null;
  }
}

/** Errors are for a person reading a row; a loopback caller parses the list instead. */
export function showsNotices(config: any): boolean {
  if (config?._searchLight || config?._loopback) return false;
  return config?.hideErrors !== true;
}
