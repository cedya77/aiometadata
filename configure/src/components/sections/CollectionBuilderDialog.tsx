import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Sparkles,
  ChevronRight,
  Copy,
  Download,
  Folder,
  Info,
  Layers,
  ListOrdered,
  Link as LinkIcon,
  Plus,
  Replace,
  Rows3,
  Search,
  Tv,
  Upload,
} from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useConfig, type InstanceLimits } from '@/contexts/ConfigContext';
import type { CatalogConfig } from '@/contexts/config';
import { useSave } from '@/contexts/SaveContext';
import { getSourceBadgeStyle } from '@/lib/sourceBadges';

import {
  createClassicRowDraft,
  currentFields,
  createCollectionDraft,
  createFolderDraft,
  allFolders,
  entrySources,
  findFolder,
  folderSources,
  mapFolder,
  mapFoldersDeep,
  newId,
  parentFolderOf,
  removeFolder,
  subFolders,
  type AddonIdentity,
  type BuilderEntry,
  type CollectionDraft,
  type ExportNote,
  type SourceDraft,
} from '@shared/types';
import { foldRows } from '@shared/homeOrder';
import { toNuvioCollections } from '@shared/nuvioExport';
import { toLayoutFile } from '@shared/layoutExport';
import { proxyCollectionImages } from '@shared/imageProxy';
import {
  groupMissingCatalogs,
  parseImport,
  remapSources,
  type ImportResult,
  type MissingCatalogGroup,
} from '@shared/importers';
import { jellyfinNotes } from '@/lib/collectionBuilder/jellyfinNotes';
import {
  buildIdentity,
  buildManifestUrl,
  catalogKey,
  fillMissingGenres,
  findSourceIssues,
  findUnknownSources,
  healSourceNames,
  loadCatalogSources,
  deriveManifestCatalog,
  realignSourceIds,
  sourceFromCatalog,
  stripManifestSuffix,
  type CatalogSourceList,
  type ManifestCatalog,
} from '@/lib/collectionBuilder/manifestSources';
import { buildProblemTargets, withStagedCatalogs } from '@/lib/collectionBuilder/problems';
import { ARTWORK_RESOURCES, FEATURED_COLLECTIONS, type FeaturedCollection } from '@/lib/collectionBuilder/featured';
import { FeaturedDetail } from './collectionBuilder/FeaturedDetail';
import { FeaturedGallery } from './collectionBuilder/FeaturedGallery';
import { entryKey, withoutEntries } from '@/lib/collectionBuilder/importSelection';
import {
  blockingIssues,
  buildIssueCenter,
  saveVerdict,
  type IssueRow,
  type IssueSeverity,
} from '@/lib/collectionBuilder/issueCenter';
import {
  describeEntryCount,
  filterEntryTree,
  nextCopyTitle,
  tallyEntryCount,
} from '@/lib/collectionBuilder/entryOps';
import { deriveSaveStage, describeSaveStage } from '@/lib/collectionBuilder/saveState';
import {
  countImport,
  describeMerge,
  mergeEntries,
  type ImportMode,
} from '@/lib/collectionBuilder/importModes';
import { listStarterTemplates } from '@/lib/collectionBuilder/templates';
import { FUSION_CHIP, JELLYFIN_CHIP, NUVIO_CHIP, TERMS, type Target } from '@/lib/collectionBuilder/terms';
import { CollectionPreview } from './CollectionPreview';
import { buildBlueprintLookup } from '@shared/blueprintLookup';
import {
  additionCount,
  additionLabels,
  applyCatalogAdditions,
  resolveCatalogAdditions,
  type CatalogAdditions,
} from '@/lib/collectionBuilder/catalogBlueprints';
import {
  dedupeBlueprints,
  fromAnyNativeSource,
  isNativeSource,
  isStrandedNative,
  nativeOrigin,
  type CatalogBlueprint,
} from '@shared/catalogReconstruction';
import type { ShareableCatalog } from '@shared/catalogSharing';

import { CatalogPicker } from './collectionBuilder/CatalogPicker';
import { StatusBar } from './collectionBuilder/StatusBar';
import { ClassicRowEditor } from './collectionBuilder/ClassicRowEditor';
import { CollectionEditor } from './collectionBuilder/CollectionEditor';
import { SortableTreeRow } from './collectionBuilder/EntryRail';
import { clone, duplicateEntryDraft, entrySourceCount, type TagOption } from './collectionBuilder/shared';

/**
 * Above this many catalogs an import stops to ask. A community file can carry
 * thousands, and every one added becomes a manifest entry.
 */
const BULK_ADD_THRESHOLD = 100;

interface CollectionBuilderDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialEntryId?: string;
  startNew?: boolean;
}

const SEVERITY_RANK: Record<IssueSeverity, number> = { blocking: 0, warning: 1, info: 2 };

/** The worst thing said about each entry or folder, for its badge on the rail. */
function severityByField(rows: IssueRow[], field: 'entryId' | 'folderId'): Map<string, IssueSeverity> {
  const worst = new Map<string, IssueSeverity>();
  for (const row of rows) {
    const id = row[field];
    if (!id) continue;
    const current = worst.get(id);
    if (!current || SEVERITY_RANK[row.severity] < SEVERITY_RANK[current]) worst.set(id, row.severity);
  }
  return worst;
}

function collectIds(entries: BuilderEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    ids.add(entry.id);
    if (entry.kind !== 'collection') continue;
    for (const folder of allFolders(entry.folders)) ids.add(folder.id);
  }
  return ids;
}

function collectSourceKeys(entries: BuilderEntry[]): string[] {
  const keys: string[] = [];
  for (const entry of entries) {
    for (const source of entrySources(entry)) keys.push(`${source.catalogId}:${source.type}`);
  }
  return keys;
}

/**
 * An exported design carries its ids, and importing one twice would otherwise
 * seat two entries on the same id: deleting either would take both. Only the
 * clashes are reissued, so a design imported once keeps the ids Nuvio knows it by.
 */
function reissueTakenIds(entries: BuilderEntry[], taken: Set<string>): void {
  for (const entry of entries) {
    if (!entry.id || taken.has(entry.id)) entry.id = newId();
    taken.add(entry.id);
    if (entry.kind !== 'collection') continue;
    for (const folder of allFolders(entry.folders)) {
      if (!folder.id || taken.has(folder.id)) folder.id = newId();
      taken.add(folder.id);
    }
  }
}

// ---- Main dialog ----

export function CollectionBuilderDialog({ isOpen, onClose, initialEntryId, startNew }: CollectionBuilderDialogProps) {
  const { config, setConfig, auth, maxCatalogs, collectionImportCatalogCap, refreshInstanceLimits } = useConfig();

  const [entries, setEntries] = useState<BuilderEntry[]>([]);
  /**
   * A new entry being composed. It lives in `entries` so the editor, pickers and
   * folder controls work on it unchanged, and is kept out of everything derived
   * until it is added: the rail, the exports, the catalogs an apply would create
   * and the unsaved-changes check.
   */
  const [draftId, setDraftId] = useState<string | null>(null);

  const committedEntries = useMemo(
    () => (draftId ? entries.filter(entry => entry.id !== draftId) : entries),
    [entries, draftId]
  );

  /** Entries as they stood when opened or last applied, to spot real edits. */
  const [baseline, setBaseline] = useState('[]');
  const [selection, setSelection] = useState<{ entryId: string; folderId: string | null }>(
    { entryId: '', folderId: null }
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState('design');
  const [exportOpen, setExportOpen] = useState(false);
  // Only consulted below @2xl, where the panes cannot sit side by side.
  const [mobilePane, setMobilePane] = useState<'entries' | 'editor' | 'preview'>('entries');
  const [view, setView] = useState<'build' | 'featured'>('build');
  const [featuredError, setFeaturedError] = useState('');
  const [importPreviewIndex, setImportPreviewIndex] = useState(0);
  const [featuredPreview, setFeaturedPreview] = useState<
    { featured: FeaturedCollection; text: string; entries: BuilderEntry[]; index: number; skipped: Set<string> } | null
  >(null);
  const [railQuery, setRailQuery] = useState('');
  const [showManifestField, setShowManifestField] = useState(false);
  const [titleFocusId, setTitleFocusId] = useState<string | null>(null);
  const clearTitleFocus = useCallback(() => setTitleFocusId(null), []);

  const selectedId = selection.entryId || null;
  const setSelectedId = useCallback((id: string | null) => {
    setSelection({ entryId: id ?? '', folderId: null });
  }, []);
  const [target, setTarget] = useState<Target>('nuvio');

  const [manifestUrl, setManifestUrl] = useState('');
  const [usePlaceholder, setUsePlaceholder] = useState(false);
  const [sourceList, setSourceList] = useState<CatalogSourceList>({ catalogs: [], origin: 'derived' });
  /** Bumped when a save lands, since that is when the manifest changes underneath. */
  const [sourceReloadKey, setSourceReloadKey] = useState(0);
  const [manifestIdentity, setManifestIdentity] = useState<Partial<AddonIdentity>>({});
  const [pickerTarget, setPickerTarget] = useState<{ entryId: string; folderId: string | null; replaceIndex?: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importFetching, setImportFetching] = useState(false);
  const [importUrlError, setImportUrlError] = useState('');
  const [importPreview, setImportPreview] = useState<ImportResult | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [stagedBlueprints, setStagedBlueprints] = useState<CatalogBlueprint[]>([]);
  /**
   * Sources this session brought in. Only these may have a catalog rebuilt from
   * their id, so a source the user already had stops resurrecting a catalog they
   * deleted from the config.
   */
  const [sessionSourceKeys, setSessionSourceKeys] = useState<Set<string>>(new Set());
  const [convertNative, setConvertNative] = useState(false);
  const [overLimitOpen, setOverLimitOpen] = useState(false);
  const [nativeBlockFor, setNativeBlockFor] = useState<'apply' | 'copy' | 'download' | 'link' | null>(null);
  const terms = TERMS[target];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // The dashboard can change the catalog ceiling while this page is open, and the
  // value was otherwise read once at boot.
  // A user who arrives without a saved config has no manifest URL, then saves from
  // in here and gets one. The reset effect above runs on open only, so without
  // this the field stays empty and the share tab keeps asking them to save.
  // Only fills a blank, so a URL typed by hand is left alone.
  useEffect(() => {
    if (!isOpen || !auth.userUUID) return;
    setManifestUrl(current => current || buildManifestUrl(auth.userUUID));
  }, [isOpen, auth.userUUID]);

  useEffect(() => {
    if (!isOpen) return;
    void refreshInstanceLimits();
    // This dialog stays mounted when closed, so a preview left open would still
    // be sitting there on the way back in.
    setFeaturedPreview(null);
    setDraftId(null);
  }, [isOpen, refreshInstanceLimits]);

  useEffect(() => {
    if (!isOpen) return;
    const saved = clone(config.collections || []) as BuilderEntry[];
    setEntries(saved);
    // Nothing built yet is the one moment the gallery is worth more than the
    // builder, so it opens there. Anyone with collections lands on their own.
    const focus = saved.find(entry => entry.id === initialEntryId)?.id ?? saved[0]?.id;
    setView(!startNew && !initialEntryId && saved.length === 0 && FEATURED_COLLECTIONS.length > 0 ? 'featured' : 'build');
    setBaseline(JSON.stringify(saved));
    setSelectedId(focus ?? null);
    setStagedBlueprints([]);
    setSessionSourceKeys(new Set());
    setActiveTab('design');
    setRailQuery('');
    setExpandedIds(new Set(focus ? [focus] : []));
    setTitleFocusId(null);
    setManifestUrl(buildManifestUrl(auth.userUUID));
    if (initialEntryId && focus === initialEntryId) setMobilePane('editor');
    if (startNew) addEntry(createCollectionDraft());
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    loadCatalogSources(config, manifestUrl).then(result => {
      if (cancelled) return;
      setSourceList({ catalogs: result.catalogs, origin: result.origin, error: result.error });
      setManifestIdentity(result.identity);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, manifestUrl, config.catalogs, sourceReloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (sourceList.catalogs.length === 0) return;
    const healed = fillMissingGenres(
      healSourceNames(
        realignSourceIds(entries, sourceList.catalogs),
        sourceList.catalogs
      ),
      sourceList.catalogs
    ).entries;
    if (healed === entries) return;
    setEntries(healed);
    // Only carry the baseline along if nothing else had been edited yet,
    // otherwise healing would quietly mark real work as saved.
    if (JSON.stringify(entries) === baseline) setBaseline(JSON.stringify(healed));
  }, [sourceList.catalogs, entries, baseline]);

  const identity = useMemo(
    () => buildIdentity(config, manifestUrl, manifestIdentity),
    [config, manifestUrl, manifestIdentity]
  );

  // Catalogs ride along with the file so an importer who does not have them can
  // rebuild them instead of adding each one by hand.
  const blueprints = useMemo(
    () => buildBlueprintLookup(config.catalogs as ShareableCatalog[]),
    [config.catalogs]
  );

  // Images routed through the instance's cache, when it has one and the config asks for it.
  const [imagePrefix, setImagePrefix] = useState('');
  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/collections/image-prefix')
      .then(r => (r.ok ? r.json() : null))
      .then(data => setImagePrefix(typeof data?.prefix === 'string' ? data.prefix : ''))
      .catch(() => setImagePrefix(''));
  }, [isOpen]);
  const imagesViaCache = Boolean(config.collectionImagesViaCache) && Boolean(imagePrefix);
  const exportEntries = useMemo(
    () => (imagesViaCache ? proxyCollectionImages(committedEntries, imagePrefix) : committedEntries),
    [committedEntries, imagesViaCache, imagePrefix]
  );

  const nuvioResult = useMemo(
    () => toNuvioCollections(exportEntries, identity, blueprints, { usePlaceholder }),
    [exportEntries, identity, blueprints, usePlaceholder]
  );
  const json = useMemo(
    () => JSON.stringify(target === 'nuvio' ? nuvioResult.output : toLayoutFile(exportEntries, blueprints), null, 2),
    [target, nuvioResult, exportEntries, blueprints]
  );

  const notes: ExportNote[] = useMemo(
    () => (target === 'nuvio' ? nuvioResult.notes : jellyfinNotes(committedEntries)),
    [target, nuvioResult, committedEntries]
  );

  const unknownSources = useMemo(
    () => findUnknownSources(committedEntries, sourceList.catalogs),
    [committedEntries, sourceList.catalogs]
  );
  const [confirmApply, setConfirmApply] = useState(false);
  const [pendingMode, setPendingMode] = useState<'apply' | 'save'>('apply');
  const [confirmClose, setConfirmClose] = useState(false);

  const { requestSave, isSaving, isDirty: configDirty, canSave: configCanSave, missingKeys } = useSave();
  const [pendingSave, setPendingSave] = useState(false);
  const appliedSnapshot = useRef<string | null>(null);

  // A save regenerates the manifest, and the picker is built from it, so a
  // catalog deleted before opening only reads as gone once the save has landed.
  const wasSaving = useRef(false);
  useEffect(() => {
    if (wasSaving.current && !isSaving) setSourceReloadKey(key => key + 1);
    wasSaving.current = isSaving;
  }, [isSaving]);

  const builderJson = useMemo(() => JSON.stringify(committedEntries), [committedEntries]);
  const savedJson = useMemo(() => JSON.stringify(config.collections || []), [config.collections]);
  const stage = useMemo(
    () => deriveSaveStage({ builderJson, configJson: savedJson, configDirty }),
    [builderJson, savedJson, configDirty]
  );
  const stageCopy = describeSaveStage(stage, target);

  // requestSave closes over config, so saving in the same tick as the apply
  // would store the version from before it. This waits for the config to catch up.
  useEffect(() => {
    if (!pendingSave) return;
    if (savedJson !== appliedSnapshot.current) return;
    setPendingSave(false);
    requestSave();
  }, [pendingSave, savedJson, requestSave]);
  const [remapOpen, setRemapOpen] = useState(false);
  const [remapChoices, setRemapChoices] = useState<Record<string, SourceDraft>>({});
  const [remapPickFor, setRemapPickFor] = useState<string | null>(null);

  const applyRemap = () => {
    const { entries: next, replaced } = remapSources(entries, remapChoices);
    setEntries(next);
    setRemapOpen(false);
    setRemapChoices({});
    toast.success(replaced === 1 ? '1 source repointed' : `${replaced} sources repointed`);
  };

  const selected = entries.find(entry => entry.id === selectedId) || null;

  const visibleTree = useMemo(
    () => filterEntryTree(committedEntries, railQuery).map(({ entry, matchedFolderIds }) => ({
      entry,
      // Reorder targets have to come from the full list, or a move made while
      // filtering would land in the wrong slot.
      folders: entry.kind === 'collection'
        ? entry.folders
            .map((folder, folderIndex) => ({ folder, folderIndex }))
            .filter(({ folder }) => !matchedFolderIds || matchedFolderIds.has(folder.id))
        : [],
      forceExpand: matchedFolderIds !== null,
    })),
    [committedEntries, railQuery]
  );

  const railItemIds = useMemo(() => {
    const ids: string[] = [];
    for (const { entry, folders, forceExpand } of visibleTree) {
      ids.push(entry.id);
      if (forceExpand || expandedIds.has(entry.id)) for (const { folder } of folders) ids.push(folder.id);
    }
    return ids;
  }, [visibleTree, expandedIds]);

  const folderOwners = useMemo(() => {
    const owners = new Map<string, string>();
    for (const entry of entries) {
      if (entry.kind !== 'collection') continue;
      for (const folder of allFolders(entry.folders)) owners.set(folder.id, entry.id);
    }
    return owners;
  }, [entries]);

  const updateEntry = useCallback((next: BuilderEntry) => {
    setEntries(prev => prev.map(entry => (entry.id === next.id ? next : entry)));
  }, []);

  const addEntry = (entry: BuilderEntry) => {
    setEntries(prev => [...prev, entry]);
    setDraftId(entry.id);
    setSelectedId(entry.id);
    setActiveTab('design');
    setTitleFocusId(entry.id);
    setMobilePane('editor');
  };

  const commitDraft = () => {
    if (!draftId) return;
    setDraftId(null);
    setMobilePane('entries');
  };

  const discardDraft = () => {
    if (!draftId) return;
    const id = draftId;
    setDraftId(null);
    setEntries(prev => prev.filter(entry => entry.id !== id));
    setSelectedId(committedEntries[0]?.id ?? null);
    setTitleFocusId(null);
    setMobilePane('entries');
  };

  /**
   * Deletes here are frequent and mostly intended, so they undo rather than ask.
   * Undo is the inverse of the one change rather than a whole-draft snapshot, so
   * anything edited while the toast is still up survives it.
   */
  const undoableUpdate = (
    label: string,
    apply: (prev: BuilderEntry[]) => BuilderEntry[],
    undo: (prev: BuilderEntry[]) => BuilderEntry[]
  ) => {
    setEntries(apply);
    toast.success(label, { action: { label: 'Undo', onClick: () => setEntries(undo) }, duration: 6000 });
  };

  const removeEntry = (id: string) => {
    if (id === draftId) { discardDraft(); return; }
    const at = entries.findIndex(entry => entry.id === id);
    if (at < 0) return;
    const doomed = entries[at];
    const remaining = entries.filter(entry => entry.id !== id);
    if (selectedId === id) setSelectedId(remaining[0]?.id ?? null);
    undoableUpdate(
      `Deleted ${doomed.title || 'entry'}`,
      prev => prev.filter(entry => entry.id !== id),
      prev => (prev.some(entry => entry.id === id)
        ? prev
        : [...prev.slice(0, at), doomed, ...prev.slice(at)])
    );
  };

  const editEntryUndoable = (
    label: string,
    entryId: string,
    apply: (entry: CollectionDraft) => CollectionDraft,
    undo: (entry: CollectionDraft) => CollectionDraft
  ) => {
    const over = (fn: (entry: CollectionDraft) => CollectionDraft) => (prev: BuilderEntry[]) =>
      prev.map(entry => (entry.id === entryId && entry.kind === 'collection' ? fn(entry) : entry));
    undoableUpdate(label, over(apply), over(undo));
  };

  const goToProblem = (entryId: string | null, folderId: string | null) => {
    if (!entryId) return;
    setSelection({ entryId, folderId });
    setActiveTab('design');
    if (folderId) setExpandedIds(prev => new Set(prev).add(entryId));
  };

  useEffect(() => {
    if (!selection.entryId) return;
    setExpandedIds(prev => (prev.has(selection.entryId) ? prev : new Set(prev).add(selection.entryId)));
  }, [selection.entryId]);

  const handleRailDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const activeOwner = folderOwners.get(activeId);
    const overOwner = folderOwners.get(overId);

    if (activeOwner) {
      const destinationId = overOwner ?? overId;
      if (destinationId === activeOwner) {
        setEntries(prev => prev.map(entry => {
          if (entry.id !== activeOwner || entry.kind !== 'collection') return entry;
          const from = entry.folders.findIndex(folder => folder.id === activeId);
          const to = entry.folders.findIndex(folder => folder.id === overId);
          if (from < 0 || to < 0) return entry;
          return { ...entry, folders: arrayMove(entry.folders, from, to) };
        }));
        return;
      }
      const destination = entries.find(entry => entry.id === destinationId);
      if (!destination || destination.kind !== 'collection') {
        toast.error(`${terms.row}s hold one catalog, so a ${terms.child.toLowerCase()} cannot move into one.`);
        return;
      }
      setEntries(prev => {
        const source = prev.find(entry => entry.id === activeOwner);
        if (!source || source.kind !== 'collection') return prev;
        const moved = source.folders.find(folder => folder.id === activeId);
        if (!moved) return prev;
        return prev.map(entry => {
          if (entry.kind !== 'collection') return entry;
          if (entry.id === activeOwner) {
            return { ...entry, folders: entry.folders.filter(folder => folder.id !== activeId) };
          }
          if (entry.id === destinationId) {
            const at = entry.folders.findIndex(folder => folder.id === overId);
            const folders = [...entry.folders];
            folders.splice(at < 0 ? folders.length : at, 0, moved);
            return { ...entry, folders };
          }
          return entry;
        });
      });
      setExpandedIds(prev => new Set(prev).add(destinationId));
      setSelection({ entryId: destinationId, folderId: activeId });
      return;
    }

    const overEntryId = overOwner ?? overId;
    setEntries(prev => {
      const from = prev.findIndex(entry => entry.id === activeId);
      const to = prev.findIndex(entry => entry.id === overEntryId);
      if (from < 0 || to < 0 || from === to) return prev;
      return arrayMove(prev, from, to);
    });
  };

  const moveEntryTo = (index: number, position: 'top' | 'bottom') => {
    setEntries(prev => {
      const to = position === 'top' ? 0 : prev.length - 1;
      if (to === index) return prev;
      return arrayMove(prev, index, to);
    });
  };

  const duplicateEntry = (id: string) => {
    const original = entries.find(entry => entry.id === id);
    if (!original) return;
    const copy = duplicateEntryDraft(original);
    setEntries(prev => {
      const at = prev.findIndex(entry => entry.id === id);
      if (at < 0) return prev;
      return [...prev.slice(0, at + 1), copy, ...prev.slice(at + 1)];
    });
    setSelectedId(copy.id);
    setTitleFocusId(copy.id);
    setMobilePane('editor');
  };

  const overEntry = (entryId: string, fn: (entry: CollectionDraft) => CollectionDraft) =>
    (prev: BuilderEntry[]) =>
      prev.map(item => (item.id === entryId && item.kind === 'collection' ? fn(item) : item));

  const moveFolderTo = (entryId: string, index: number, position: 'top' | 'bottom') => {
    setEntries(overEntry(entryId, entry => ({
      ...entry,
      folders: arrayMove(entry.folders, index, position === 'top' ? 0 : entry.folders.length - 1),
    })));
  };

  const addFolderIn = (entryId: string) => {
    const folder = createFolderDraft();
    setEntries(overEntry(entryId, current => ({ ...current, folders: [...current.folders, folder] })));
    setSelection({ entryId, folderId: folder.id });
    setTitleFocusId(folder.id);
  };

  const addSubFolderIn = (entryId: string, parentId: string) => {
    const folder = createFolderDraft();
    setEntries(overEntry(entryId, current => ({
      ...current,
      folders: mapFolder(current.folders, parentId, parent => ({ ...parent, folders: [...subFolders(parent), folder] })),
    })));
    setSelection({ entryId, folderId: folder.id });
    setTitleFocusId(folder.id);
  };

  const removeSubFolderIn = (entryId: string, folderId: string) => {
    const entry = entries.find(item => item.id === entryId);
    if (!entry || entry.kind !== 'collection') return;
    const doomed = findFolder(entry.folders, folderId);
    const parent = parentFolderOf(entry.folders, folderId);
    if (!doomed || !parent) return;
    const at = subFolders(parent).findIndex(f => f.id === folderId);
    setSelection({ entryId, folderId: parent.id });
    editEntryUndoable(
      `Deleted ${doomed.title || 'folder'}`,
      entryId,
      current => ({ ...current, folders: removeFolder(current.folders, folderId) }),
      current => (findFolder(current.folders, folderId)
        ? current
        : {
          ...current,
          folders: mapFolder(current.folders, parent.id, p => {
            const children = [...subFolders(p)];
            children.splice(Math.min(at, children.length), 0, doomed);
            return { ...p, folders: children };
          }),
        })
    );
  };

  const duplicateFolderIn = (entryId: string, index: number) => {
    const entry = entries.find(item => item.id === entryId);
    if (!entry || entry.kind !== 'collection') return;
    const original = entry.folders[index];
    if (!original) return;
    const copy = { ...clone(original), id: newId(), title: nextCopyTitle(original.title) };
    setEntries(overEntry(entryId, current => ({
      ...current,
      folders: [...current.folders.slice(0, index + 1), copy, ...current.folders.slice(index + 1)],
    })));
    setSelection({ entryId, folderId: copy.id });
    setTitleFocusId(copy.id);
  };

  const removeFolderIn = (entryId: string, index: number) => {
    const entry = entries.find(item => item.id === entryId);
    if (!entry || entry.kind !== 'collection') return;
    const doomed = entry.folders[index];
    if (!doomed) return;
    setSelection(current => (current.folderId === doomed.id ? { entryId, folderId: null } : current));
    editEntryUndoable(
      `Deleted ${doomed.title || 'folder'}`,
      entryId,
      current => ({ ...current, folders: current.folders.filter(f => f.id !== doomed.id) }),
      current => (current.folders.some(f => f.id === doomed.id)
        ? current
        : { ...current, folders: [...current.folders.slice(0, index), doomed, ...current.folders.slice(index)] })
    );
  };

  const pickerExistingKeys = useMemo(() => {
    if (!pickerTarget) return [];
    // Replacing is a single pick, so nothing needs to be marked as already added.
    if (typeof pickerTarget.replaceIndex === 'number') return [];
    const entry = entries.find(item => item.id === pickerTarget.entryId);
    if (!entry || entry.kind !== 'collection') return [];
    const folder = pickerTarget.folderId ? findFolder(entry.folders, pickerTarget.folderId) : undefined;
    return folder ? folder.sources.map(catalogKey) : [];
  }, [pickerTarget, entries, committedEntries]);

  /** Only tags that actually cover a catalog the user can use. */
  const tagOptions: TagOption[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const catalog of sourceList.catalogs) {
      for (const tag of catalog.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return (config.tags ?? [])
      .filter(tag => counts.has(tag.name))
      .map(tag => ({ name: tag.name, color: tag.color, count: counts.get(tag.name) ?? 0 }));
  }, [sourceList.catalogs, config.tags]);

  // Below tagOptions: it reads that, and a const is dead until its own line runs.
  const starters = useMemo(
    () => listStarterTemplates({ catalogs: sourceList.catalogs, tags: tagOptions }),
    [sourceList.catalogs, tagOptions]
  );

  const addSourcesByTag = (entryId: string, folderId: string, tag: string) => {
    const matching = sourceList.catalogs.filter(catalog => (catalog.tags ?? []).includes(tag));
    if (matching.length === 0) return;

    let added = 0;
    setEntries(prev => prev.map(entry => {
      if (entry.id !== entryId || entry.kind !== 'collection') return entry;
      return {
        ...entry,
        folders: mapFolder(entry.folders, folderId, folder => {
          const existing = new Set(folder.sources.map(catalogKey));
          const incoming = matching
            .filter(catalog => !existing.has(catalogKey(catalog)))
            .map(sourceFromCatalog);
          added = incoming.length;
          return { ...folder, sources: [...folder.sources, ...incoming] };
        }),
      };
    }));

    const skipped = matching.length - added;
    toast.success(
      `${added} ${added === 1 ? 'catalog' : 'catalogs'} added from "${tag}"` +
      (skipped > 0 ? `, ${skipped} already there` : '')
    );
  };

  const isDirty = builderJson !== baseline;

  const requestClose = () => {
    if (isDirty) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  const handleCreateSources = (created: CatalogConfig[]) => {
    if (created.length === 0) return;
    setConfig(prev => {
      const known = new Set(prev.catalogs.map(catalog => `${catalog.id}:${catalog.type}`));
      const fresh = created.filter(catalog => !known.has(`${catalog.id}:${catalog.type}`));
      return fresh.length > 0 ? { ...prev, catalogs: [...prev.catalogs, ...fresh] } : prev;
    });
    handlePick(created.map(deriveManifestCatalog));
  };

  /**
   * Renames the catalog itself rather than this one tile, so it lands in the
   * config the same way the catalogs list writes it. The manifest is the usual
   * source of these labels and will not carry the new name until a save, so the
   * loaded list is patched too; healSourceNames then carries it into the drafts.
   */
  const renameCatalog = (source: SourceDraft, name: string) => {
    const key = catalogKey(source);
    setConfig(prev => ({
      ...prev,
      catalogs: (prev.catalogs || []).map(catalog =>
        catalogKey(deriveManifestCatalog(catalog)) === key || catalogKey(catalog) === key
          ? { ...catalog, name }
          : catalog
      ),
    }));
    setSourceList(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(catalog =>
        catalogKey(catalog) === key ? { ...catalog, name } : catalog
      ),
    }));
    // A staged blueprint outranks the draft's own name when the catalog is built,
    // so a rename before an apply has to reach it as well.
    setStagedBlueprints(prev =>
      prev.map(blueprint =>
        catalogKey({ id: blueprint.id, type: blueprint.type }) === key
          ? { ...blueprint, name }
          : blueprint
      )
    );
    toast.success(`Renamed to "${name}"`);
  };

  const handlePick = (picked: ManifestCatalog[]) => {
    if (!pickerTarget || picked.length === 0) return;
    const sources: SourceDraft[] = picked.map(sourceFromCatalog);
    setEntries(prev =>
      prev.map(entry => {
        if (entry.id !== pickerTarget.entryId) return entry;
        if (entry.kind === 'classicRow') {
          const untitled = !entry.title.trim() || entry.title === createClassicRowDraft().title;
          return { ...entry, source: sources[0], ...(untitled ? { title: sources[0].name } : {}) };
        }
        return {
          ...entry,
          folders: mapFolder(entry.folders, String(pickerTarget.folderId), folder => {
            if (typeof pickerTarget.replaceIndex === 'number') {
              const swapped = folder.sources.map((existing, index) =>
                index === pickerTarget.replaceIndex ? sources[0] : existing
              );
              // The replacement may already be elsewhere in this folder.
              const seen = new Set<string>();
              return {
                ...folder,
                sources: swapped.filter(source => {
                  const key = catalogKey(source);
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                }),
              };
            }

            const existing = new Set(folder.sources.map(catalogKey));
            const added = sources.filter(source => !existing.has(catalogKey(source)));
            return { ...folder, sources: [...folder.sources, ...added] };
          }),
        };
      })
    );
    setPickerTarget(null);
  };

  const applyToConfig = (options: { withCatalogs?: boolean; thenSave?: boolean } = {}) => {
    const addCatalogs = options.withCatalogs !== false && pendingCount > 0;
    const cleaned = clone(committedEntries).map(currentFields);
    const rowCount = cleaned.filter(entry => entry.kind === 'classicRow').length;
    const folded = rowCount > 0
      ? foldRows({ catalogs: addCatalogs ? applyCatalogAdditions(config.catalogs || [], pendingAdditions) : config.catalogs || [] }, cleaned)
      : null;
    const applied: BuilderEntry[] = folded ? folded.collections : cleaned;

    setConfig(prev => folded
      ? { ...prev, collections: applied, catalogs: folded.catalogs as CatalogConfig[] }
      : {
          ...prev,
          collections: applied,
          ...(addCatalogs && { catalogs: applyCatalogAdditions(prev.catalogs || [], pendingAdditions) }),
        });
    setEntries(prev => (folded ? [...clone(applied), ...prev.filter(entry => entry.id === draftId)] : prev.map(currentFields)));
    setBaseline(JSON.stringify(applied));
    if (rowCount > 0) {
      toast.success(rowCount === 1 ? 'The row became row options on its catalog' : `${rowCount} rows became row options on their catalogs`);
    }
    if (addCatalogs) setStagedBlueprints([]);

    const catalogNote = addCatalogs
      ? ` ${pendingCount} catalog${pendingCount === 1 ? '' : 's'} added.`
      : '';

    if (options.thenSave && configCanSave) {
      appliedSnapshot.current = JSON.stringify(applied);
      setPendingSave(true);
      return;
    }

    toast.success(
      (applied.length === 1 ? '1 entry applied.' : `${applied.length} entries applied.`) + catalogNote,
      options.thenSave
        ? { description: `Not saved: ${missingKeyNames.join(', ')} still needs filling in on the Configuration tab.` }
        : undefined
    );
  };

  /** False when a gate took over, so callers can hold off on closing. */
  const handleSave = (mode: 'apply' | 'save', limits?: InstanceLimits | null): boolean => {
    // Save is already disabled here, but Apply only is not, so it still has to
    // be caught here. The issue list is the advance notice.
    if (strandedNative > 0) {
      setPendingMode(mode);
      setNativeBlockFor('apply');
      return false;
    }
    // A ceiling raised in the dashboard a moment ago is read here, rather than
    // the one this page loaded with.
    const liveLimit = limits ? (limits.maxCatalogs ?? limits.collectionImportCatalogCap) : catalogLimit;
    const liveOverBy = Math.max(0, pendingCount - Math.max(0, liveLimit - enabledCatalogCount));
    if (liveOverBy > 0) {
      setPendingMode(mode);
      setOverLimitOpen(true);
      return false;
    }
    // Catalogs nothing can rebuild render as empty rows rather than breaking
    // anything, so this asks rather than refuses.
    if (unresolvedSources.length > 0) {
      setPendingMode(mode);
      setConfirmApply(true);
      return false;
    }
    applyToConfig({ thenSave: mode === 'save' });
    return true;
  };

  const subDialogOpen = importOpen
    || pickerTarget !== null
    || remapOpen
    || confirmApply
    || confirmClose
    || overLimitOpen
    || nativeBlockFor !== null;

  useEffect(() => {
    if (!isOpen || subDialogOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 's' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (isSaving || !verdict.canSave) return;
      handleSave('save');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const hostedUrl = useMemo(() => {
    const base = stripManifestSuffix(manifestUrl);
    if (!base) return '';
    return `${base}/${target === 'nuvio' ? 'nuvio-collections' : 'aiometadata-collections'}.json`;
  }, [manifestUrl, target]);

  // What a featured design was trimmed to survives a re-read of the same text.
  const [importSkip, setImportSkip] = useState<Set<string>>(() => new Set());

  const previewImport = (text: string, convert = convertNative, skip: Set<string> = new Set()) => {
    setImportText(text);
    setImportSkip(skip);
    setImportPreviewIndex(0);
    setImportPreview(text.trim() ? withoutEntries(parseImport(text, { convertNative: convert }), skip) : null);
  };

  const toggleConvertNative = (next: boolean) => {
    setConvertNative(next);
    if (importText.trim()) previewImport(importText, next, importSkip);
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    previewImport(await file.text());
  };

  const loadImportUrl = async (raw?: string) => {
    const url = (raw ?? importUrl).trim();
    if (!url || importFetching) return;
    try {
      const { protocol } = new URL(url);
      if (protocol !== 'http:' && protocol !== 'https:') throw new Error('unsupported protocol');
    } catch {
      setImportUrlError('That is not a link. It has to start with http:// or https://.');
      return;
    }

    const read = async (from: string) => {
      const response = await fetch(from);
      const body = await response.text();
      if (!response.ok) {
        let message = `The link returned ${response.status}.`;
        try {
          message = JSON.parse(body)?.error || message;
        } catch {
          /* empty */
        }
        throw new Error(message);
      }
      return body;
    };

    setImportFetching(true);
    setImportUrlError('');
    try {
      let body: string;
      try {
        body = await read(url);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        body = await read(`/api/proxy-manifest?url=${encodeURIComponent(url)}`);
      }
      previewImport(body);
    } catch (error) {
      setImportPreview(null);
      setImportText('');
      setImportUrlError(error instanceof Error ? error.message : 'Could not read that link.');
    } finally {
      setImportFetching(false);
    }
  };

  // Rendered in the preview pane rather than a dialog, so the design you are
  // considering sits beside the one you already have instead of covering it.
  const loadFeatured = async (featured: FeaturedCollection) => {
    setImportFetching(true);
    setFeaturedError('');
    try {
      const url = new URL(featured.url, window.location.origin).toString();
      let response = await fetch(url).catch(() => null);
      if (!response || !response.ok) {
        response = await fetch(`/api/proxy-manifest?url=${encodeURIComponent(url)}`);
      }
      if (!response.ok) throw new Error(`That link answered ${response.status}.`);
      const text = await response.text();
      const parsed = parseImport(text, { convertNative: false });
      if (!parsed.entries.length) throw new Error('Nothing importable in that file.');
      setFeaturedPreview({ featured, text, entries: parsed.entries, index: 0, skipped: new Set() });
    } catch (error) {
      setFeaturedError(error instanceof Error ? error.message : 'Could not read that collection.');
    } finally {
      setImportFetching(false);
    }
  };

  const importFeaturedPreview = () => {
    if (!featuredPreview) return;
    setImportOpen(true);
    previewImport(featuredPreview.text, convertNative, featuredPreview.skipped);
  };

  const handleImportPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData.getData('text').trim();
    if (!/^https?:\/\/\S+$/i.test(pasted)) return;
    event.preventDefault();
    setImportUrl(pasted);
    void loadImportUrl(pasted);
  };

  const importCounts = useMemo(
    () => (importPreview
      ? countImport(importPreview.entries, committedEntries)
      : null),
    [importPreview, committedEntries]
  );

  // Realigned first, so the panel counts what the import will add, not what it spells.
  const importUnknown = useMemo(
    () => (importPreview
      ? findUnknownSources(
          realignSourceIds(importPreview.entries, sourceList.catalogs),
          sourceList.catalogs
        )
      : []),
    [importPreview, sourceList.catalogs]
  );

  /** What the file being previewed would add on its own, for the import panel. */
  const importAdditions: CatalogAdditions = useMemo(
    () => (importPreview
      ? resolveCatalogAdditions(
          config.catalogs || [],
          importPreview.blueprints,
          importUnknown,
          config.apiKeys || {}
        )
      : {
        added: [],
        enabled: [],
        resolved: new Set<string>(),
        needsAccount: [],
        needsAccountKeys: new Set<string>(),
        absorbed: [],
        partialMerges: [],
      }),
    [importPreview, importUnknown, config.catalogs, config.apiKeys]
  );

  const rebuildable = additionCount(importAdditions);

  const importUnresolved = useMemo(
    () => importUnknown.filter(
      source => !importAdditions.resolved.has(`${source.catalogId}:${source.type}`)
    ),
    [importUnknown, importAdditions]
  );

  /**
   * Imported catalogs wait here rather than going straight into the config. A
   * community file can reference thousands, and which of them are actually
   * needed depends on what survives editing, so they are resolved against the
   * current design and only written on apply.
   */
  const pendingAdditions: CatalogAdditions = useMemo(
    () => resolveCatalogAdditions(
      config.catalogs || [],
      stagedBlueprints,
      unknownSources,
      config.apiKeys || {},
      sessionSourceKeys
    ),
    [config.catalogs, stagedBlueprints, unknownSources, config.apiKeys, sessionSourceKeys]
  );

  const pendingCount = additionCount(pendingAdditions);

  /**
   * Sources that resolve to a catalog an apply would add. They are absent from
   * the manifest, so without this they would read as missing rather than staged.
   * A catalog waiting on an account it does not have is resolved but not added,
   * so it stays out: it is missing, and saying otherwise is the more costly lie.
   */
  const pendingKeys = useMemo(() => {
    if (pendingCount === 0) return new Set<string>();
    const { resolved, needsAccountKeys } = pendingAdditions;
    if (needsAccountKeys.size === 0) return resolved;
    return new Set([...resolved].filter(key => !needsAccountKeys.has(key)));
  }, [pendingAdditions, pendingCount]);

  const issueCatalogs = useMemo(
    () => withStagedCatalogs(sourceList.catalogs, pendingKeys),
    [sourceList.catalogs, pendingKeys]
  );

  const issues = useMemo(() => findSourceIssues(committedEntries, issueCatalogs), [committedEntries, issueCatalogs]);

  const problemTargets = useMemo(() => buildProblemTargets(committedEntries), [committedEntries]);

  const countNative = useCallback((entry: BuilderEntry) => {
    return entrySources(entry).filter(isNativeSource).length;
  }, []);

  const countStranded = useCallback((entry: BuilderEntry) => {
    return entrySources(entry).filter(source => isStrandedNative(source, target)).length;
  }, [target]);

  /** Takes over client-resolved sources, in the narrowest scope the caller names. */
  const convertNativeSources = useCallback((entryId?: string, folderId?: string) => {
    const rebuilt: CatalogBlueprint[] = [];
    const convertedKeys: string[] = [];
    let converted = 0;
    let kept = 0;

    setEntries(prev => prev.map(entry => {
      if (entryId !== undefined && entry.id !== entryId) return entry;

      if (entry.kind === 'classicRow') {
        if (folderId !== undefined) return entry;
        const source = entry.source;
        if (!source || !isNativeSource(source) || !source.native) return entry;
        const result = fromAnyNativeSource(source.native, nativeOrigin(source));
        if (result.ok !== true) {
          kept += 1;
          return entry;
        }
        rebuilt.push(result.blueprint);
        convertedKeys.push(`${result.source.catalogId}:${result.source.type}`);
        converted += 1;
        return { ...entry, source: result.source };
      }

      return {
        ...entry,
        folders: mapFoldersDeep(entry.folders, folder => {
          if (folderId !== undefined && folder.id !== folderId) return folder;
          const seen = new Set<string>();
          const sources: SourceDraft[] = [];
          for (const source of folder.sources) {
            let next = source;
            if (isNativeSource(source) && source.native) {
              const result = fromAnyNativeSource(source.native, nativeOrigin(source));
              if (result.ok === true) {
                rebuilt.push(result.blueprint);
                next = result.source;
                convertedKeys.push(`${next.catalogId}:${next.type}`);
                converted += 1;
              } else {
                kept += 1;
              }
            }
            const key = `${next.catalogId}:${next.type}`;
            if (seen.has(key)) continue;
            seen.add(key);
            sources.push(next);
          }
          return { ...folder, sources };
        }),
      };
    }));

    if (rebuilt.length > 0) {
      setStagedBlueprints(prev => dedupeBlueprints([...prev, ...rebuilt]));
      setSessionSourceKeys(prev => new Set([...prev, ...convertedKeys]));
    }

    if (converted === 0) {
      toast.info('Nothing here could be routed through AIOMetadata');
      return;
    }
    toast.success(
      `${converted} source${converted === 1 ? '' : 's'} routed through AIOMetadata`,
      kept > 0
        ? { description: `${kept} had no equivalent here and stay with the app.` }
        : undefined
    );
  }, []);

  /** How much of the design the selected target would drop, for the warning. */
  const tileTotal = useMemo(
    () => entries.reduce((sum, entry) => sum + (entry.kind === 'collection' ? entry.folders.length : 0), 0),
    [entries]
  );

  /** Tiles the target still gets, but with nothing in them. A sourceless tile exports. */
  const emptyTiles = useMemo(() => {
    if (target === 'nuvio') {
      return nuvioResult.output.reduce(
        (sum, collection) => sum + collection.folders.filter(folder => folder.sources.length === 0).length,
        0
      );
    }
    return committedEntries.reduce(
      (sum, entry) => sum + (entry.kind === 'collection'
        ? entry.folders.filter(folder => folderSources(folder).every(isNativeSource)).length
        : 0),
      0
    );
  }, [target, nuvioResult, committedEntries]);

  const strandedNative = useMemo(
    () => committedEntries.reduce((sum, entry) => sum + countStranded(entry), 0),
    [committedEntries, countStranded]
  );

  const totalNative = useMemo(
    () => committedEntries.reduce((sum, entry) => sum + countNative(entry), 0),
    [committedEntries, countNative]
  );

  const strandedTarget = useMemo(() => (target === 'jellyfin'
    ? { here: 'Jellyfin', other: 'Nuvio' as string | null, otherId: 'nuvio' as Target }
    : { here: 'Nuvio', other: null as string | null, otherId: 'nuvio' as Target }
  ), [target]);

  const entryIsStranded = useCallback((entry: BuilderEntry) => {
    const sources = entry.kind === 'classicRow'
      ? (entry.source ? [entry.source] : [])
      : entry.folders.flatMap(folder => folder.sources);
    return sources.length > 0 && sources.every(source => isStrandedNative(source, target));
  }, [target]);

  /** Sources the design points at that nothing in the config or the file can serve. */
  const unresolvedSources = useMemo(
    () => unknownSources.filter(
      source => !pendingAdditions.resolved.has(`${source.catalogId}:${source.type}`)
    ),
    [unknownSources, pendingAdditions]
  );

  const missingGroups: MissingCatalogGroup[] = useMemo(
    () => groupMissingCatalogs(unresolvedSources),
    [unresolvedSources]
  );

  const enabledCatalogCount = useMemo(
    () => (config.catalogs || []).filter(catalog => catalog.enabled !== false).length,
    [config.catalogs]
  );

  // The instance ceiling when it has one, otherwise the import's own cap, which
  // exists so an unlimited instance is not handed a manifest of thousands.
  const catalogLimit = maxCatalogs ?? collectionImportCatalogCap;
  const headroom = Math.max(0, catalogLimit - enabledCatalogCount);
  const overBy = Math.max(0, pendingCount - headroom);

  // Below overBy and strandedNative on purpose: blockingIssues reads both, and a
  // const is in its temporal dead zone until its own line runs.
  const missingKeyNames = useMemo(() => missingKeys.map(key => key.name), [missingKeys]);

  const blocking = useMemo(
    () => blockingIssues({
      target, strandedNative, overBy, pendingCount, headroom,
      missingKeys: missingKeyNames,
    }),
    [target, strandedNative, overBy, pendingCount, headroom, missingKeyNames]
  );

  const problems = useMemo(
    () => buildIssueCenter({ blocking, issues, notes, targets: problemTargets }),
    [blocking, issues, notes, problemTargets]
  );

  const verdict = useMemo(() => saveVerdict(problems), [problems]);

  // Not a fault in the design, so it stays out of the verdict, but it changes
  // what the editor can offer and belongs on the same shelf as the rest.
  const statusRows = useMemo(() => {
    if (sourceList.origin !== 'derived') return problems;
    const message = sourceList.error
      ? `Could not read your manifest (${sourceList.error}). The catalog list is derived from your local config, so genre options and genre requirements are missing.`
      : 'Save to read the real manifest. Until then the catalog list is derived from your local config, so genre options and genre requirements are missing.';
    return [
      { key: 'derived-manifest', message, severity: 'warning' as IssueSeverity, entryId: null, folderId: null },
      ...problems,
    ];
  }, [problems, sourceList.origin, sourceList.error]);

  const worstByEntry = useMemo(() => severityByField(problems, 'entryId'), [problems]);

  const worstByFolder = useMemo(() => severityByField(problems, 'folderId'), [problems]);

  const runImport = (mode: ImportMode) => {
    if (!importPreview || importPreview.entries.length === 0) return;
    setConfirmReplace(false);
    const { entries: incoming, filled } = fillMissingGenres(
      healSourceNames(
        realignSourceIds(clone(importPreview.entries) as BuilderEntry[], sourceList.catalogs),
        sourceList.catalogs
      ),
      sourceList.catalogs
    );
    // Merge joins on ids, so reissuing them there would defeat it.
    if (mode !== 'merge') {
      reissueTakenIds(incoming, mode === 'append' ? collectIds(entries) : new Set<string>());
    }

    setStagedBlueprints(prev => dedupeBlueprints(
      mode === 'replace' ? importPreview.blueprints : [...prev, ...importPreview.blueprints]
    ));
    setSessionSourceKeys(prev => {
      const incomingKeys = collectSourceKeys(incoming);
      return mode === 'replace' ? new Set(incomingKeys) : new Set([...prev, ...incomingKeys]);
    });

    let mergeNote = '';
    setEntries(prev => {
      let next: BuilderEntry[];
      if (mode === 'replace') {
        next = incoming;
      } else if (mode === 'append') {
        next = [...prev, ...incoming];
      } else {
        const result = mergeEntries(prev, incoming);
        next = result.entries;
        mergeNote = describeMerge(result.summary);
      }
      setSelectedId(next[0]?.id ?? null);
      return next;
    });
    setImportOpen(false);
    setImportText('');
    setImportPreview(null);
    setDraftId(null);
    // The pane was showing the design being considered; it has now been taken,
    // so it goes back to previewing whatever is selected. On a phone that pane
    // was the whole screen, so land on the list of what just arrived.
    setFeaturedPreview(null);
    setView('build');
    setMobilePane('entries');
    setConvertNative(false);
    const notes: string[] = [];
    if (mergeNote) notes.push(mergeNote);
    if (rebuildable > 0) {
      notes.push(`${rebuildable} catalog${rebuildable === 1 ? '' : 's'} will be added when you apply.`);
    }
    if (filled.length > 0) {
      notes.push(filled.length === 1
        ? `${filled[0].name} arrived without a genre and was set to ${filled[0].genre}.`
        : `${filled.length} catalogs arrived without a genre and were set to the one their catalog defaults to.`);
    }
    toast.success(
      mode === 'merge'
        ? 'File merged in'
        : incoming.length === 1 ? '1 entry imported' : `${incoming.length} entries imported`,
      notes.length > 0 ? { description: notes.join(' ') } : undefined
    );
  };

  // The layout file keeps every source as it is, so only the Nuvio export has anything to lose.
  const exportLoses = target === 'nuvio' && strandedNative > 0;

  const handleCopyUrl = async () => {
    if (exportLoses) {
      setNativeBlockFor('link');
      return;
    }
    await navigator.clipboard.writeText(hostedUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 1500);
    toast.success('Link copied to clipboard');
  };

  const handleCopy = async () => {
    if (exportLoses) {
      setNativeBlockFor('copy');
      return;
    }
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    toast.success('JSON copied to clipboard');
  };

  const handleDownload = () => {
    if (exportLoses) {
      setNativeBlockFor('download');
      return;
    }
    const name = target === 'nuvio' ? 'nuvio-collections' : 'aiometadata-collections';
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name}-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" /> Export &amp; share
            </DialogTitle>
            <DialogDescription>
              {target === 'nuvio'
                ? 'Every collection you have built, as Nuvio JSON.'
                : 'Every collection and row you have built, folders inside folders included, for someone else to import into their AIOMetadata.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-2">
                  <div className="flex items-start gap-2 rounded-xl border border-sky-400/20 bg-sky-500/10 p-3 text-xs">
                    <Info className="mt-px h-4 w-4 shrink-0 text-sky-400" />
                    <div className="space-y-1">
                      {target === 'nuvio' ? (
                        <>
                          <p className="font-medium text-sky-200">
                            Saving updates your addon, not Nuvio
                          </p>
                          <p className="text-muted-foreground">
                            Nothing is pushed to your app. Import the file or the link below again for these edits to
                            show up there.
                          </p>
                          <p className="text-muted-foreground">
                            Editing a collection you imported keeps its id, so Nuvio updates the one you already have instead of adding a second copy. Building a new collection from scratch mints a new id and arrives alongside the old one.
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="font-medium text-sky-200">
                            Your own Jellyfin clients need no file
                          </p>
                          <p className="text-muted-foreground">
                            Saving is enough for them. This file is for sharing: whoever imports it in their
                            collections builder gets the same layout, with the catalogs it uses created for them. Your
                            user tags stay out of it.
                          </p>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={`text-xs ${target === 'nuvio' ? NUVIO_CHIP : JELLYFIN_CHIP}`}
                    >
                      {target === 'nuvio' ? 'Nuvio collections' : 'AIOMetadata layout'}
                    </Badge>
                    <span className="text-xs text-muted-foreground">The manifest URL is in the header</span>
                    <div className="ml-auto flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={handleCopy}>
                      {copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}
                      Copy
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleDownload}>
                      <Download className="mr-1.5 h-4 w-4" /> Download
                    </Button>
                    </div>
                  </div>


                  <div className="space-y-1.5 rounded-xl border border-primary/25 bg-primary/10 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <LinkIcon className="h-4 w-4 text-primary" />
                      <Label htmlFor="collection-hosted-url" className="text-xs font-medium">Import by link</Label>
                      <span className="text-xs text-muted-foreground">
                        {target === 'nuvio'
                          ? 'Serves the same JSON live, if your app can read a URL'
                          : 'Serves the same JSON live; paste it into Import JSON on the other side'}
                      </span>
                    </div>
                    {hostedUrl ? (
                      <>
                        <div className="flex gap-2">
                          <Input id="collection-hosted-url" readOnly value={hostedUrl} className="h-9 font-mono text-xs" onClick={e => (e.target as HTMLInputElement).select()} />
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            onClick={handleCopyUrl}
                            aria-label="Copy the import link"
                          >
                            {copiedUrl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                          </Button>
                        </div>
                        <p className="flex items-start gap-1.5 text-xs text-amber-500">
                          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                          {stage === 'saved'
                            ? 'The link serves what is on the server, which is these edits.'
                            : 'The link serves what is on the server, so save before you re-import it.'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          It rebuilds on every request, so re-importing after saving picks up your edits. Anyone with
                          the link can read it, same as your manifest URL{usePlaceholder
                            ? ', and it always carries your real URL rather than the blanked copy'
                            : ''}.
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Save first. The link is served per user, so it needs a saved config to read.
                      </p>
                    )}
                  </div>

                  {imagePrefix && (
                    <div className="space-y-1.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                      <div className="flex items-center gap-2">
                        <Switch
                          id="collection-images-via-cache"
                          checked={Boolean(config.collectionImagesViaCache)}
                          onCheckedChange={checked => setConfig(prev => ({ ...prev, collectionImagesViaCache: checked || undefined }))}
                        />
                        <Label htmlFor="collection-images-via-cache" className="text-xs font-medium">
                          Serve images through this server
                        </Label>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Folder covers, backdrops and logos are fetched from where you host them once, kept in this
                        server's image cache and served from here, so a slow or down image host no longer leaves
                        tiles blank. The addresses you entered stay as they are; only the exported file and link
                        point at this server. Saved with the configuration.
                      </p>
                    </div>
                  )}

                  {target === 'nuvio' && (
                    <div className="space-y-1.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                      <div className="flex items-center gap-2">
                        <Switch
                          id="collection-use-placeholder"
                          checked={usePlaceholder}
                          onCheckedChange={setUsePlaceholder}
                        />
                        <Label htmlFor="collection-use-placeholder" className="text-xs font-medium">
                          Make a copy for someone else
                        </Label>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Your addon link contains your user ID, and this file embeds it on every row. Anyone who has it
                        can read that config. Turn this on to blank it out before posting the file publicly. Whoever
                        imports it here gets their own link filled in automatically, so they end up with your layout
                        pointing at their catalogs.
                      </p>
                      {usePlaceholder && (
                        <p className="flex items-start gap-1.5 text-xs text-amber-500">
                          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                          This copy is for handing out, not for your own use. It has no addon link in it, so
                          importing it back here is what puts one in.
                        </p>
                      )}
                    </div>
                  )}

                  <textarea
                    readOnly
                    value={json}
                    className="h-56 w-full resize-none rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 font-mono text-xs focus:outline-none sm:h-80"
                    onClick={event => (event.target as HTMLTextAreaElement).select()}
                  />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isOpen} onOpenChange={open => !open && requestClose()}>
        <DialogContent
          className="@container grid h-[100dvh] max-h-[100dvh] w-screen max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none sm:h-[92vh] sm:max-h-[92vh] sm:w-[min(96vw,120rem)] sm:rounded-2xl sm:border sm:p-0 sm:shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
          onInteractOutside={event => event.preventDefault()}
        >
          <header className="flex min-h-0 flex-col border-b border-white/[0.08]">
            <div
              className={`flex shrink-0 flex-col gap-3 px-5 pt-4 ${
                view === 'build' && mobilePane === 'entries' ? '' : 'pb-4'
              } ${view === 'build' ? '@2xl:pb-0' : ''}`}
            >
            <div className="flex flex-wrap items-center gap-3">
              <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
                <Layers className="h-5 w-5" />
                Collections &amp; Widgets
              </DialogTitle>
              <DialogDescription className="sr-only">
                Arrange your catalogs once for Jellyfin clients, and export them as Nuvio collection JSON.
              </DialogDescription>
              <div
                className={`gap-1 rounded-xl bg-white/[0.02] p-1 @2xl:flex ${
                  mobilePane === 'entries' ? 'flex' : 'hidden'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setTarget('nuvio')}
                  className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors ${
                    target === 'nuvio'
                      ? 'bg-cyan-500/15 text-cyan-200'
                      : 'text-muted-foreground hover:bg-white/[0.04] active:bg-white/[0.06]'
                  }`}
                >
                  <Tv className="h-4 w-4" /> Nuvio
                </button>
                <button
                  type="button"
                  onClick={() => setTarget('jellyfin')}
                  className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors ${
                    target === 'jellyfin'
                      ? 'bg-purple-500/15 text-purple-200'
                      : 'text-muted-foreground hover:bg-white/[0.04] active:bg-white/[0.06]'
                  }`}
                >
                  <Rows3 className="h-4 w-4" /> Jellyfin
                </button>
              </div>
              <button
                type="button"
                onClick={() => setExportOpen(true)}
                aria-label="Export and share"
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm @2xl:px-3 text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground active:bg-white/[0.06] @2xl:flex ${
                  mobilePane === 'entries' ? 'flex' : 'hidden'
                }`}
              >
                <Upload className="h-4 w-4" />
                <span className="hidden @2xl:inline">Export &amp; share</span>
              </button>
              <Badge
                variant="outline"
                className={`ml-auto mr-8 h-7 px-2.5 text-xs ${
                  stage === 'saved'
                    ? 'border-emerald-600/50 text-emerald-400'
                    : stage === 'applied'
                      ? 'border-sky-600/50 text-sky-400'
                      : 'border-amber-600/50 text-amber-400'
                }`}
                title={stageCopy.hint}
              >
                {stageCopy.label}
              </Badge>
            </div>

            {FEATURED_COLLECTIONS.length > 0 && (
              <div
                className={`w-full gap-1 rounded-xl bg-white/[0.02] p-1 @2xl:flex @2xl:w-fit ${
                  mobilePane === 'entries' ? 'flex' : 'hidden'
                }`}
              >
                {([
                  ['build', 'Build', Layers],
                  ['featured', 'Featured', Sparkles],
                ] as const).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setView(id)}
                    aria-pressed={view === id}
                    className={`flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm transition-colors @2xl:h-8 @2xl:min-h-0 @2xl:flex-none @2xl:justify-start ${
                      view === id
                        ? 'bg-white/[0.08] text-foreground shadow-sm'
                        : 'text-muted-foreground hover:bg-white/[0.04] active:bg-white/[0.06]'
                    }`}
                  >
                    <Icon className={`h-4 w-4 ${id === 'featured' ? 'text-sky-300' : ''}`} />
                    {label}
                    {id === 'featured' && (
                      <span className="text-xs text-muted-foreground">{FEATURED_COLLECTIONS.length}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            </div>

            {view === 'build' && (
            <div
              className={`max-h-[22dvh] min-h-0 min-w-0 flex-col gap-3 overflow-y-auto px-5 pb-4 pt-3 @2xl:flex @2xl:max-h-[34dvh] ${
                mobilePane === 'entries' ? 'flex' : 'hidden'
              }`}
            >
            <StatusBar
              rows={statusRows}
              onGoTo={goToProblem}
              trailing={
                <span className="hidden flex-wrap items-center gap-2 text-xs text-muted-foreground @2xl:flex">
                  Catalogs read from{' '}
                  {sourceList.origin === 'derived' ? 'your local config' : 'your saved manifest'}
                  <button
                    type="button"
                    onClick={() => setShowManifestField(value => !value)}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {showManifestField ? 'Hide' : 'Change source'}
                  </button>
                </span>
              }
            />
            {showManifestField && (
              <div className="space-y-2">
                <Label htmlFor="collection-manifest-url" className="text-sm font-medium">Manifest URL</Label>
                <Input
                  id="collection-manifest-url"
                  value={manifestUrl}
                  onChange={event => setManifestUrl(event.target.value)}
                  placeholder="https://your-host/stremio/<uuid>/manifest.json"
                  className="h-9 font-mono text-sm"
                />
              </div>
            )}
            </div>
            )}
          </header>

          {view === 'featured' ? (
          <div className="@container/featured min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-4 py-4 @2xl:px-5">
            {featuredPreview ? (
              <FeaturedDetail
                featured={featuredPreview.featured}
                entries={featuredPreview.entries}
                index={featuredPreview.index}
                busy={importFetching}
                skipped={featuredPreview.skipped}
                onSelect={at => setFeaturedPreview(p => (p ? { ...p, index: at } : p))}
                onToggle={key => setFeaturedPreview(p => {
                  if (!p) return p;
                  const skipped = new Set(p.skipped);
                  if (skipped.has(key)) skipped.delete(key);
                  else skipped.add(key);
                  return { ...p, skipped };
                })}
                onSetAll={included => setFeaturedPreview(p => (p
                  ? { ...p, skipped: included ? new Set() : new Set(p.entries.map((entry, at) => entryKey(entry, at))) }
                  : p))}
                onBack={() => setFeaturedPreview(null)}
                onImport={importFeaturedPreview}
              >
                <CollectionPreview
                  entry={featuredPreview.entries[featuredPreview.index] ?? null}
                  target={target}
                  onEditFolder={() => undefined}
                />
              </FeaturedDetail>
            ) : (
              <FeaturedGallery
                items={FEATURED_COLLECTIONS}
                artwork={ARTWORK_RESOURCES}
                headroom={headroom}
                busy={importFetching}
                error={featuredError}
                onLoad={featured => { void loadFeatured(featured); }}
              />
            )}
          </div>
          ) : (
          <div className="@container/panes flex min-h-0 flex-col gap-3 overflow-hidden px-5 py-4">
          <div className="grid shrink-0 grid-cols-3 gap-1 rounded-xl bg-white/[0.02] p-1 @2xl:hidden">
            {([
              ['entries', 'Entries'],
              ['editor', 'Editor'],
              ['preview', 'Preview'],
            ] as const).map(([pane, label]) => (
              <button
                key={pane}
                type="button"
                onClick={() => setMobilePane(pane)}
                aria-pressed={mobilePane === pane}
                className={`min-h-[44px] rounded-lg px-3 text-sm transition-colors ${
                  mobilePane === pane
                    ? 'bg-white/[0.08] text-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-white/[0.04] active:bg-white/[0.06]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="grid min-h-0 flex-1 gap-4 @2xl:grid-cols-[20rem_minmax(0,1fr)] @6xl:grid-cols-[20rem_minmax(0,1fr)_30rem]">
            <div className={`min-h-0 min-w-0 flex-col gap-2 overflow-y-auto pr-1 @2xl:flex ${mobilePane === 'entries' ? 'flex' : 'hidden'}`}>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 border-0 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 active:bg-cyan-500/25"
                  onClick={() => addEntry(createCollectionDraft())}
                >
                  <Layers className="mr-1.5 h-4 w-4 text-cyan-400" /> {terms.collection}
                </Button>
              </div>
              <Button size="sm" variant="ghost" className="w-full" onClick={() => setImportOpen(true)}>
                <Upload className="mr-1.5 h-4 w-4" /> Import JSON
              </Button>
              <div className="space-y-1.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">Where it shows.</span> Collections take their place from the catalog list. Drag them there, between any two catalogs.
                </p>
                <p className="flex gap-1.5">
                  <Rows3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-purple-400" />
                  <span>A row's title and numbering live on its catalog now: open the catalog's menu and choose Row options. Rows in an import become row options when you apply.</span>
                </p>
              </div>

              {(committedEntries.length > 6 || railQuery !== '') && (
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={railQuery}
                    onChange={event => setRailQuery(event.target.value)}
                    placeholder={`Filter ${committedEntries.length} entries`}
                    className="h-8 pl-8 text-xs"
                  />
                </div>
              )}

              {committedEntries.length === 0 && (
                <div className="space-y-1.5 rounded-xl border border-dashed border-white/[0.08] p-2">
                  <p className="px-1 text-center text-xs text-muted-foreground">
                    {starters.length > 0 ? 'Nothing yet. Start from one of these:' : 'Nothing yet.'}
                  </p>
                  {starters.map(template => (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => {
                        const built = template.build();
                        setEntries(built);
                        setSelectedId(built[0]?.id ?? null);
                        toast.success(`Started from "${template.label}"`);
                      }}
                      className="w-full rounded-lg bg-white/[0.03] px-2 py-2 text-left text-xs transition-colors hover:bg-white/[0.06] active:bg-white/[0.08]"
                    >
                      <span className="block font-medium">{template.label}</span>
                      <span className="block text-xs text-muted-foreground">{template.hint}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => addEntry(createCollectionDraft())}
                    className={`w-full rounded-md px-2 text-center text-xs transition-colors ${
                      starters.length > 0
                        ? 'py-1.5 text-muted-foreground hover:text-foreground'
                        : 'bg-white/[0.03] py-3 font-medium hover:bg-white/[0.06] active:bg-white/[0.08]'
                    }`}
                  >
                    {starters.length > 0 ? 'or start empty' : 'Start with a collection'}
                  </button>
                </div>
              )}

              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleRailDragEnd}>
                <SortableContext items={railItemIds} strategy={verticalListSortingStrategy}>
                  <div className="space-y-0.5">
                    {visibleTree.map(({ entry, folders, forceExpand }) => {
                      const index = entries.findIndex(item => item.id === entry.id);
                      const excluded: Target | null =
                        target === 'nuvio' && entry.kind === 'classicRow' ? 'jellyfin'
                        : target === 'jellyfin' && entryIsStranded(entry)
                          && entrySources(entry).every(source => nativeOrigin(source) === 'nuvio') ? 'nuvio'
                        : null;
                      const folderCount = entry.kind === 'collection' ? entry.folders.length : 0;
                      const expanded = forceExpand || expandedIds.has(entry.id);
                      return (
                        <div key={entry.id}>
                          <SortableTreeRow
                            id={entry.id}
                            depth={0}
                            title={entry.title}
                            placeholder="Untitled"
                            count={tallyEntryCount(entry)}
                            countHint={describeEntryCount(entry)}
                            empty={entrySourceCount(entry) === 0}
                            icon={entry.kind === 'collection' ? Layers : entry.numbered ? ListOrdered : Rows3}
                            accent={entry.kind === 'collection' ? 'text-cyan-400' : 'text-violet-400'}
                            severity={excluded ? undefined : worstByEntry.get(entry.id)}
                            allNative={entryIsStranded(entry)}
                            excluded={excluded}
                            isActive={selection.entryId === entry.id && selection.folderId === null}
                            isAncestor={selection.entryId === entry.id && selection.folderId !== null}
                            expanded={expanded}
                            onToggleExpand={folders.length > 0
                              ? () => setExpandedIds(prev => {
                                  const next = new Set(prev);
                                  if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
                                  return next;
                                })
                              : undefined}
                            canMoveUp={index > 0}
                            canMoveDown={index < committedEntries.length - 1}
                            onMoveTo={position => moveEntryTo(index, position)}
                            onDuplicate={() => duplicateEntry(entry.id)}
                            onSelect={() => { setSelection({ entryId: entry.id, folderId: null }); setMobilePane('editor'); }}
                            onDelete={() => removeEntry(entry.id)}
                          />
                          {expanded && folders.map(({ folder, folderIndex }) => (
                            <SortableTreeRow
                              key={folder.id}
                              id={folder.id}
                              depth={1}
                              title={folder.title}
                              placeholder="Untitled folder"
                              count={String(folderSources(folder).length)}
                              countHint={`${folderSources(folder).length} catalog${folderSources(folder).length === 1 ? '' : 's'}`}
                              empty={folderSources(folder).length === 0}
                              icon={Folder}
                              accent="text-muted-foreground"
                              severity={worstByFolder.get(folder.id)}
                              allNative={folderSources(folder).length > 0
                                && folderSources(folder).every(source => isStrandedNative(source, target))}
                              isActive={selection.folderId === folder.id || allFolders(subFolders(folder)).some(child => child.id === selection.folderId)}
                              canMoveUp={folderIndex > 0}
                              canMoveDown={folderIndex < folderCount - 1}
                              onMoveTo={position => moveFolderTo(entry.id, folderIndex, position)}
                              onDuplicate={() => duplicateFolderIn(entry.id, folderIndex)}
                              onSelect={() => { setSelection({ entryId: entry.id, folderId: folder.id }); setMobilePane('editor'); }}
                              onDelete={() => removeFolderIn(entry.id, folderIndex)}
                            />
                          ))}
                        </div>
                      );
                    })}
                    {railQuery.trim() && visibleTree.length === 0 && (
                      <p className="px-1 py-3 text-center text-xs text-muted-foreground">
                        Nothing matches that filter.
                      </p>
                    )}
                  </div>
                </SortableContext>
              </DndContext>

            </div>

            <div className={`@container min-h-0 min-w-0 overflow-y-auto @2xl:block ${mobilePane === 'editor' ? 'block' : 'hidden'}`}>
              {selected && (
                <div className="sticky top-0 z-10 mb-4 flex items-center gap-1.5 border-b border-white/[0.08] bg-card/95 py-2 text-sm backdrop-blur">
                  <button
                    type="button"
                    onClick={() => setMobilePane('entries')}
                    aria-label="Back to entries"
                    className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded hover:bg-white/[0.06] active:bg-white/[0.08] @2xl:hidden"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelection({ entryId: selected.id, folderId: null })}
                    className={`truncate rounded-md px-1.5 py-1 hover:bg-white/[0.06] ${
                      selection.folderId ? 'text-muted-foreground hover:text-foreground' : 'font-medium'
                    }`}
                  >
                    {selected.title || 'Untitled'}
                  </button>
                  {selection.folderId && (
                    <>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">
                        {selected.kind === 'collection'
                          ? findFolder(selected.folders, selection.folderId)?.title
                            || 'Untitled folder'
                          : ''}
                      </span>
                    </>
                  )}
                </div>
              )}

              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList>
                  <TabsTrigger value="design">Design</TabsTrigger>
                  <TabsTrigger value="preview">Preview</TabsTrigger>
                </TabsList>

                <TabsContent value="design" className="pt-4">
                  <div className="min-w-0">
                  {!selected && (
                    <div className="rounded-xl border border-dashed border-white/[0.08] px-3 py-10 text-center text-sm text-muted-foreground">
                      <p>
                        {committedEntries.length > 0 ? (
                          <>
                            Select something{' '}
                            <span className="@2xl/panes:hidden">in the Entries tab</span>
                            <span className="hidden @2xl/panes:inline">on the left</span>
                            {' '}to edit it.
                          </>
                        ) : 'Nothing to edit yet.'}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => addEntry(createCollectionDraft())}
                      >
                        <Layers className="mr-1.5 h-4 w-4 text-cyan-400" /> New {terms.collection.toLowerCase()}
                      </Button>
                    </div>
                  )}
                  {selected?.kind === 'collection' && (
                    <CollectionEditor
                      entry={selected}
                      catalogs={sourceList.catalogs}
                      pendingKeys={pendingKeys}
                      target={target}
                      userTags={config.tags ?? []}
                      onChange={updateEntry}
                      onUndoableChange={(label, apply, undo) =>
                        editEntryUndoable(label, selected.id, apply, undo)}
                      onAddSource={folderId => setPickerTarget({ entryId: selected.id, folderId })}
                      onReplaceSource={(folderId, index) =>
                        setPickerTarget({ entryId: selected.id, folderId, replaceIndex: index })}
                      onRenameCatalog={renameCatalog}
                      tagOptions={tagOptions}
                      onAddByTag={(folderId, tag) => addSourcesByTag(selected.id, folderId, tag)}
                      nativeCount={countNative(selected)}
                      onConvertNative={folderId => convertNativeSources(selected.id, folderId)}
                      selectedFolderId={selection.folderId}
                      onAddFolder={() => addFolderIn(selected.id)}
                      onRemoveFolder={() => {
                        if (!selection.folderId) return;
                        const index = selected.folders.findIndex(f => f.id === selection.folderId);
                        if (index >= 0) removeFolderIn(selected.id, index);
                        else removeSubFolderIn(selected.id, selection.folderId);
                      }}
                      onAddSubFolder={parentId => addSubFolderIn(selected.id, parentId)}
                      onSelectFolder={folderId => setSelection({ entryId: selected.id, folderId })}
                      focusFolderTitle={titleFocusId === selection.folderId}
                      onFolderTitleFocused={clearTitleFocus}
                      focusTitle={titleFocusId === selected.id}
                      onTitleFocused={clearTitleFocus}
                    />
                  )}
                  {selected?.kind === 'classicRow' && (
                    <ClassicRowEditor
                      entry={selected}
                      catalogs={sourceList.catalogs}
                      pendingKeys={pendingKeys}
                      target={target}
                      userTags={config.tags ?? []}
                      onChange={updateEntry}
                      onAddSource={() => setPickerTarget({ entryId: selected.id, folderId: null })}
                      onRenameCatalog={renameCatalog}
                      focusTitle={titleFocusId === selected.id}
                      onTitleFocused={clearTitleFocus}
                    />
                  )}
                  {selected && selected.id === draftId && (
                    <div className="mt-4 flex flex-col gap-3 rounded-xl border border-dashed border-white/[0.08] p-3 @xl:flex-row @xl:items-center">
                      <span className="text-xs text-muted-foreground @xl:mr-auto">
                        Not added yet. It joins your list when you add it.
                      </span>
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={discardDraft}>Discard</Button>
                        <Button size="sm" onClick={commitDraft}>
                          <Plus className="mr-1.5 h-4 w-4" />
                          Add {selected.kind === 'collection' ? terms.collection.toLowerCase() : terms.row.toLowerCase()}
                        </Button>
                      </div>
                    </div>
                  )}
                  </div>
                </TabsContent>

                <TabsContent value="preview" className="min-w-0 pt-4">
                  <CollectionPreview
                    entry={selected}
                    target={target}
                    onEditFolder={folderId => selected && goToProblem(selected.id, folderId)}
                    pendingCatalogs={pendingAdditions.added}
                  />
                </TabsContent>

              </Tabs>
            </div>

            <div
              className={`min-h-0 min-w-0 overflow-y-auto @6xl/panes:block @2xl:hidden ${
                mobilePane === 'preview' ? 'block' : 'hidden'
              }`}
            >
              <div className="sticky top-0 rounded-xl border border-white/[0.06] bg-card/80 p-4">
                <span className="mb-3 block text-sm font-medium text-muted-foreground">Live preview</span>
                <CollectionPreview
                  entry={selected}
                  target={target}
                  onEditFolder={folderId => selected && goToProblem(selected.id, folderId)}
                  pendingCatalogs={pendingAdditions.added}
                />
              </div>
            </div>
          </div>
          </div>
          )}

          <footer className="flex max-h-[18dvh] min-h-0 min-w-0 flex-col gap-3 overflow-y-auto border-t border-white/[0.08] bg-background/95 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-sm @2xl:max-h-[30dvh] @2xl:flex-row @2xl:flex-wrap @2xl:items-center @2xl:justify-end @2xl:bg-transparent @2xl:px-5 @2xl:py-4 @2xl:backdrop-blur-none">
            <div className="min-w-0 space-y-1 @2xl:mr-auto">
              {overBy > 0 && (
                <p className="flex items-start gap-1.5 text-xs text-amber-500">
                  <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
                  This design needs {pendingCount} new catalogs and there is room for {headroom}. Delete{' '}
                  {overBy} more catalog{overBy === 1 ? '' : 's'} worth of tiles to apply it.
                </p>
              )}
              {overBy === 0 && pendingCount > 0 && (
                <p className="text-xs text-emerald-500">
                  {pendingCount} catalog{pendingCount === 1 ? '' : 's'} will be added when you save, leaving{' '}
                  {headroom - pendingCount} of your {catalogLimit} spare.
                </p>
              )}
              {unresolvedSources.length > 0 && (
                <p className="flex items-start gap-1.5 text-xs text-amber-500">
                  <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
                  {unresolvedSources.length === 1
                    ? '1 source points at a catalog you do not have.'
                    : `${unresolvedSources.length} sources point at catalogs you do not have.`}{' '}
                  Swap them for yours, or leave them and those tiles come up empty.
                </p>
              )}
              {pendingAdditions.needsAccount.length > 0 && (
                <p className="flex items-start gap-1.5 text-xs text-amber-500">
                  <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
                  This design uses your own {pendingAdditions.needsAccount.join(' and ')} catalogs, such as
                  your watchlist. Connect{' '}
                  {pendingAdditions.needsAccount.length === 1 ? 'that account' : 'those accounts'} first, or
                  applying leaves those tiles empty.
                </p>
              )}
              {pendingAdditions.partialMerges.map(merge => (
                <p key={merge.name} className="flex items-start gap-1.5 text-xs text-amber-500">
                  <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
                  &ldquo;{merge.name}&rdquo; is rebuilt from {merge.kept} of its sources.{' '}
                  {merge.dropped} could not be recreated, so that row will be missing them.
                </p>
              ))}
              {overBy === 0
                && pendingCount === 0
                && unresolvedSources.length === 0
                && pendingAdditions.partialMerges.length === 0
                && pendingAdditions.needsAccount.length === 0 && (
                <p className="text-xs text-muted-foreground">{stageCopy.hint}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 [&>button]:min-h-[44px] @2xl:contents @2xl:[&>button]:min-h-0">
            {totalNative > 0 && (
              <Button
                variant="outline"
                className={`h-9 ${strandedNative > 0 ? 'border-amber-600/60 text-amber-200 hover:bg-amber-900/40' : ''}`}
                onClick={() => convertNativeSources()}
              >
                <Replace className="mr-1.5 h-4 w-4" /> Route all {totalNative} through AIOMetadata
              </Button>
            )}
            {overBy > 0 && (
              <Button
                variant="outline"
                className="h-9"
                onClick={() => { setPendingMode('save'); setOverLimitOpen(true); }}
              >
                Apply the layout without the catalogs
              </Button>
            )}
            {unresolvedSources.length > 0 && (
              <Button variant="outline" onClick={() => setRemapOpen(true)}>
                <Replace className="mr-1.5 h-4 w-4" /> Swap catalogs
              </Button>
            )}
            <Button variant="ghost" onClick={requestClose}>Close</Button>
            <Button variant="outline" onClick={() => { void refreshInstanceLimits().then(fresh => handleSave('apply', fresh)); }}>Apply only</Button>
            <Button
              onClick={() => { void refreshInstanceLimits().then(fresh => handleSave('save', fresh)); }}
              disabled={isSaving || !verdict.canSave}
              title={verdict.canSave ? undefined : 'Resolve the issues listed above first'}
            >
              {isSaving ? 'Saving…' : verdict.label}
            </Button>
            </div>
          </footer>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={open => { if (!open) { setImportOpen(false); setImportText(''); setImportUrl(''); setImportUrlError(''); setImportPreview(null); setConfirmReplace(false); } }}>
        <DialogContent className="max-w-[min(84vw,42rem)]">
          <DialogHeader>
            <DialogTitle>Import collections</DialogTitle>
            <DialogDescription>
              Link, paste or upload a Nuvio collections file, a Fusion widgets file, or a previous export from
              here. The format is detected for you.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={importUrl}
              onChange={event => { setImportUrl(event.target.value); setImportUrlError(''); }}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void loadImportUrl(); } }}
              placeholder="https://example.com/collections.json"
              className="h-9 min-w-[16rem] flex-1 font-mono text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={!importUrl.trim() || importFetching}
              onClick={() => { void loadImportUrl(); }}
            >
              <LinkIcon className="mr-1.5 h-4 w-4" /> {importFetching ? 'Loading…' : 'Load link'}
            </Button>
          </div>

          {importUrlError && (
            <p className="-mt-2 text-xs text-amber-500">{importUrlError}</p>
          )}

          <div className="flex items-center gap-2">
            <input
              type="file"
              accept="application/json,.json"
              id="collection-import-file"
              className="hidden"
              onChange={event => { void handleImportFile(event.target.files?.[0]); event.target.value = ''; }}
            />
            <Button size="sm" variant="outline" onClick={() => document.getElementById('collection-import-file')?.click()}>
              <Upload className="mr-1.5 h-4 w-4" /> Choose file
            </Button>
            <span className="text-xs text-muted-foreground">or paste below</span>
          </div>

          <textarea
            value={importText}
            onChange={event => previewImport(event.target.value)}
            onPaste={handleImportPaste}
            placeholder='[{"id":"...","title":"My Collection","folders":[...]}]'
            className="h-48 w-full resize-none rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 font-mono text-xs focus:outline-none"
          />

          {importPreview && (
            <div className="space-y-2 rounded-xl border border-white/[0.06] p-3">
              <div className="flex flex-wrap items-center gap-2">
                {importPreview.format === 'unknown' ? (
                  <Badge variant="outline" className="border-amber-400/20 bg-amber-500/15 text-xs text-amber-200">
                    unrecognised
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className={`text-xs ${importPreview.format === 'fusion' ? FUSION_CHIP : NUVIO_CHIP}`}
                  >
                    {importPreview.format === 'fusion'
                      ? 'Fusion widgets'
                      : importPreview.format === 'nuvio'
                        ? 'Nuvio collections'
                        : 'AIOMetadata export'}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {importPreview.entries.length === 0
                    ? 'Nothing importable found'
                    : `${importPreview.entries.length} ${importPreview.entries.length === 1 ? 'entry' : 'entries'}, ` +
                      `${importPreview.entries.reduce((n, e) => n + entrySourceCount(e), 0)} sources`}
                </span>
                {rebuildable > 0 && (
                  <Badge variant="outline" className="border-emerald-400/20 bg-emerald-500/15 text-xs text-emerald-200">
                    {rebuildable} catalog{rebuildable === 1 ? '' : 's'} rebuildable
                  </Badge>
                )}
                {importUnresolved.length > 0 && (
                  <Badge variant="outline" className="border-amber-400/20 bg-amber-500/15 text-xs text-amber-200">
                    {importUnresolved.length} not in your catalogs
                  </Badge>
                )}
              </div>

              {importPreview.entries.length > 0 && !featuredPreview && (() => {
                const at = Math.min(importPreviewIndex, importPreview.entries.length - 1);
                const shown = importPreview.entries[at];
                // A file states its own shape, which need not be the target being edited.
                const shape: Target = importPreview.format === 'fusion' ? 'jellyfin'
                  : importPreview.format === 'nuvio' ? 'nuvio'
                  : target;
                return (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {shown?.title || 'Untitled'}
                        {importPreview.entries.length > 1 && ` — ${at + 1} of ${importPreview.entries.length}`}
                      </span>
                      {importPreview.entries.length > 1 && (
                        <div className="flex shrink-0 gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label="Previous entry"
                            disabled={at === 0}
                            onClick={() => setImportPreviewIndex(at - 1)}
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label="Next entry"
                            disabled={at >= importPreview.entries.length - 1}
                            onClick={() => setImportPreviewIndex(at + 1)}
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </div>
                    <CollectionPreview
                      entry={shown ?? null}
                      target={shape}
                      onEditFolder={() => undefined}
                      pendingCatalogs={importAdditions.added}
                    />
                  </div>
                );
              })()}

              {importPreview.nativeCount > 0 && (
                <div className="space-y-2 rounded-lg bg-white/[0.03] p-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Label htmlFor="convert-native" className="text-xs font-medium">
                        Route the app's own sources through AIOMetadata
                      </Label>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {importPreview.nativeCount} of this file's sources are fetched by the app straight from
                        TMDB or Trakt. Left alone they work as they are and cost nothing. Turning this on gives
                        them your artwork, ratings and filters, at{' '}
                        {importPreview.convertibleCount} catalog
                        {importPreview.convertibleCount === 1 ? '' : 's'} added to your setup.
                      </p>
                    </div>
                    <Switch
                      id="convert-native"
                      checked={convertNative}
                      onCheckedChange={toggleConvertNative}
                    />
                  </div>
                  {convertNative && importPreview.convertibleCount < importPreview.nativeCount && (
                    <p className="text-xs text-muted-foreground">
                      {importPreview.nativeCount - importPreview.convertibleCount} of them have no equivalent
                      here and stay with the app.
                    </p>
                  )}
                </div>
              )}

              {rebuildable > 0 && (
                <div className="space-y-1 rounded-lg border border-emerald-400/20 bg-emerald-500/10 p-2">
                  <p className="text-xs text-emerald-500">
                    This file carries the definitions for {rebuildable} catalog{rebuildable === 1 ? '' : 's'} you
                    do not have. Only the ones your design still uses when you apply are added, so trimming the
                    collections trims what you take on.
                  </p>
                  <ul className="space-y-0.5 text-xs text-muted-foreground">
                    {additionLabels(importAdditions, 6).map((label, index) => (
                      <li key={`${label}-${index}`}>{label}</li>
                    ))}
                    {importAdditions.added.length > 6 && (
                      <li>and {importAdditions.added.length - 6} more</li>
                    )}
                  </ul>
                </div>
              )}

              {importAdditions.needsAccount.length > 0 && (
                <p className="rounded-lg border border-amber-400/20 bg-amber-500/10 p-2 text-xs text-amber-500">
                  This file uses your own {importAdditions.needsAccount.join(' and ')} catalogs, such as your
                  watchlist. Connect {importAdditions.needsAccount.length === 1 ? 'that account' : 'those accounts'} and
                  import again to have them added.
                </p>
              )}

              {importUnresolved.length > 0 && (
                <div className="space-y-1 rounded-lg border border-amber-400/20 bg-amber-500/10 p-2">
                  <p className="text-xs text-amber-500">
                    These catalogs are not in your setup and the file does not say how to rebuild them. You can
                    still import, but those tiles will come up empty.
                  </p>
                  <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
                    {importUnresolved.slice(0, 6).map((source, index) => (
                      <li key={`${source.catalogId}-${source.type}-${index}`}>
                        {source.catalogId} <span className="opacity-60">({source.type})</span>
                      </li>
                    ))}
                    {importUnresolved.length > 6 && <li>and {importUnresolved.length - 6} more</li>}
                  </ul>
                </div>
              )}

              {importCounts && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {([
                    ['Collections', importCounts.collections],
                    ['Folders', importCounts.folders],
                    ['Catalogs', importCounts.sources],
                    ['Existing', importCounts.existing],
                  ] as const).map(([label, value]) => (
                    <div key={label} className="rounded-lg bg-white/[0.03] px-2 py-1.5">
                      <div className="text-base font-semibold leading-tight">{value}</div>
                      <div className="text-[10px] text-muted-foreground">{label}</div>
                    </div>
                  ))}
                </div>
              )}

              {importPreview.entries.length > 0 && (
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {importPreview.entries.slice(0, 6).map(entry => (
                    <li key={entry.id} className="flex items-center gap-2">
                      {entry.kind === 'collection'
                        ? <Layers className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                        : <Rows3 className="h-3.5 w-3.5 shrink-0 text-violet-400" />}
                      <span className="truncate">{entry.title}</span>
                      <span className="shrink-0">({entrySourceCount(entry)})</span>
                    </li>
                  ))}
                  {importPreview.entries.length > 6 && (
                    <li>and {importPreview.entries.length - 6} more</li>
                  )}
                </ul>
              )}

              {importPreview.notes.length > 0 && (
                <ul className="space-y-1 text-xs text-amber-500">
                  {importPreview.notes.slice(0, 5).map((note, index) => (
                    <li key={index} className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /> {note}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {importPreview && importPreview.entries.length > 0 && (
            <p className="border-t border-white/[0.06] pt-3 text-xs text-muted-foreground">
              <span className="text-foreground">Merge</span> folds the file into whatever it shares an id with,
              skipping catalogs you already have. <span className="text-foreground">Add as new</span> keeps both
              copies. <span className="text-foreground">Overwrite</span> discards what you have.
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-3">
            <Button variant="ghost" onClick={() => { setImportOpen(false); setImportText(''); setImportPreview(null); setConfirmReplace(false); }}>
              Cancel
            </Button>
            <Button
              variant="outline"
              disabled={!importPreview || importPreview.entries.length === 0}
              className={confirmReplace ? 'border-destructive text-destructive' : undefined}
              onClick={() => {
                if (entries.length > 0 && !confirmReplace) {
                  setConfirmReplace(true);
                  return;
                }
                runImport('replace');
              }}
            >
              {confirmReplace
                ? `Really discard ${entries.length}?`
                : entries.length > 0 ? `Overwrite all ${entries.length}` : 'Overwrite'}
            </Button>
            <Button
              variant="outline"
              disabled={!importPreview || importPreview.entries.length === 0}
              onClick={() => runImport('append')}
            >
              Add as new
            </Button>
            <Button
              disabled={!importPreview || importPreview.entries.length === 0}
              onClick={() => runImport('merge')}
            >
              Merge
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={remapOpen} onOpenChange={open => { if (!open) { setRemapOpen(false); setRemapChoices({}); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Replace className="h-5 w-5" /> Swap in your catalogs
            </DialogTitle>
            <DialogDescription>
              Keep the imported layout and point each missing catalog at one of yours. Every place it is
              used gets updated.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[26rem] min-w-0 space-y-2 overflow-y-auto">
            {missingGroups.map(group => {
              const chosen = remapChoices[group.key];
              return (
                <div
                  key={group.key}
                  className={`space-y-2 rounded-xl border border-white/[0.06] p-3 ${
                    chosen ? 'border-primary/50 bg-primary/5' : 'border-amber-600/40 bg-amber-950/10'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {chosen
                      ? <Check className="h-4 w-4 shrink-0 text-primary" />
                      : <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />}
                    <span className="min-w-0 flex-1 truncate text-sm">{group.name}</span>
                    <Badge variant="outline" className="shrink-0 text-xs">{group.type}</Badge>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      used {group.occurrences === 1 ? 'once' : `${group.occurrences} times`}
                    </span>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">{group.catalogId}</p>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">replace with</span>
                    {chosen ? (
                      <>
                        <Badge
                          variant="outline"
                          className={`text-xs font-semibold ${getSourceBadgeStyle(
                            sourceList.catalogs.find(c => catalogKey(c) === catalogKey(chosen))?.source
                          )}`}
                        >
                          {chosen.name}
                        </Badge>
                        <Button size="sm" variant="ghost" className="h-8" onClick={() => setRemapPickFor(group.key)}>
                          Change
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8"
                          onClick={() => setRemapChoices(prev => {
                            const next = { ...prev };
                            delete next[group.key];
                            return next;
                          })}
                        >
                          Clear
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" className="h-8" onClick={() => setRemapPickFor(group.key)}>
                        <Plus className="mr-1 h-3.5 w-3.5" /> Pick a catalog
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-3 sm:flex-row sm:items-center sm:justify-end">
            <span className="text-xs text-muted-foreground sm:mr-auto">
              {Object.keys(remapChoices).length} of {missingGroups.length} matched. Anything left unmatched stays
              as it is.
            </span>
            <Button variant="ghost" onClick={() => { setRemapOpen(false); setRemapChoices({}); }}>Cancel</Button>
            <Button disabled={Object.keys(remapChoices).length === 0} onClick={applyRemap}>
              Swap {Object.keys(remapChoices).length > 0 ? Object.keys(remapChoices).length : ''}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <CatalogPicker
        isOpen={remapPickFor !== null}
        catalogs={sourceList.catalogs}
        multiple={false}
        existingKeys={[]}
        tagOptions={tagOptions}
        onConfirm={picked => {
          const catalog = picked[0];
          if (!catalog || !remapPickFor) return;
          setRemapChoices(prev => ({
            ...prev,
            [remapPickFor]: sourceFromCatalog(catalog),
          }));
        }}
        onClose={() => setRemapPickFor(null)}
      />

      <Dialog open={confirmClose} onOpenChange={open => !open && setConfirmClose(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Keep your changes?
            </DialogTitle>
            <DialogDescription>
              You have edits that are not in your configuration yet. Closing now loses them.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfirmClose(false)}>Keep editing</Button>
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => { setConfirmClose(false); onClose(); }}
            >
              Discard
            </Button>
            <Button
              onClick={() => {
                setConfirmClose(false);
                if (handleSave('apply')) onClose();
              }}
            >
              Apply and close
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmApply}
        onOpenChange={open => { if (!open) setConfirmApply(false); }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Some catalogs are missing
            </DialogTitle>
            <DialogDescription>
              {unresolvedSources.length === 1
                ? '1 source points'
                : `${unresolvedSources.length} sources point`} at a catalog that is not in your setup:{' '}
              {unresolvedSources.slice(0, 3).map(source => source.catalogId).join(', ')}
              {unresolvedSources.length > 3 ? `, and ${unresolvedSources.length - 3} more` : ''}. Those tiles will
              come up empty until you add and enable the catalogs. Everything else works as normal.
            </DialogDescription>
          </DialogHeader>

          <p className="rounded-lg bg-white/[0.03] p-2 text-xs text-muted-foreground">
            Swapping keeps the layout and points each one at a catalog you already have, everywhere it is used.
          </p>

          <div className="flex flex-wrap justify-end gap-2 border-t border-white/[0.06] pt-3">
            <Button
              variant="ghost"
              onClick={() => setConfirmApply(false)}
            >
              Back to editing
            </Button>
            <Button
              variant="outline"
              onClick={() => { setConfirmApply(false); setRemapOpen(true); }}
            >
              <Replace className="mr-1.5 h-4 w-4" /> Swap catalogs
            </Button>
            <Button onClick={() => { setConfirmApply(false); applyToConfig({ thenSave: pendingMode === 'save' }); }}>
              Apply anyway
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={nativeBlockFor !== null} onOpenChange={open => { if (!open) setNativeBlockFor(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> {strandedTarget.here} cannot serve most of this
            </DialogTitle>
            <DialogDescription>
              {strandedNative} source{strandedNative === 1 ? '' : 's'} in this design{' '}
              {strandedNative === 1 ? 'is' : 'are'} fetched by the app itself, and{' '}
              {strandedTarget.here} has no equivalent. {emptyTiles > 0
                ? `${emptyTiles} of ${tileTotal} tiles would come out empty.`
                : `Those sources are left out on ${strandedTarget.here}.`}
            </DialogDescription>
          </DialogHeader>

          <p className="rounded-lg bg-white/[0.03] p-2 text-xs text-muted-foreground">
            {strandedTarget.other
              ? `The design is fine for ${strandedTarget.other}, so you can build for ${strandedTarget.other} instead. Routing the sources through AIOMetadata keeps them on both targets, at one catalog each.`
              : 'Routing the sources through AIOMetadata keeps them, at one catalog each.'}
          </p>

          <div className="flex flex-wrap justify-end gap-2 border-t border-white/[0.06] pt-3">
            <Button variant="ghost" onClick={() => setNativeBlockFor(null)}>Cancel</Button>
            {strandedTarget.other && (
              <Button
                variant="outline"
                onClick={() => { setTarget(strandedTarget.otherId); setNativeBlockFor(null); }}
              >
                <Tv className="mr-1.5 h-4 w-4" /> Build for {strandedTarget.other}
              </Button>
            )}
            <Button onClick={() => { convertNativeSources(); setNativeBlockFor(null); }}>
              <Replace className="mr-1.5 h-4 w-4" /> Route through AIOMetadata
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={overLimitOpen} onOpenChange={open => { if (!open) setOverLimitOpen(false); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Too many catalogs to add
            </DialogTitle>
            <DialogDescription>
              This design needs {pendingCount} catalog{pendingCount === 1 ? '' : 's'} you do not have, but there
              is room for {headroom}
              {maxCatalogs === null
                ? ' in a single import'
                : ` before this instance's limit of ${maxCatalogs}`}. Remove {overBy} more
              catalog{overBy === 1 ? '' : 's'} worth of tiles, or delete a collection you do not need, and the
              rest will be added.
            </DialogDescription>
          </DialogHeader>

          <p className="rounded-lg bg-white/[0.03] p-2 text-xs text-muted-foreground">
            You have {enabledCatalogCount} catalog{enabledCatalogCount === 1 ? '' : 's'} enabled. Every catalog
            added here becomes an entry in your manifest, which your client fetches each time it loads the addon.
          </p>

          <div className="flex flex-wrap justify-end gap-2 border-t border-white/[0.06] pt-3">
            <Button variant="ghost" onClick={() => setOverLimitOpen(false)}>Back to editing</Button>
            <Button
              variant="outline"
              onClick={() => { setOverLimitOpen(false); applyToConfig({ withCatalogs: false, thenSave: pendingMode === 'save' }); }}
            >
              Apply layout only
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <CatalogPicker
        isOpen={pickerTarget !== null}
        catalogs={sourceList.catalogs}
        multiple={pickerTarget?.folderId !== null && typeof pickerTarget?.replaceIndex !== 'number'}
        existingKeys={pickerExistingKeys}
        tagOptions={tagOptions}
        onConfirm={handlePick}
        onCreate={handleCreateSources}
        onClose={() => setPickerTarget(null)}
      />
    </>
  );
}
