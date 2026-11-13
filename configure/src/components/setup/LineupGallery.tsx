// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useMemo } from 'react';
import { Check } from 'lucide-react';
import type { AppConfig } from '@/contexts/config';
import { includesAnime } from '@/lib/setup/animeProfiles';
import { malPreviewParams, tmdbPreviewParams } from '@/lib/setup/previewParams';
import type { LineupOption } from '@/lib/setup/lineups';
import { listLineupOptions } from '@/lib/setup/lineups';
import { useConfig } from '@/contexts/ConfigContext';
import type { ContentChoice, LineupKind } from '@/lib/setup/types';
import { cn } from '@/lib/utils';
import { PosterStrip, type PosterSource } from './PosterStrip';

function posterSourcesFor(
  kind: LineupKind,
  content: ContentChoice,
  config: AppConfig
): PosterSource[] {
  const tmdbKey = config.apiKeys?.tmdb?.trim();
  const withKey = (params: Record<string, string>) =>
    tmdbKey ? { ...params, apikey: tmdbKey } : params;

  if (kind === 'everything' && includesAnime(content)) {
    return [{
      endpoint: 'mal',
      params: { order_by: 'score', sort: 'desc', ...malPreviewParams(config) },
    }];
  }

  // Matches the tmdb.top_rated params in getCatalog.ts.
  const sort = kind === 'balanced'
    ? { sort_by: 'vote_average.desc', 'vote_count.gte': '500', without_genres: '99,10755' }
    : { sort_by: 'popularity.desc' };

  return [
    { endpoint: 'tmdb', params: withKey({ ...tmdbPreviewParams(config, 'movie'), ...sort }) },
    { endpoint: 'tmdb', params: withKey({ ...tmdbPreviewParams(config, 'tv'), ...sort }) },
  ];
}

function homeRowNames(option: LineupOption, limit: number): string[] {
  return option.catalogs
    .filter(catalog => catalog.enabled && catalog.showInHome)
    .map(catalog => catalog.name)
    .filter((name, index, all) => all.indexOf(name) === index)
    .slice(0, limit);
}

function LineupCard({
  option,
  content,
  config,
  selected,
  onSelect,
}: {
  option: LineupOption;
  content: ContentChoice;
  config: AppConfig;
  selected: boolean;
  onSelect: () => void;
}) {
  const sources = useMemo(
    () => posterSourcesFor(option.kind, content, config),
    [option.kind, content, config]
  );
  const rows = homeRowNames(option, 4);
  const homeCount = option.catalogs.filter(c => c.enabled && c.showInHome).length;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-2xl border text-left transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        selected
          ? 'border-primary/60 bg-primary/[0.06] shadow-lg shadow-primary/5'
          : 'border-white/[0.08] bg-white/[0.02] hover:border-white/20'
      )}
    >
      <PosterStrip sources={sources} count={6} className="rounded-none" />

      {selected && (
        <span className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      )}

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-base font-medium">{option.name}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {option.enabledCount} catalogs
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{option.tagline}</p>
        </div>

        <div className="mt-auto space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
            {homeCount} on your home screen
          </div>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {rows.map(name => (
              <li key={name} className="truncate">{name}</li>
            ))}
            {homeCount > rows.length && (
              <li className="text-muted-foreground/60">and {homeCount - rows.length} more</li>
            )}
          </ul>
        </div>
      </div>
    </button>
  );
}

export function LineupGallery({
  content,
  config,
  selectedKind,
  onSelect,
}: {
  content: ContentChoice;
  config: AppConfig;
  selectedKind: LineupKind;
  onSelect: (option: LineupOption) => void;
}) {
  const { lumiereEnabled, jikanEnabled } = useConfig();
  const options = useMemo(() => listLineupOptions(content, { lumiere: lumiereEnabled, jikan: jikanEnabled }), [content, lumiereEnabled, jikanEnabled]);

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-medium tracking-tight">Starting lineup</h2>
        <p className="text-sm text-muted-foreground">
          How many of the built-in catalogs to turn on. You can add and remove any of them
          afterwards in Catalogs.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {options.map(option => (
          <LineupCard
            key={option.kind}
            option={option}
            content={content}
            config={config}
            selected={selectedKind === option.kind}
            onSelect={() => onSelect(option)}
          />
        ))}
      </div>
    </section>
  );
}
