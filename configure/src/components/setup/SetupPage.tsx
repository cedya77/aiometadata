// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { languageOptions } from '@/data/languages';
import { useConfig } from '@/contexts/ConfigContext';
import { defaultAnimeSource } from '@/lib/setup/animeProfiles';
import { applySetup, buildSetupCatalogs } from '@/lib/setup/applyTemplate';
import { buildCuratorCatalogs, type CuratorList } from '@/lib/setup/curators';
import { buildStreamingServiceCatalogs } from '@/lib/setup/streaming';
import { listLineupOptions } from '@/lib/setup/lineups';
import { KEY_META } from '@/lib/setup/keyMeta';
import { missingKeysFor, requiredKeysFor } from '@/lib/setup/templates';
import type { AnimeSource, ConfigTemplate, ContentChoice, LineupKind, RequiredKeyId, SetupExtras } from '@/lib/setup/types';
import type { SettingsSectionId } from '@/lib/settingsRoute';
import { cn } from '@/lib/utils';
import { AddOnsRow } from './AddOnsRow';
import { AppliedNext } from './AppliedNext';
import { ApplyPreviewDialog } from './ApplyPreviewDialog';
import { ContentQuestion } from './ContentQuestion';
import { ImportTemplateDialog } from './ImportTemplateDialog';
import { CuratorGallery } from './CuratorGallery';
import { KeyUnlock } from './KeyUnlock';
import { LineupGallery } from './LineupGallery';
import { StickyApplyBar } from './StickyApplyBar';
import { StreamingPickerDialog, type StreamingSelection } from './StreamingPickerDialog';

export type SetupVariant = 'fullscreen' | 'embedded';

export function SetupPage({
  variant = 'embedded',
  onApplied,
  onExit,
}: {
  variant?: SetupVariant;
  onApplied?: () => void;
  onExit?: (target: SettingsSectionId) => void;
}) {
  const { config, setConfig, hasBuiltInTmdb, hasBuiltInTvdb, catalogTTL, lumiereEnabled, jikanEnabled } = useConfig();
  const sources = useMemo(() => ({ lumiere: lumiereEnabled, jikan: jikanEnabled }), [lumiereEnabled, jikanEnabled]);

  const [content, setContent] = useState<ContentChoice>('with-anime');
  const [animeSource, setAnimeSource] = useState<AnimeSource>(defaultAnimeSource('with-anime'));
  const [lineupKind, setLineupKind] = useState<LineupKind>('balanced');
  const [enteredKeys, setEnteredKeys] = useState<Partial<Record<RequiredKeyId, string>>>({});
  const [curatorLists, setCuratorLists] = useState<CuratorList[]>([]);
  const [streaming, setStreaming] = useState<StreamingSelection>({
    services: [],
    datePreset: 'last_5_years',
    releasedOnly: false,
  });
  const [streamingOpen, setStreamingOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [imported, setImported] = useState<ConfigTemplate | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  const lineupOptions = useMemo(() => listLineupOptions(content, sources), [content, sources]);
  const activeLineup = useMemo(
    () => lineupOptions.find(option => option.kind === lineupKind) ?? lineupOptions[0],
    [lineupOptions, lineupKind]
  );

  const availability = useMemo(
    () => ({
      hasBuiltInTmdb,
      hasBuiltInTvdb,
      stored: { tmdb: config.apiKeys?.tmdb, tvdb: config.apiKeys?.tvdb, mdblist: config.apiKeys?.mdblist },
      entered: enteredKeys,
    }),
    [hasBuiltInTmdb, hasBuiltInTvdb, config.apiKeys, enteredKeys]
  );

  const requiredKeys = useMemo(() => requiredKeysFor(content, animeSource), [content, animeSource]);
  const missingKeys = useMemo(
    () => missingKeysFor(content, animeSource, availability),
    [content, animeSource, availability]
  );

  const extras = useMemo<SetupExtras>(
    () => ({
      curatorCatalogs: buildCuratorCatalogs(curatorLists, catalogTTL),
      streamingCatalogs: buildStreamingServiceCatalogs({ ...streaming, catalogTTL }),
    }),
    [curatorLists, streaming, catalogTTL]
  );

  const selection = useMemo(
    () => ({
      template: imported ?? {
        id: `builtin.${activeLineup.kind}`,
        name: activeLineup.name,
        tagline: activeLineup.tagline,
        lineup: activeLineup.kind,
        source: { kind: 'builtin' as const },
      },
      content,
      animeSource,
      sources,
      extras: { ...extras, apiKeys: enteredKeys },
    }),
    [imported, activeLineup, content, animeSource, sources, extras, enteredKeys]
  );

  const previewCatalogs = useMemo(
    () => buildSetupCatalogs(selection, config),
    [selection, config]
  );

  const leave = (target: SettingsSectionId) => {
    setConfig(previous => ({ ...previous, catalogSetupComplete: true }));
    onExit?.(target);
  };

  const handleContentChange = (next: ContentChoice) => {
    setContent(next);
    setAnimeSource(defaultAnimeSource(next));
  };

  const handleApply = (disabledKeys: Set<string>) => {
    setApplying(true);
    try {
      setConfig(previous => {
        const next = applySetup(previous, selection);
        if (disabledKeys.size > 0) {
          next.catalogs = next.catalogs.map(catalog =>
            disabledKeys.has(`${catalog.id}:${catalog.type}`)
              ? { ...catalog, enabled: false }
              : catalog
          );
        }
        return next;
      });

      setPreviewOpen(false);
      setApplied(true);
      onApplied?.();
    } catch (error) {
      console.error('Failed to apply setup:', error);
      toast.error('Could not apply that setup', {
        description: 'Your current configuration is untouched. Try again.',
      });
    } finally {
      setApplying(false);
    }
  };

  const selectedCuratorKeys = useMemo(
    () => new Set(curatorLists.map(list => list.selectionKey)),
    [curatorLists]
  );

  const keySlots = requiredKeys.filter(key => missingKeys.includes(key));
  const previewEnabledCount = previewCatalogs.filter(catalog => catalog.enabled).length;
  const summary = [
    imported ? `${imported.name} · ${previewEnabledCount} catalogs` : `${activeLineup.name} · ${activeLineup.enabledCount} catalogs`,
    curatorLists.length ? `${curatorLists.length} curator lists` : null,
    streaming.services.length ? `${streaming.services.length * 2} streaming rows` : null,
  ].filter(Boolean).join(' · ');

  const coveredByInstance = requiredKeys.filter(
    key => (key === 'tmdb' && hasBuiltInTmdb) || (key === 'tvdb' && hasBuiltInTvdb)
  );

  if (applied) {
    return (
      <AppliedNext
        summary={summary}
        onEdit={() => setApplied(false)}
        onExit={onExit ? () => leave('catalogs') : undefined}
      />
    );
  }

  return (
    <div
      className={cn(
        'w-full space-y-10',
        // Embedded sits inside `main`, which is uncapped and unpadded like every
        // other section; only the takeover needs its own gutters.
        variant === 'fullscreen' ? 'mx-auto max-w-5xl px-4 py-12 sm:px-6' : 'py-2'
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {variant === 'fullscreen' ? "Let's set up your addon" : 'Setup'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Pick a starting point. Nothing here is permanent, and every catalog can be changed later.
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
          <Select
            value={config.language || 'en-US'}
            onValueChange={value => setConfig(previous => ({ ...previous, language: value }))}
          >
            <SelectTrigger className="h-9 w-full sm:w-[190px]" aria-label="Catalog language">
              <SelectValue placeholder="Language" />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {languageOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {variant === 'fullscreen' && onExit && (
            <Button variant="ghost" size="sm" onClick={() => leave('general')}>
              Skip
            </Button>
          )}
        </div>
      </header>

      <ContentQuestion
        content={content}
        animeSource={animeSource}
        onContentChange={handleContentChange}
        onAnimeSourceChange={setAnimeSource}
      />

      {imported ? (
        <section className="space-y-3">
          <h2 className="text-lg font-medium tracking-tight">Starting lineup</h2>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/[0.06] p-4">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">Using a shared setup: {imported.name}</p>
              <p className="text-xs text-muted-foreground">
                {previewEnabledCount} catalogs, plus whatever you add below.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setImported(null)}>
              Use a built-in lineup instead
            </Button>
          </div>
        </section>
      ) : (
      <LineupGallery
        content={content}
        config={config}
        selectedKind={activeLineup.kind}
        onSelect={option => setLineupKind(option.kind)}
      />
      )}

      <CuratorGallery
        storedKey={config.apiKeys?.mdblist}
        catalogTTL={catalogTTL}
        selectedKeys={selectedCuratorKeys}
        onSelectionChange={setCuratorLists}
        onKeyValidated={value => setEnteredKeys(previous => ({ ...previous, mdblist: value }))}
      />

      {(keySlots.length > 0 || coveredByInstance.length > 0) && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium tracking-tight">Access</h2>
          {coveredByInstance.length > 0 && keySlots.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Metadata keys are covered by this instance. Nothing to do.
            </p>
          )}
          {keySlots.map(key => (
            <div key={key} className="space-y-1.5">
              <p className="text-sm">
                This lineup needs a {KEY_META[key].short} key.
              </p>
              <KeyUnlock
                keyId={key}
                value={enteredKeys[key] ?? ''}
                onChange={value => setEnteredKeys(previous => ({ ...previous, [key]: value }))}
              />
            </div>
          ))}
        </section>
      )}

      <AddOnsRow
        streamingCount={streaming.services.length}
        onOpenStreaming={() => setStreamingOpen(true)}
        onOpenImport={() => setImportOpen(true)}
      />

      <StickyApplyBar
        summary={summary}
        blockers={missingKeys.map(key => `${KEY_META[key].label} needed`)}
        busy={applying}
        className={variant === 'fullscreen' ? '-mx-4 px-4 sm:-mx-6 sm:px-6' : undefined}
        onApply={() => setPreviewOpen(true)}
      />

      <ImportTemplateDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={setImported}
      />

      <StreamingPickerDialog
        open={streamingOpen}
        onOpenChange={setStreamingOpen}
        initial={streaming}
        onConfirm={setStreaming}
      />

      <ApplyPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        catalogs={previewCatalogs}
        replacingCount={config.catalogs?.filter(catalog => catalog.enabled).length ?? 0}
        busy={applying}
        onConfirm={handleApply}
      />
    </div>
  );
}
