// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { ArrowUpRight, Palette, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ArtworkResource, FeaturedCollection } from '@/lib/collectionBuilder/featured';

interface FeaturedGalleryProps {
  items: FeaturedCollection[];
  artwork?: ArtworkResource[];
  /** Catalog slots left, so a design that will not fit says so before it is loaded. */
  headroom: number;
  busy: boolean;
  error?: string;
  onLoad: (featured: FeaturedCollection) => void;
}

const CHIP = 'rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-xs leading-4 whitespace-nowrap';

const FAN = [
  '[transform:translate(-78%,-54%)_rotate(-8deg)] group-hover:[transform:translate(-86%,-56%)_rotate(-11deg)] group-focus-visible:[transform:translate(-86%,-56%)_rotate(-11deg)]',
  '[transform:translate(-22%,-54%)_rotate(8deg)] group-hover:[transform:translate(-14%,-56%)_rotate(11deg)] group-focus-visible:[transform:translate(-14%,-56%)_rotate(11deg)]',
  '[transform:translate(-50%,-44%)] group-hover:[transform:translate(-50%,-48%)_scale(1.05)] group-focus-visible:[transform:translate(-50%,-48%)_scale(1.05)]',
];

function hideBroken(event: React.SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.style.visibility = 'hidden';
}

function ArtworkCard({ resource }: { resource: ArtworkResource }) {
  const host = new URL(resource.url).host;
  const fanned = resource.images.slice(-FAN.length);
  return (
    <a
      href={resource.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${resource.name} by ${resource.author}, opens ${host} in a new tab`}
      className="group flex flex-col overflow-hidden rounded-xl border border-white/[0.06] bg-card/80 outline-none transition duration-300 hover:-translate-y-0.5 hover:border-white/15 hover:shadow-xl hover:shadow-black/40 focus-visible:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-sky-400/60 motion-reduce:transform-none motion-reduce:transition-none"
    >
      <div className={`relative aspect-video overflow-hidden bg-gradient-to-br ${resource.accent} to-transparent`}>
        {resource.images.length === 1 ? (
          <img
            src={resource.images[0]}
            alt=""
            loading="lazy"
            decoding="async"
            onError={hideBroken}
            className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04] group-focus-visible:scale-[1.04] motion-reduce:transform-none motion-reduce:transition-none"
          />
        ) : (
          fanned.map((src, at) => (
            <img
              key={src}
              src={src}
              alt=""
              loading="lazy"
              decoding="async"
              onError={hideBroken}
              className={`absolute left-1/2 top-1/2 aspect-video w-[52%] rounded-lg object-cover shadow-lg shadow-black/50 ring-1 ring-white/10 transition-transform duration-500 ease-out motion-reduce:transition-none ${FAN[FAN.length - fanned.length + at]}`}
            />
          ))
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-card/90 to-transparent" />
        <span className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white/90 opacity-0 backdrop-blur transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100">
          <ArrowUpRight className="h-4 w-4" />
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          <p className="truncate font-medium">{resource.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            by {resource.author} · {host}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">{resource.summary}</p>
        <div className="mt-auto flex flex-wrap gap-1.5">
          {resource.tags.map(tag => (
            <span key={tag} className={`${CHIP} text-muted-foreground`}>{tag}</span>
          ))}
        </div>
      </div>
    </a>
  );
}

export function FeaturedGallery({ items, artwork = [], headroom, busy, error, onLoad }: FeaturedGalleryProps) {
  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-5 px-1 pb-6">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Sparkles className="h-5 w-5 text-sky-300" />
          Featured collections
        </h2>
        <p className="text-sm text-muted-foreground">
          Ready-made layouts shared by their authors. Preview one to see what it holds before anything
          is added, then import it whole or keep only the parts you want.
        </p>
      </div>

      {error && <p className="text-sm text-amber-500">{error}</p>}

      <div className="grid min-w-0 gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,22rem),1fr))]">
        {items.map(featured => {
          const overBudget = featured.catalogs > headroom;
          return (
            <div
              key={featured.id}
              className="flex flex-col overflow-hidden rounded-xl border border-white/[0.06] bg-card/80 transition-colors hover:border-sky-400/30"
            >
              <div className="flex items-start gap-3 bg-gradient-to-br from-sky-500/10 to-transparent p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sky-300 ring-1 ring-sky-400/20">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="truncate font-medium">{featured.name}</p>
                  <a
                    href={featured.authorUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    by {featured.author}
                  </a>
                </div>
              </div>

              <div className="flex flex-1 flex-col gap-3 p-4">
                <p className="text-sm text-muted-foreground">{featured.summary}</p>

                <div className="flex flex-wrap gap-1.5">
                  <span className={`${CHIP} text-muted-foreground`}>
                    {featured.detail.split(',')[0]}
                  </span>
                  <span
                    className={`${CHIP} ${
                      overBudget ? 'border-amber-400/30 text-amber-500' : 'text-muted-foreground'
                    }`}
                    title={
                      overBudget
                        ? `Room for ${headroom}. You can still take the layout without the catalogs.`
                        : `Room for ${headroom}.`
                    }
                  >
                    {featured.catalogs} catalogs
                  </span>
                  {featured.classicRows ? (
                    <span
                      className={`${CHIP} text-muted-foreground`}
                      title="Nuvio has no equivalent and skips them; Jellyfin keeps them."
                    >
                      {featured.classicRows} classic rows
                    </span>
                  ) : null}
                </div>

                {featured.note && <p className="text-xs text-muted-foreground">{featured.note}</p>}

                <Button
                  variant="outline"
                  className="mt-auto w-full"
                  disabled={busy}
                  onClick={() => onLoad(featured)}
                >
                  {busy ? 'Loading…' : 'Preview'}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {artwork.length > 0 && (
        <section aria-labelledby="featured-artwork-heading" className="space-y-4 border-t border-white/[0.06] pt-6">
          <div className="space-y-1">
            <h2 id="featured-artwork-heading" className="flex items-center gap-2 text-base font-semibold">
              <Palette className="h-5 w-5 text-violet-300" />
              Artwork for your folders
            </h2>
            <p className="text-sm text-muted-foreground">
              Covers and cards made by the community. Copy an image link from any of these and paste it as a
              folder&apos;s cover.
            </p>
          </div>
          <div className="grid min-w-0 gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,18rem),1fr))]">
            {artwork.map(resource => (
              <ArtworkCard key={resource.id} resource={resource} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
