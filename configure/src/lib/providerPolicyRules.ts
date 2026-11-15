// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export type TtlPolicy = 'default' | 'infer' | 'custom' | 'bypass';

export interface ProviderPolicyRule {
  domain: string;
  policy: TtlPolicy;
  ttl?: string;
}

export interface ProviderPreset {
  policy: TtlPolicy;
  ttl?: string;
}

export interface KnownProvider {
  domain: string;
  preset?: ProviderPreset;
}

export interface PolicyRow {
  domain: string;
  builtIn: boolean;
  explicit: boolean;
  policy: TtlPolicy;
  ttl: string;
  preset?: ProviderPreset;
}

export type PolicyMode = 'store' | 'proxy';

export interface PolicyContext {
  mode: PolicyMode;
  inferEnabled: boolean;
  followUpstream: boolean;
  presetsEnabled: boolean;
}

export function inheritedPolicy(ctx: PolicyContext, preset?: ProviderPreset): TtlPolicy {
  const fromPreset = ctx.presetsEnabled ? preset?.policy : undefined;

  if (ctx.mode === 'proxy') {
    if (ctx.followUpstream) return 'infer';
    return fromPreset ?? 'infer';
  }

  return fromPreset ?? (ctx.inferEnabled ? 'infer' : 'default');
}

import { parseDurationMs } from '../../../addon/lib/posterCache/duration';

export { parseDurationMs };

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function normalizeDomain(value: string): string {
  return (value || '').trim().toLowerCase().replace(/^\.+/, '');
}

export function isValidDomain(value: string): boolean {
  return DOMAIN_RE.test(normalizeDomain(value));
}

export function rowProblem(row: PolicyRow): string | null {
  if (!row.explicit || row.policy !== 'custom') return null;
  if (!row.ttl.trim()) return 'Enter a duration';
  if (parseDurationMs(row.ttl) === null) return 'Use a duration such as 12h, 30d or 1y';
  return null;
}

export function rowsFromRules(
  rules: ProviderPolicyRule[],
  knownProviders: KnownProvider[],
  ctx: PolicyContext
): PolicyRow[] {
  const byDomain = new Map<string, ProviderPolicyRule>();
  for (const rule of rules) byDomain.set(normalizeDomain(rule.domain), rule);

  const presets = new Map<string, ProviderPreset | undefined>();
  for (const provider of knownProviders) {
    presets.set(normalizeDomain(provider.domain), provider.preset);
  }

  const domains = [...presets.keys()];
  for (const domain of byDomain.keys()) {
    if (!domains.includes(domain)) domains.push(domain);
  }

  return domains.map((domain) => {
    const rule = byDomain.get(domain);
    const preset = presets.get(domain);
    return {
      domain,
      builtIn: presets.has(domain),
      explicit: !!rule,
      policy: rule ? rule.policy : inheritedPolicy(ctx, preset),
      ttl: rule?.ttl ?? '',
      preset,
    };
  });
}

export function buildPolicyRules(rows: PolicyRow[]): ProviderPolicyRule[] {
  return rows
    .filter((row) => row.explicit)
    .map((row) => (row.policy === 'custom'
      ? { domain: row.domain, policy: row.policy, ttl: row.ttl.trim() }
      : { domain: row.domain, policy: row.policy }));
}

export function serializePolicies(rules: ProviderPolicyRule[]): string {
  return rules.length === 0 ? '' : JSON.stringify(rules);
}

// --- the flat default ------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function trimNumber(value: number): string {
  return String(round2(value));
}

function plural(value: number, unit: string): string {
  return `${trimNumber(value)} ${unit}${value === 1 ? '' : 's'}`;
}

export function describeDays(raw: unknown): string | null {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const days = Number(text);
  if (!Number.isFinite(days) || days < 0) return null;

  if (days === 0) return 'never expires';

  const ms = days * DAY_MS;
  const asMinutes = round2(ms / (60 * 1000));
  if (asMinutes < 1) return 'under a minute';
  if (asMinutes < 60) return plural(asMinutes, 'minute');

  const asHours = round2(ms / (60 * 60 * 1000));
  if (asHours < 24) return plural(asHours, 'hour');

  return plural(days, 'day');
}

export interface SettingChange {
  key: string;
  value: string;
  label: string;
}

/** Which setting the modal's flat field writes — the two modes edit different keys. */
export interface FlatSetting {
  key: string;
  label: string;
}

export interface PolicyFormState {
  flatDays: string;
  infer: boolean;
  rules: ProviderPolicyRule[];
}

function canonicalPolicies(rules: ProviderPolicyRule[]): string {
  return JSON.stringify(
    [...rules]
      .sort((a, b) => a.domain.localeCompare(b.domain))
      .map((rule) => (rule.policy === 'custom'
        ? { domain: rule.domain, policy: rule.policy, ttl: (rule.ttl ?? '').trim() }
        : { domain: rule.domain, policy: rule.policy }))
  );
}

function sameDays(a: string, b: string): boolean {
  const left = Number(String(a).trim());
  const right = Number(String(b).trim());
  if (Number.isFinite(left) && Number.isFinite(right)) return left === right;
  return String(a).trim() === String(b).trim();
}

export function applyChange(state: PolicyFormState, change: SettingChange, flatKey: string): PolicyFormState {
  if (change.key === flatKey) return { ...state, flatDays: change.value };
  switch (change.key) {
    case 'POSTER_CACHE_INFER_TTL':
      return { ...state, infer: change.value === 'true' };
    case 'POSTER_CACHE_PROVIDER_POLICIES':
      return { ...state, rules: change.value === '' ? [] : JSON.parse(change.value) };
    default:
      return state;
  }
}

export function pendingChanges(
  next: PolicyFormState,
  saved: PolicyFormState,
  flat: FlatSetting
): SettingChange[] {
  const changes: SettingChange[] = [];

  if (!sameDays(next.flatDays, saved.flatDays)) {
    changes.push({ key: flat.key, value: String(next.flatDays).trim(), label: flat.label });
  }
  if (next.infer !== saved.infer) {
    changes.push({
      key: 'POSTER_CACHE_INFER_TTL',
      value: String(next.infer),
      label: 'the follow-source setting',
    });
  }
  if (canonicalPolicies(next.rules) !== canonicalPolicies(saved.rules)) {
    changes.push({
      key: 'POSTER_CACHE_PROVIDER_POLICIES',
      value: serializePolicies(next.rules),
      label: 'the per-provider rules',
    });
  }

  return changes;
}
