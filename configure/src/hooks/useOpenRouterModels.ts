// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useRef, useState } from 'react';
import type { AIModel } from '@/data/ai-models';

// With a custom endpoint the key belongs to that API, so it is never sent to
// openrouter.ai: the server lists the endpoint's models instead.
function fetchModels(apiKey: string, customEndpoint: boolean): Promise<AIModel[]> {
  if (customEndpoint) {
    return fetch('/api/ai/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    })
      .then(res => (res.ok ? res.json() : { models: [] }))
      .then(data => (Array.isArray(data?.models) ? data.models : [])
        .filter((m: any) => m?.id)
        .map((m: any) => ({ id: String(m.id), name: String(m.name || m.id), grounding: false })));
  }
  return fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  })
    .then(res => res.json())
    .then(data => (data?.data || [])
      .filter((m: any) => m.id && m.name)
      .map((m: any) => ({ id: m.id, name: m.name, grounding: false }))
      .sort((a: AIModel, b: AIModel) => a.name.localeCompare(b.name)));
}

/** `customEndpoint` is null until the instance says, and nothing is fetched before then. */
export function useOpenRouterModels(apiKey?: string, customEndpoint: boolean | null = false) {
  const [models, setModels] = useState<AIModel[]>([]);
  const [loading, setLoading] = useState(false);
  const keyRef = useRef(apiKey);
  const endpointRef = useRef(customEndpoint);

  useEffect(() => {
    if (customEndpoint === null) return;
    const sameSource = apiKey === keyRef.current && customEndpoint === endpointRef.current;
    if (!apiKey || (sameSource && models.length > 0)) {
      if (!apiKey) setModels([]);
      keyRef.current = apiKey;
      endpointRef.current = customEndpoint;
      return;
    }
    keyRef.current = apiKey;
    endpointRef.current = customEndpoint;
    let cancelled = false;
    setLoading(true);
    fetchModels(apiKey, customEndpoint)
      .then(fetched => { if (!cancelled) setModels(fetched); })
      .catch(() => { if (!cancelled) setModels([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [apiKey, customEndpoint]); // eslint-disable-line react-hooks/exhaustive-deps

  return { models, loading };
}
