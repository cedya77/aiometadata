// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { Clapperboard, Sparkles, Tv } from 'lucide-react';
import { motion } from 'framer-motion';
import { Callout } from '@/components/settings/Callout';
import { animeNotices } from '@/lib/animeNotices';
import { ANIME_QUESTION, ANIME_SOURCE_OPTIONS, resolveAnimeProfile } from '@/lib/setup/animeProfiles';
import type { AnimeSource, ContentChoice } from '@/lib/setup/types';
import { cn } from '@/lib/utils';

const CHOICES: Array<{ value: ContentChoice; label: string; hint: string; Icon: typeof Tv }> = [
  {
    value: 'movies-tv',
    label: 'Movies and TV',
    hint: 'No anime catalogs and no anime search.',
    Icon: Clapperboard,
  },
  {
    value: 'with-anime',
    label: 'Movies, TV and anime',
    hint: 'Anime catalogs alongside everything else.',
    Icon: Tv,
  },
  {
    value: 'anime-first',
    label: 'Mostly anime',
    hint: 'Anime found in any catalog, not just the anime ones, uses your anime source.',
    Icon: Sparkles,
  },
];

export function ContentQuestion({
  content,
  animeSource,
  onContentChange,
  onAnimeSourceChange,
}: {
  content: ContentChoice;
  animeSource: AnimeSource;
  onContentChange: (value: ContentChoice) => void;
  onAnimeSourceChange: (value: AnimeSource) => void;
}) {
  const sourceOptions = ANIME_SOURCE_OPTIONS[content];
  const question = ANIME_QUESTION[content];
  const notices = animeNotices(resolveAnimeProfile(content, animeSource));

  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-medium tracking-tight">What do you watch?</h2>
        <p className="text-sm text-muted-foreground">
          This is the only thing setup needs to know. Everything else has a sensible default.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {CHOICES.map(({ value, label, hint, Icon }) => {
          const selected = content === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => onContentChange(value)}
              aria-pressed={selected}
              className={cn(
                'group relative rounded-xl border p-4 text-left transition-colors duration-200',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                selected
                  ? 'border-primary/60 bg-primary/[0.07]'
                  : 'border-white/[0.08] bg-white/[0.02] hover:border-white/20'
              )}
            >
              <Icon
                className={cn('mb-3 h-5 w-5', selected ? 'text-primary' : 'text-muted-foreground')}
                aria-hidden="true"
              />
              <div className="text-sm font-medium">{label}</div>
              <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</div>
            </button>
          );
        })}
      </div>

      {sourceOptions.length > 0 && question && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4"
        >
          <div>
            <h3 className="text-sm font-medium">{question.title}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{question.hint}</p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {sourceOptions.map(option => {
              const selected = animeSource === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onAnimeSourceChange(option.value)}
                  aria-pressed={selected}
                  className={cn(
                    'rounded-lg border p-3 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                    selected
                      ? 'border-primary/50 bg-primary/[0.07]'
                      : 'border-white/[0.06] hover:border-white/20'
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {option.label}
                    {option.recommended && (
                      <span className="rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                        suggested
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{option.hint}</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground/80">
                    {option.episodeIds}
                  </p>
                </button>
              );
            })}
          </div>

          {content === 'anime-first' && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Kitsu is not an option here. Anime picked up from ordinary catalogs arrives with an
              IMDb id, and there is no reliable way to tell which Kitsu entry that id belongs to.
            </p>
          )}

          {notices.map(notice => (
            <Callout key={notice.id} variant={notice.level} className="text-xs">
              {notice.text}
            </Callout>
          ))}
        </motion.div>
      )}
    </section>
  );
}
