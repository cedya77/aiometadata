// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE

export type Ask = (name: string) => any;

export function field(req: any, name: string): any {
  const wanted = name.toLowerCase();
  for (const source of [req?.query, req?.body]) {
    if (!source || typeof source !== 'object') continue;
    const key = Object.keys(source).find((k) => k.toLowerCase() === wanted);
    if (key !== undefined) return source[key];
  }
  return undefined;
}

export const askOf = (req: any): Ask => (name) => field(req, name);

export function flag(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'true' ? true : text === 'false' ? false : undefined;
}

export function listOf(value: unknown, separator: string | RegExp = ','): string[] {
  if (value === undefined || value === null) return [];
  const parts = Array.isArray(value) ? value.flatMap((v) => String(v).split(separator)) : String(value).split(separator);
  return parts.map((v) => v.trim()).filter(Boolean);
}

export function integer(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  return value !== undefined && value !== null && value !== '' && Number.isFinite(n) ? n : fallback;
}

export function timeOf(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}
