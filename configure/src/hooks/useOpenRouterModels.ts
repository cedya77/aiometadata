// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useRef, useState } from 'react';
import type { AIModel } from '@/data/ai-models';

export function useOpenRouterModels(apiKey?: string) {
  const [models, setModels] = useState<AIModel[]>([]);
  const [loading, setLoading] = useState(false);
  const keyRef = useRef(apiKey);

  useEffect(() => {
    if (!apiKey || (apiKey === keyRef.current && models.length > 0)) {
      if (!apiKey) setModels([]);
      keyRef.current = apiKey;
      return;
    }
    keyRef.current = apiKey;
    let cancelled = false;
    setLoading(true);
    fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        const fetched: AIModel[] = (data?.data || [])
          .filter((m: any) => m.id && m.name)
          .map((m: any) => ({ id: m.id, name: m.name, grounding: false }))
          .sort((a: AIModel, b: AIModel) => a.name.localeCompare(b.name));
        setModels(fetched);
      })
      .catch(() => { if (!cancelled) setModels([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { models, loading };
}
