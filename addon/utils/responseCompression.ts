// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export {};

const compressionMiddleware: any = require('compression');
const { getSetting }: any = require('../lib/settingsService');
const { POSTER_CACHE_ROUTE }: any = require('../lib/posterCache/config');

const SSE_CONTENT_TYPE = 'text/event-stream';

function isEnabled(): boolean {
  try {
    return getSetting('RESPONSE_COMPRESSION_ENABLED') !== 'false';
  } catch {
    return true;
  }
}

function mountedPath(req: any): string {
  const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  const path = typeof req.path === 'string' ? req.path : '';
  return `${baseUrl}${path}`;
}

function isEventStream(req: any, res: any): boolean {
  const contentType = res.getHeader('Content-Type');
  if (typeof contentType === 'string') return contentType.startsWith(SSE_CONTENT_TYPE);

  const accept = req.headers?.accept;
  return typeof accept === 'string' && accept.includes(SSE_CONTENT_TYPE);
}

function shouldCompressResponse(req: any, res: any): boolean {
  if (!isEnabled()) return false;

  if (isEventStream(req, res)) return false;

  if (mountedPath(req).startsWith(POSTER_CACHE_ROUTE)) return false;

  return compressionMiddleware.filter(req, res);
}

function createResponseCompression(): any {
  return compressionMiddleware({ filter: shouldCompressResponse });
}

module.exports = {
  createResponseCompression,
  shouldCompressResponse,
};
