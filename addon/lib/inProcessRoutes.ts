import querystring from 'node:querystring';
import { runWithRequestAuth } from './requestSession';

type Handler = (req: any, res: any) => unknown;

interface Route {
  path: string;
  handler: Handler;
}

const routes = new Map<string, Route>();

/** Makes a route's handler callable from inside the process, as the Jellyfin server reads catalogs and metas. */
export function registerInProcessRoute(name: string, path: string, handler: Handler): void {
  routes.set(name, { path, handler });
}

export interface RouteReply {
  status: number;
  body: any;
}

/**
 * Runs a registered handler on a request built from `url`, with no socket, no
 * middleware and no queue. The reply is the object the handler built for this
 * call, which the caller reads and does not change.
 */
export async function invokeRoute(
  name: string,
  url: string,
  params: Record<string, string | undefined>,
  timeoutMs: number
): Promise<RouteReply> {
  const route = routes.get(name);
  if (!route) throw new Error(`No in-process route named ${name}`);

  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'undici' };

  const req: any = {
    method: 'GET',
    url,
    originalUrl: url,
    path,
    params,
    query: queryAt === -1 ? {} : { ...querystring.parse(url.slice(queryAt + 1)) },
    headers,
    route: { path: route.path },
    ip: '127.0.0.1',
    get: (field: string) => headers[field.toLowerCase()],
    header: (field: string) => headers[field.toLowerCase()],
  };

  let settle!: (reply: RouteReply) => void;
  const replied = new Promise<RouteReply>((resolve) => { settle = resolve; });
  const finish = (status: number, body: any) => settle({ status, body });

  const res: any = {
    statusCode: 200,
    locals: {},
    headersSent: false,
    _headers: {} as Record<string, unknown>,
    setHeader(field: string, value: unknown) { this._headers[field.toLowerCase()] = value; return this; },
    getHeader(field: string) { return this._headers[field.toLowerCase()]; },
    set(field: string, value: unknown) { return this.setHeader(field, value); },
    header(field: string, value: unknown) { return this.setHeader(field, value); },
    status(code: number) { this.statusCode = code; return this; },
    sendStatus(code: number) { this.statusCode = code; finish(code, null); return this; },
    json(body: any) { finish(this.statusCode, body); return this; },
    send(body: any) { finish(this.statusCode, body); return this; },
    end(body?: any) { finish(this.statusCode, body ?? null); return this; },
    on() { return this; },
    once() { return this; },
  };

  // A loopback request carried no session, so the handler runs as one without it.
  void Promise.resolve()
    .then(() => runWithRequestAuth(false, () => route.handler(req, res)))
    .then(
      () => undefined,
      (error: any) => finish(500, { error: error?.message || String(error) })
    );

  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} took longer than ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });

  try {
    const reply = await Promise.race([replied, late]);
    const body = typeof reply.body === 'string' ? safeParse(reply.body) : reply.body ?? null;
    return { status: reply.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
