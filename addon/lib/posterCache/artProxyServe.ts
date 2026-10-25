import { pipeline } from 'node:stream/promises';
import { resolveProxyPolicy, type ImageClass, type UpstreamCacheMeta } from './config.js';
import { recordRevalidated, recordServe } from './handler.js';
import { applyProxyResponseHeaders, etagMatches } from './proxyResponse.js';
import { UpstreamRejected, openImageStream } from './upstream.js';

export interface StoreResult {
  /** `upstream` is what the origin promised a browser — see `proxyResponseHeaders`. */
  entry: { etag?: string; expiresAt?: number; size: number; upstream?: UpstreamCacheMeta };
  status: string;
}

export interface ServeStoreResultOptions {
  imageClass: ImageClass;
  url: string;
  result: StoreResult;
  send: (result: StoreResult) => Promise<void>;
}

export async function serveStoreResult(req: any, res: any, opts: ServeStoreResultOptions): Promise<void> {
  const { imageClass, url, result, send } = opts;
  const { entry, status } = result;

  res.setHeader('X-Cache-Status', status);
  const etag = applyProxyResponseHeaders(res, { entry, status });

  if (etagMatches(req.headers['if-none-match'], etag)) {
    recordRevalidated(imageClass, status, req.method, url);
    res.status(304).end();
    return;
  }

  recordServe(imageClass, status, entry.size, req.method, url);
  await send(result);
}

export interface ClientValidators {
  etag?: string;
  lastModified?: string;
}

export function clientValidators(req: any): ClientValidators | undefined {
  const validators: ClientValidators = {};
  const etag = req.headers['if-none-match'];
  if (typeof etag === 'string' && etag.trim() !== '') validators.etag = etag;
  const lastModified = req.headers['if-modified-since'];
  if (typeof lastModified === 'string' && lastModified.trim() !== '') validators.lastModified = lastModified;
  return validators.etag || validators.lastModified ? validators : undefined;
}

export function validatorRequestHeaders(validators?: ClientValidators): Record<string, string> {
  const headers: Record<string, string> = {};
  if (validators?.etag) headers['If-None-Match'] = validators.etag;
  if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified;
  return headers;
}

export interface PassThroughOptions {
  imageClass: ImageClass;
  url: string;
  bypassed: boolean;
  open: (validators: ClientValidators | undefined, signal?: AbortSignal) => Promise<{ status: number; headers: Record<string, any>; data: any }>;
}

export async function servePassThrough(req: any, res: any, opts: PassThroughOptions): Promise<void> {
  const { imageClass, url, bypassed, open } = opts;
  const validators = bypassed ? undefined : clientValidators(req);
  const controller = new AbortController();
  const leave = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.once('close', leave);
  let upstream: Awaited<ReturnType<PassThroughOptions['open']>>;
  try {
    upstream = await open(validators, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return;
    throw error;
  } finally {
    res.off('close', leave);
  }
  if (res.destroyed || res.writableEnded) {
    upstream.data?.destroy?.();
    return;
  }

  const policy = resolveProxyPolicy(url);

  if (bypassed) res.setHeader('X-Cache-Status', 'BYPASS');

  if (upstream.status === 304) {
    upstream.data?.destroy?.();
    applyProxyResponseHeaders(res, {
      status: bypassed ? 'BYPASS' : null,
      upstreamHeaders: upstream.headers,
      policy,
    });
    recordRevalidated(imageClass, 'REVALIDATED', req.method, url);
    res.status(304).end();
    return;
  }

  res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
  applyProxyResponseHeaders(res, {
    status: bypassed ? 'BYPASS' : null,
    upstreamHeaders: upstream.headers,
    policy,
  });
  await pipeline(upstream.data, res).catch(() => undefined);
}

export interface ArtStreamOptions {
  url: string;
  allowPrivateHost: boolean;
  minContentLength?: number;
}

export function openArtStream(opts: ArtStreamOptions): PassThroughOptions['open'] {
  const { url, allowPrivateHost, minContentLength } = opts;

  return async (validators, signal) => {
    const { response } = await openImageStream(url, { allowPrivateHost, validators, signal });
    
    if (minContentLength !== undefined && response.status !== 304) {
      const declared = Number.parseInt(response.headers['content-length'] || '', 10);
      if (Number.isFinite(declared) && declared < minContentLength) {
        response.data?.destroy?.();
        throw new UpstreamRejected(`Upstream returned a body too small to be art: ${declared} bytes`, 502);
      }
    }

    return response;
  };
}
