import { useEffect, useState } from 'react';

import { useConfig } from '@/contexts/ConfigContext';
import type { CatalogConfig } from '@/contexts/config';
import { isNativeSource, nativeOrigin } from '@shared/catalogReconstruction';
import type {
  BuilderEntry,
  ClassicRowDraft,
  SourceDraft,
  CollectionDraft,
  FolderDraft,
  FusionAspectRatio,
  FusionCardStyle,
  TileShape,
} from '@shared/types';
import { TERMS, type Target } from '@/lib/collectionBuilder/terms';

const TILE_ASPECT: Record<TileShape, string> = {
  POSTER: '2 / 3',
  LANDSCAPE: '16 / 9',
  SQUARE: '1 / 1',
};

/** Share of the stage width one tile takes, roughly a TV grid's density. */
const TILE_WIDTH: Record<TileShape, string> = {
  POSTER: '16%',
  LANDSCAPE: '24%',
  SQUARE: '19%',
};

const CARD_ASPECT: Record<FusionAspectRatio, string> = {
  poster: '2 / 3',
  wide: '16 / 9',
  square: '1 / 1',
};

const CARD_WIDTH: Record<FusionCardStyle, string> = {
  small: '11%',
  medium: '15%',
  large: '21%',
};

const MAX_PREVIEW_CARDS = 10;

interface PreviewMeta {
  id: string;
  name?: string;
  poster?: string | null;
}

/** Enough of a catalog for the server to read one page of it. */
/**
 * Which config the page is editing. `auth.userUUID` is only set once a config has
 * been explicitly loaded or saved, so on a configure URL it is usually null even
 * though the path names the config. The server resolves an alias the same way it
 * does for the manifest route.
 */
function configIdFromUrl(): string | null {
  try {
    const parts = window.location.pathname.split('/');
    const at = parts.findIndex(part => part === 'stremio');
    const candidate = at !== -1 ? parts[at + 1] : '';
    return candidate && /^[A-Za-z0-9_-]{3,}$/.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * The first page of the catalog a row points at, so the preview shows what the row
 * will actually hold. Falls back to placeholders while loading, for a catalog that
 * is only staged, and on any failure — the preview is decoration, never a blocker.
 */
function useCatalogPeek(
  source: SourceDraft | null | undefined,
  userUUID: string | null,
  want: number,
  pendingCatalogs?: CatalogConfig[]
) {
  const [metas, setMetas] = useState<PreviewMeta[]>([]);
  const catalogId = source && !isNativeSource(source) ? source.catalogId : null;
  const type = source?.type ?? null;
  const genre = source?.genre ?? null;

  // The definition travels with the request rather than being looked up server
  // side: it may be staged by an import, or belong to a configuration that has
  // never been saved, and neither is in the database.
  const { config } = useConfig();
  const known = catalogId
    ? (config.catalogs || []).find(catalog => catalog.id === catalogId)
      || pendingCatalogs?.find(catalog => catalog.id === catalogId)
    : undefined;
  const stagedKey = known ? JSON.stringify(known) : '';

  useEffect(() => {
    if (!catalogId || !type || !stagedKey) {
      setMetas([]);
      return;
    }
    let cancelled = false;
    const body: Record<string, unknown> = { id: catalogId, type, limit: want };
    if (userUUID) body.userUUID = userUUID;
    if (genre) body.genre = genre;
    if (stagedKey) body.catalog = JSON.parse(stagedKey);

    fetch('/api/collections/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(response => (response.ok ? response.json() : null))
      .then(payload => {
        if (!cancelled) setMetas(Array.isArray(payload?.metas) ? payload.metas : []);
      })
      .catch(() => {
        if (!cancelled) setMetas([]);
      });
    return () => { cancelled = true; };
  }, [catalogId, type, genre, userUUID, want, stagedKey]);

  return metas;
}

function initialsFor(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words.slice(0, 2).map(word => word[0]).join('').toUpperCase();
}

/** Stable hue from the title, so two artless tiles do not read as one. */
function gradientFor(title: string): string {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) % 360;
  }
  return `linear-gradient(135deg, hsl(${hash} 45% 28%), hsl(${(hash + 40) % 360} 40% 16%))`;
}

/** Mirrors what nuvioExport.toFolder and fusionExport.toCollectionItem will accept. */
function usableSourceCount(folder: FolderDraft, target: Target): number {
  return folder.sources.filter(source => {
    if (isNativeSource(source)) return nativeOrigin(source) === target && Boolean(source.native);
    return Boolean((source.catalogId || '').trim()) && Boolean((source.type || '').trim());
  }).length;
}

/** Only a missing title drops a folder. A sourceless one exports and comes up empty. */
function folderDropped(folder: FolderDraft): boolean {
  return !folder.title.trim();
}

function TileArt({
  folder,
  focused,
  allowEmoji,
}: {
  folder: FolderDraft;
  focused: boolean;
  allowEmoji: boolean;
}) {
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const cover = (folder.coverImageUrl || '').trim();
  const gif = (folder.focusGifUrl || '').trim();
  const src = focused && gif && folder.focusGifEnabled !== false ? gif : cover;
  const failed = Boolean(src) && brokenSrc === src;
  const title = folder.title.trim();
  const emoji = allowEmoji ? (folder.coverEmoji || '').trim() : '';

  if (src && !failed) {
    return (
      <img
        key={src}
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBrokenSrc(src)}
        className="h-full w-full object-cover"
      />
    );
  }

  return (
    <>
      <span
        className="flex h-full w-full items-center justify-center"
        style={{ backgroundImage: gradientFor(title || 'untitled') }}
      >
        <span className={emoji ? 'text-3xl' : 'text-base font-semibold tracking-wide text-white/75'}>
          {emoji || initialsFor(title)}
        </span>
      </span>
      <span
        className="absolute right-1 top-1 h-2 w-2 rounded-full bg-white/50"
        title={failed ? 'Cover image did not load' : 'No cover set'}
        aria-label={failed ? 'Cover image did not load' : 'No cover set'}
      />
    </>
  );
}

function PreviewTile({
  folder,
  target,
  focused,
  glow,
  showTitle,
  allowEmoji,
  width,
  onFocus,
  onBlur,
  onEdit,
}: {
  folder: FolderDraft;
  target: Target;
  focused: boolean;
  glow: boolean;
  showTitle: boolean;
  allowEmoji: boolean;
  width?: string;
  onFocus: () => void;
  onBlur: () => void;
  onEdit: () => void;
}) {
  const title = folder.title.trim();
  const dropped = folderDropped(folder);
  const empty = !dropped && usableSourceCount(folder, target) === 0;

  return (
    <button
      type="button"
      onClick={onEdit}
      onMouseEnter={onFocus}
      onMouseLeave={onBlur}
      onFocus={onFocus}
      onBlur={onBlur}
      aria-label={`Edit ${title || `untitled ${TERMS[target].child.toLowerCase()}`}`}
      className={`flex shrink-0 flex-col gap-1.5 text-left ${dropped ? 'opacity-40' : ''}`}
      style={{ width: width || TILE_WIDTH[folder.shape] }}
    >
      <span
        className={`relative block overflow-hidden rounded-md transition-shadow motion-reduce:transition-none ${
          focused && glow
            ? 'shadow-[0_0_0_2px_hsl(var(--primary)),0_0_20px_hsl(var(--primary)/0.5)]'
            : 'shadow-[0_0_0_1px_rgba(255,255,255,0.12)]'
        }`}
        style={{ aspectRatio: TILE_ASPECT[folder.shape] }}
      >
        <TileArt folder={folder} focused={focused} allowEmoji={allowEmoji} />
      </span>
      {showTitle && (
        <span className="line-clamp-2 text-xs leading-tight text-white/85">
          {title || `Untitled ${TERMS[target].child.toLowerCase()}`}
        </span>
      )}
      {dropped && <span className="text-xs text-amber-400">left out of this export</span>}
      {empty && <span className="text-xs text-muted-foreground">no sources yet, exports empty</span>}
    </button>
  );
}

function PreviewCaption() {
  return (
    <p className="text-xs text-muted-foreground">
      Approximate. Tile art, shapes, titles, order and counts are exactly what you set; spacing, grids
      and card sizes are this addon&rsquo;s rendering, not the app&rsquo;s.
    </p>
  );
}

function NuvioCollectionStage({
  entry,
  onEditFolder,
}: {
  entry: CollectionDraft;
  onEditFolder: (folderId: string) => void;
}) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focused = entry.folders.find(folder => folder.id === focusedId) || null;
  const base = (entry.backdropImageUrl || '').trim();
  const hero = (focused?.heroBackdropUrl || '').trim();
  const logo = (focused?.titleLogoUrl || '').trim();

  // The hero layer stays mounted with the last one seen, so leaving a tile fades
  // back out instead of unmounting mid-transition.
  const [lastHero, setLastHero] = useState('');
  useEffect(() => {
    if (hero) setLastHero(hero);
  }, [hero]);

  const glow = entry.focusGlowEnabled !== false;
  const viewMode = entry.viewMode || 'TABBED_GRID';
  const asRows = viewMode === 'ROWS';

  const tile = (folder: FolderDraft, width?: string) => (
    <PreviewTile
      key={folder.id}
      folder={folder}
      target="nuvio"
      focused={focusedId === folder.id}
      glow={glow}
      showTitle={!asRows && !folder.hideTitle}
      allowEmoji
      width={width}
      onFocus={() => setFocusedId(folder.id)}
      onBlur={() => setFocusedId(current => (current === folder.id ? null : current))}
      onEdit={() => onEditFolder(folder.id)}
    />
  );

  return (
    <div className="relative aspect-video min-h-[19rem] w-full overflow-hidden rounded-lg border bg-neutral-950">
      {base && (
        <img
          key={base}
          src={base}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover opacity-60"
        />
      )}
      {lastHero && (
        <img
          src={lastHero}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 motion-reduce:transition-none ${
            hero ? 'opacity-60' : 'opacity-0'
          }`}
        />
      )}
      <span className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/70 to-black/40" />

      <div className="relative flex h-full flex-col gap-3 overflow-y-auto p-4">
        {entry.pinToTop && (
          <span className="w-fit rounded-full bg-cyan-500/20 px-2 py-0.5 text-xs text-cyan-200">
            Pinned above your other collections
          </span>
        )}

        <div className="flex items-center gap-3">
          {logo && (
            <img
              key={logo}
              src={logo}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-8 max-w-[9rem] object-contain"
            />
          )}
          <span className="text-sm font-semibold text-white">
            {entry.title.trim() || 'Untitled collection'}
          </span>
        </div>

        {!asRows && entry.folders.length > 0 && (
          <div className="flex min-w-0 shrink-0 gap-1.5 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {entry.showAllTab !== false && (
              <span className="shrink-0 whitespace-nowrap rounded-full bg-white/90 px-2.5 py-0.5 text-xs font-medium text-black">
                All
              </span>
            )}
            {entry.folders.map((folder, index) => (
              <span
                key={folder.id}
                className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs ${
                  entry.showAllTab === false && index === 0
                    ? 'bg-white/90 font-medium text-black'
                    : 'bg-white/15 text-white/80'
                }`}
              >
                {folder.title.trim() || 'Untitled'}
              </span>
            ))}
          </div>
        )}

        {viewMode === 'FOLLOW_LAYOUT' && (
          <span className="text-xs text-white/50">
            Follow layout: the app&rsquo;s own layout setting picks between tabs and rows.
          </span>
        )}

        {entry.folders.length === 0 ? (
          <span className="m-auto text-xs text-white/50">No folders yet.</span>
        ) : asRows ? (
          <div className="space-y-2">
            {entry.folders.map(folder => (
              <div key={folder.id} className="flex items-center gap-3 rounded-md bg-white/5 p-2">
                {tile(folder, '12%')}
                <span className="min-w-0">
                  <span className="block truncate text-xs text-white/90">
                    {folder.hideTitle ? '' : folder.title.trim() || 'Untitled folder'}
                  </span>
                  <span className="block text-xs text-white/50">
                    {folder.sources.length} catalog{folder.sources.length === 1 ? '' : 's'}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">{entry.folders.map(folder => tile(folder))}</div>
        )}
      </div>
    </div>
  );
}

function FusionCollectionStage({
  entry,
  onEditFolder,
}: {
  entry: CollectionDraft;
  onEditFolder: (folderId: string) => void;
}) {
  const [focusedId, setFocusedId] = useState<string | null>(null);

  return (
    <div className="rounded-lg border bg-neutral-950 p-4">
      {!entry.hideTitle && (
        <p className="mb-2.5 text-sm font-semibold text-white">
          {entry.title.trim() || 'Untitled widget'}
        </p>
      )}
      {entry.folders.length === 0 ? (
        <p className="py-6 text-center text-xs text-white/50">No items yet.</p>
      ) : (
        <div className="flex shrink-0 gap-3 overflow-x-auto pb-1">
          {entry.folders.map(folder => (
            <PreviewTile
              key={folder.id}
              folder={folder}
              target="fusion"
              focused={focusedId === folder.id}
              glow={false}
              showTitle={!folder.hideTitle}
              allowEmoji={false}
              onFocus={() => setFocusedId(folder.id)}
              onBlur={() => setFocusedId(current => (current === folder.id ? null : current))}
              onEdit={() => onEditFolder(folder.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ClassicRowStage({ entry, target, pendingCatalogs }: {
  entry: ClassicRowDraft;
  target: Target;
  pendingCatalogs?: CatalogConfig[];
}) {
  const cards = Math.min(Math.max(entry.limit, 1), MAX_PREVIEW_CARDS);
  const extra = Math.max(entry.limit - cards, 0);
  const background = (entry.backgroundImageURL || '').trim();
  const { auth } = useConfig();
  const items = useCatalogPeek(entry.source, auth.userUUID || configIdFromUrl(), cards, pendingCatalogs);

  return (
    <div className={target === 'nuvio' ? 'space-y-2' : ''}>
      {target === 'nuvio' && (
        <p className="text-xs text-violet-300">
          Classic rows are Fusion only. Nuvio has no equivalent, so this row is left out of the Nuvio
          export.
        </p>
      )}
      <div
        className={`relative overflow-hidden rounded-lg border bg-neutral-950 p-4 ${
          target === 'nuvio' ? 'opacity-50' : ''
        }`}
      >
        {background && (
          <img
            key={background}
            src={background}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full object-cover opacity-30"
          />
        )}
        <div className="relative">
          {!entry.hideTitle && (
            <p className="mb-2.5 text-sm font-semibold text-white">
              {entry.title.trim() || 'Untitled row'}
            </p>
          )}
          <div className="flex shrink-0 items-end gap-3 overflow-x-auto pb-1">
            {Array.from({ length: cards }, (_, index) => (
              <div key={index} className="relative shrink-0" style={{ width: CARD_WIDTH[entry.cardStyle] }}>
                <div
                  className="relative w-full overflow-hidden rounded-md bg-white/10 shadow-[0_0_0_1px_rgba(255,255,255,0.12)]"
                  style={{ aspectRatio: CARD_ASPECT[entry.aspectRatio] }}
                >
                  {items[index]?.poster && (
                    <img
                      src={items[index].poster as string}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  )}
                  {entry.badges.ratings && (
                    <span className="absolute bottom-1 left-1 h-3 w-8 rounded-full bg-white/25" />
                  )}
                  {entry.badges.providers && (
                    <span className="absolute bottom-1 right-1 h-3 w-3 rounded-full bg-white/25" />
                  )}
                </div>
                {entry.numbered && (
                  <span className="absolute -left-1 bottom-0 text-2xl font-black leading-none text-white/70">
                    {index + 1}
                  </span>
                )}
              </div>
            ))}
            {extra > 0 && <span className="shrink-0 text-xs text-white/50">+{extra} more</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function CollectionPreview({
  entry,
  target,
  onEditFolder,
  pendingCatalogs,
}: {
  entry: BuilderEntry | null;
  target: Target;
  onEditFolder: (folderId: string) => void;
  /** Catalogs an apply would create, so a staged row can still be previewed. */
  pendingCatalogs?: CatalogConfig[];
}) {
  if (!entry) {
    return (
      <div className="rounded-xl border border-dashed border-white/[0.08] px-3 py-10 text-center text-sm text-muted-foreground">
        Select something <span className="@2xl/panes:hidden">in the Entries tab</span><span className="hidden @2xl/panes:inline">on the left</span> to preview it.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {entry.kind === 'collection' ? (
        target === 'nuvio' ? (
          <NuvioCollectionStage entry={entry} onEditFolder={onEditFolder} />
        ) : (
          <FusionCollectionStage entry={entry} onEditFolder={onEditFolder} />
        )
      ) : (
        <ClassicRowStage entry={entry} target={target} pendingCatalogs={pendingCatalogs} />
      )}
      <PreviewCaption />
    </div>
  );
}
