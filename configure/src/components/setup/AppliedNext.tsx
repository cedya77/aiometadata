// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { lazy, Suspense, useState } from 'react';
import { ArrowRight, Check, Download, Layers, Loader2, Sliders, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/settings/Callout';
import { AICatalogDialog } from '@/components/AICatalogDialog';
import { useConfig } from '@/contexts/ConfigContext';
import { navigateToSettingsSection, requestCollectionBuilder } from '@/lib/settingsRoute';
import { useSave } from '@/contexts/SaveContext';
import { cn } from '@/lib/utils';

const LazyDiscoverBuilder = lazy(() =>
  import('@/components/sections/DiscoverBuilderDialog').then(m => ({ default: m.DiscoverBuilderDialog }))
);

type ClientId = 'stremio' | 'aurora' | 'realstreams' | 'nuvio' | 'jellyfin' | 'omni' | 'other';

const CLIENTS: Array<{ id: ClientId; label: string; collections?: boolean }> = [
  { id: 'stremio', label: 'Stremio' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'realstreams', label: 'RealStreams' },
  { id: 'nuvio', label: 'Nuvio', collections: true },
  { id: 'jellyfin', label: 'Jellyfin', collections: true },
  { id: 'omni', label: 'Omni' },
  { id: 'other', label: 'Something else' },
];

export function AppliedNext({
  summary,
  onEdit,
  onExit,
}: {
  summary: string;
  onEdit: () => void;
  onExit?: () => void;
}) {
  const { config, hasBuiltInGemini } = useConfig();
  const { requestSave, isSaving, savedConfig, openInstall, installUrl, canSave, error, isDirty } = useSave();
  const [client, setClient] = useState<ClientId | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);


  // Adding a catalog below makes the config dirty again, so this cannot key off
  // savedConfig alone or the Save button would disappear after the first save.
  const saved = !!savedConfig && isDirty === false;
  const canUseAi = !!(config.apiKeys?.openrouter || config.apiKeys?.gemini || hasBuiltInGemini);

  const openCollectionBuilder = () => {
    requestCollectionBuilder();
    if (onExit) onExit();
    else navigateToSettingsSection('catalogs');
  };
  const chosen = CLIENTS.find(entry => entry.id === client);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 px-4 py-12 sm:px-6">
      <div className="space-y-3 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15">
          <Check className="h-6 w-6 text-emerald-400" aria-hidden="true" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">Your setup is ready</h1>
        <p className="text-sm text-muted-foreground">{summary}</p>
      </div>

      {error && <Callout variant="danger">{error}</Callout>}

      <div className="space-y-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">
              {saved ? 'Saved' : 'Save it to get your install link'}
            </p>
            <p className="text-xs text-muted-foreground">
              {saved
                ? 'Your configuration is stored and the link below is live.'
                : 'Nothing is stored until you save.'}
            </p>
          </div>
          {!saved && (
            <Button onClick={requestSave} disabled={isSaving || !canSave} className="shrink-0">
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Save
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium">Which app do you watch in?</p>
        <div className="flex flex-wrap gap-2">
          {CLIENTS.map(entry => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setClient(entry.id)}
              aria-pressed={client === entry.id}
              className={cn(
                'rounded-full border px-3 py-1.5 text-sm transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                client === entry.id
                  ? 'border-primary/50 bg-primary/15 text-primary'
                  : 'border-white/[0.08] hover:border-white/25'
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {chosen && (
          <div className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            {saved && installUrl ? (
              <Button onClick={() => openInstall()} variant="outline" size="sm">
                <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Get the install link
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">Save first and the install link appears here.</p>
            )}

            {chosen.collections && (
              <div className="space-y-2 border-t border-white/[0.06] pt-3">
                <p className="text-sm">{chosen.label} can arrange your catalogs into collections.</p>
                <p className="text-xs text-muted-foreground">
                  {chosen.id === 'jellyfin'
                    ? 'Build the layout here and your Jellyfin clients show it once you save.'
                    : 'Build the layout here and export it, rather than assembling it one press at a time on a TV remote.'}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openCollectionBuilder}
                >
                  <Layers className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  Open the collection builder
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3 border-t border-white/[0.06] pt-6">
        <div className="space-y-1">
          <p className="text-sm font-medium">Worth coming back for</p>
          <p className="text-xs text-muted-foreground">
            Your setup works as it is. These build on it whenever you feel like it.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setAiOpen(true)}
            disabled={!canUseAi}
            title={canUseAi ? undefined : 'Needs an OpenRouter or Gemini key in Integrations.'}
            className={cn(
              'flex items-start gap-3 rounded-xl border p-4 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              canUseAi
                ? 'border-white/[0.08] bg-white/[0.02] hover:border-white/25'
                : 'cursor-not-allowed border-white/[0.05] opacity-60'
            )}
          >
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>
              <span className="block text-sm font-medium">AI catalogs</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                {canUseAi
                  ? 'Describe what you feel like watching and get a catalog built from it.'
                  : 'Add an OpenRouter or Gemini key in Integrations to unlock this.'}
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => setBuilderOpen(true)}
            className={cn(
              'flex items-start gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-left transition-colors',
              'hover:border-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
            )}
          >
            <Sliders className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>
              <span className="block text-sm font-medium">Build your own catalog</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                Choose the filters yourself: genre, year, rating, network, streaming service.
              </span>
            </span>
          </button>
        </div>
      </div>

      <div className="flex items-center justify-center gap-2">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          Change my setup
        </Button>
        {onExit && (
          <Button variant="outline" size="sm" onClick={onExit}>
            Go to your catalogs
            <ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>

      <AICatalogDialog isOpen={aiOpen} onClose={() => setAiOpen(false)} />

      {builderOpen && (
        <Suspense fallback={null}>
          <LazyDiscoverBuilder isOpen onClose={() => setBuilderOpen(false)} />
        </Suspense>
      )}

    </div>
  );
}
