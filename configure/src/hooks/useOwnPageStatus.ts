// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useQuery } from '@tanstack/react-query';

export function useOwnPageStatus(enabled = true): boolean {
  const { data } = useQuery({
    queryKey: ['own-page-status'],
    queryFn: async () => {
      const response = await fetch('/api/own-page/status');
      if (!response.ok) return false;
      const body = await response.json().catch(() => null);
      return Boolean(body?.enabled);
    },
    staleTime: 60_000,
    enabled,
  });
  return data === true;
}
