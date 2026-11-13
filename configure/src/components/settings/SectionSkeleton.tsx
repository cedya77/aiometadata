// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { SkeletonBlock, SkeletonCardSpec, SkeletonSpec } from '@/lib/sectionSkeletons';

const STAGGER_STEP_MS = 90;
const STAGGER_CYCLE = 4;

function SkeletonBar({
  className,
  index = 0,
}: {
  className?: string;
  index?: number;
}) {
  return (
    <Skeleton
      variant="shimmer"
      className={className}
      style={{ animationDelay: `${(index % STAGGER_CYCLE) * STAGGER_STEP_MS}ms` }}
    />
  );
}

function DescriptionLines({ count, offset = 0 }: { count: 1 | 2 | 3; offset?: number }) {
  const widths = ['w-full', 'w-11/12', 'w-3/4'];
  return (
    <div className="space-y-2">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonBar key={i} className={cn('h-3', widths[i % widths.length])} index={offset + i} />
      ))}
    </div>
  );
}

function ControlSilhouette({ card, offset }: { card: SkeletonCardSpec; offset: number }) {
  const count = card.controlCount ?? 1;

  switch (card.control) {
    case 'select':
      return (
        <div className="space-y-4">
          {Array.from({ length: count }, (_, i) => (
            <SkeletonBar key={i} className="h-9 w-full rounded-md" index={offset + i} />
          ))}
        </div>
      );
    case 'switch':
    case 'switch-list':
      return (
        <div className="divide-y divide-border/40">
          {Array.from({ length: card.control === 'switch' ? 1 : count }, (_, i) => (
            <div key={i} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-[12rem] flex-1 space-y-2">
                <SkeletonBar className="h-3.5 w-1/3" index={offset + i} />
                <SkeletonBar className="h-3 w-2/3" index={offset + i + 1} />
              </div>
              <SkeletonBar className="h-6 w-11 shrink-0 rounded-full" index={offset + i} />
            </div>
          ))}
        </div>
      );
    case 'input':
      return (
        <div className="space-y-4">
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className="space-y-2">
              <SkeletonBar className="h-3 w-24" index={offset + i} />
              <SkeletonBar className="h-9 w-full rounded-md" index={offset + i} />
            </div>
          ))}
        </div>
      );
    case 'text':
      return <DescriptionLines count={2} offset={offset} />;
  }
}

function SkeletonCard({ card, offset }: { card: SkeletonCardSpec; offset: number }) {
  return (
    <Card>
      <div className="flex flex-col space-y-1.5 p-6">
        <SkeletonBar className="h-5 w-1/3" index={offset} />
        <DescriptionLines count={card.descriptionLines} offset={offset + 1} />
      </div>
      <div className="p-6 pt-0">
        <ControlSilhouette card={card} offset={offset + 1} />
      </div>
    </Card>
  );
}

function Block({ block, offset }: { block: SkeletonBlock; offset: number }) {
  switch (block.kind) {
    case 'heading':
      return (
        <div>
          <h2 className="text-2xl font-semibold">{block.title}</h2>
          <p className="text-muted-foreground mt-1">{block.description}</p>
        </div>
      );

    case 'callout':
      return (
        <div className="rounded-lg border border-white/[0.06] bg-muted/30 p-4">
          <SkeletonBar className="h-3 w-2/3" index={offset} />
        </div>
      );

    case 'hero':
      return (
        <Card className="overflow-hidden border border-primary/10 bg-gradient-to-br from-primary/5 via-background to-background">
          <div className="space-y-4 p-6 md:p-8 lg:p-10">
            <SkeletonBar className="h-6 w-32 rounded-full" index={offset} />
            <SkeletonBar className="h-9 w-2/5" index={offset + 1} />
            <DescriptionLines count={3} offset={offset + 2} />
            <div className="flex gap-2 pt-2">
              <SkeletonBar className="h-10 w-48 rounded-md" index={offset} />
              <SkeletonBar className="h-10 w-40 rounded-md" index={offset + 1} />
            </div>
          </div>
        </Card>
      );

    case 'toolbar':
      return (
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {Array.from({ length: block.buttons }, (_, i) => (
            <SkeletonBar key={i} className="h-9 w-32 rounded-md" index={offset + i} />
          ))}
        </div>
      );

    case 'card':
      return <SkeletonCard card={block.card} offset={offset} />;

    case 'grid':
      return (
        <div className={block.className}>
          {block.cards.map((card, i) => (
            <SkeletonCard key={i} card={card} offset={offset + i} />
          ))}
        </div>
      );

    case 'collapsed-rows':
      return (
        <div className="space-y-4">
          {Array.from({ length: block.count }, (_, i) => (
            <Card key={i}>
              <div className="flex items-center justify-between gap-3 p-6">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <SkeletonBar className="h-4 w-40" index={offset + i} />
                    <SkeletonBar className="h-5 w-16 rounded-full" index={offset + i + 1} />
                  </div>
                  <SkeletonBar className="h-3 w-3/5" index={offset + i + 1} />
                </div>
                <SkeletonBar className="h-4 w-4 shrink-0 rounded" index={offset + i} />
              </div>
            </Card>
          ))}
        </div>
      );

    case 'list-rows':
      return (
        <div className="space-y-2">
          {Array.from({ length: block.count }, (_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-card/80 p-3"
            >
              <SkeletonBar className="h-4 w-4 shrink-0 rounded" index={offset + i} />
              <SkeletonBar className="h-4 flex-1" index={offset + i} />
              <SkeletonBar className="h-8 w-8 shrink-0 rounded-md" index={offset + i + 1} />
              <SkeletonBar className="h-8 w-8 shrink-0 rounded-md" index={offset + i + 2} />
            </div>
          ))}
        </div>
      );
  }
}

export function SectionSkeleton({ spec, label }: { spec: SkeletonSpec; label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={`Loading ${label}`}
      className={cn(spec.className, 'skeleton-reveal')}
    >
      {spec.blocks.map((block, i) => (
        <Block key={i} block={block} offset={i * 2} />
      ))}
    </div>
  );
}
