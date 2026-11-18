// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE

/** One request to an engine, its body read as JSON where it is JSON. */
export async function httpJson(url: string, options: { method: 'GET' | 'POST'; key?: string; body?: unknown; timeoutMs?: number }): Promise<{ status: number; data: any; text: string }> {
  const { request } = require('undici');
  const { statusCode, body } = await request(url, {
    method: options.method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.key ? { authorization: `Bearer ${options.key}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20000),
  });
  const text = await body.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: statusCode, data, text };
}

/** A refusal: `message` for the log, `reason` short enough to show the person whose key it was. */
export function searchFailure(status: number, message: string, reason = message): Error {
  return Object.assign(new Error(message), { statusCode: status, reason });
}

/** What a server said about a refusal, short enough for a log line. */
export function saidBy(data: any, text: string): string {
  return String(data?.error || data?.message || (data ? '' : text) || '').slice(0, 120);
}
