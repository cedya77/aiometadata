// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { getSetting } from '../lib/settingsService';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function configuredBase(): string {
  return String(getSetting('OPENROUTER_BASE_URL') || '').trim().replace(/\/+$/, '');
}

/**
 * The OpenAI-compatible API the OpenRouter provider talks to: OpenRouter's own
 * unless the instance names another, such as a self-hosted router or model server.
 */
export function aiEndpointBase(): string {
  return configuredBase() || OPENROUTER_BASE_URL;
}

/** An endpoint other than OpenRouter knows none of its extensions: model presets, `:online` search, `reasoning`. */
export function isCustomAiEndpoint(): boolean {
  return Boolean(configuredBase());
}

/** The model ids another OpenAI-compatible endpoint lists, for the configure page's picker. */
export async function listEndpointModels(apiKey: string): Promise<Array<{ id: string; name: string }>> {
  const { request } = require('undici');
  const { statusCode, body } = await request(`${aiEndpointBase()}/models`, {
    method: 'GET',
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10000),
  });
  const data: any = await body.json().catch(() => null);
  if (statusCode !== 200) throw Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
  const ids = (Array.isArray(data?.data) ? data.data : []).map((model: any) => String(model?.id ?? '').trim()).filter(Boolean);
  return [...new Set<string>(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 2000).map((id) => ({ id, name: id }));
}
