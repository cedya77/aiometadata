// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useQuery } from '@tanstack/react-query';

export type ResolveOnOpenMode = 'user' | 'always' | 'never';
export type UpcomingMode = 'user' | 'caught-up' | 'airing';

export interface JellyfinServer {
  loaded: boolean;
  enabled: boolean;
  liveTv: boolean;
  baseUrl: string;
  resolveOnOpen: ResolveOnOpenMode;
  upcomingMode: UpcomingMode;
}

async function fetchInstanceConfig(): Promise<Record<string, unknown>> {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error(`Instance config ${response.status}`);
  return response.json();
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Whether this instance runs the Jellyfin server, the address clients reach it at, and the modes it forces. */
export function useJellyfinServer(active = true): JellyfinServer {
  const { data, isSuccess } = useQuery({
    queryKey: ['instance-config'],
    queryFn: fetchInstanceConfig,
    staleTime: Infinity,
    refetchOnWindowFocus: (query) => query.state.status === 'error',
    enabled: active,
  });
  const baseUrl = typeof data?.jellyfinBaseUrl === 'string' && data.jellyfinBaseUrl.trim() ? data.jellyfinBaseUrl.trim() : window.location.origin;
  return {
    loaded: isSuccess,
    enabled: Boolean(data?.jellyfinEnabled),
    liveTv: Boolean(data?.jellyfinLiveTv),
    baseUrl,
    resolveOnOpen: pick(data?.jellyfinResolveOnOpen, ['user', 'always', 'never'] as const, 'user'),
    upcomingMode: pick(data?.jellyfinUpcomingMode, ['user', 'caught-up', 'airing'] as const, 'user'),
  };
}

export function jellyfinServerAddress(baseUrl: string, userUUID: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/jellyfin/${userUUID}`;
}
