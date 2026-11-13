// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export interface PosterSource {
  endpoint: 'tmdb' | 'mal';
  params: Record<string, string>;
}

interface PreviewItem {
  id: number | string;
  title?: string;
  poster_path?: string | null;
}

/** MAL hands back absolute image URLs while TMDB returns a path fragment. */
function posterUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.startsWith('http') ? path : `https://image.tmdb.org/t/p/w185${path}`;
}

const CACHE = new Map<string, string[]>();

async function loadPosters(source: PosterSource, count: number): Promise<string[]> {
  const query = new URLSearchParams(source.params).toString();
  const key = `${source.endpoint}?${query}`;

  const cached = CACHE.get(key);
  if (cached) return cached;

  const response = await fetch(`/api/${source.endpoint}/discover/preview?${query}`);
  if (!response.ok) throw new Error(String(response.status));

  const body = await response.json();
  const urls = ((body?.results ?? []) as PreviewItem[])
    .map(item => posterUrl(item.poster_path))
    .filter((url): url is string => !!url)
    .slice(0, count);

  CACHE.set(key, urls);
  return urls;
}

/** Sources share the tiles evenly and in order, so two sources fill one row each. */
export function PosterStrip({
  sources,
  count = 6,
  className,
}: {
  sources: PosterSource[];
  count?: number;
  className?: string;
}) {
  const [posters, setPosters] = useState<string[]>([]);
  const signature = JSON.stringify(sources);

  useEffect(() => {
    if (sources.length === 0) return;
    let active = true;

    const perSource = Math.ceil(count / sources.length);
    Promise.all(sources.map(source => loadPosters(source, perSource).catch(() => [])))
      .then(results => {
        if (!active) return;
        setPosters(results.flatMap(urls => urls.slice(0, perSource)).slice(0, count));
      });

    return () => { active = false; };
  }, [signature, count]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={cn(
        'grid grid-cols-6 gap-px overflow-hidden rounded-lg bg-white/[0.04] sm:grid-cols-3',
        className
      )}
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="aspect-[2/3] overflow-hidden bg-white/[0.03]">
          {posters[index] && (
            <img
              src={posters[index]}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover opacity-90 transition-opacity duration-500"
            />
          )}
        </div>
      ))}
    </div>
  );
}
