/** How several catalogs combine into one list, for a merged catalog and a builder folder alike. */
export type MergeMode = 'interleaved' | 'sequential' | 'alternating';

export interface MergeModeInfo {
  id: MergeMode;
  label: string;
  description: string;
  /** What the first titles look like, A and B being the first two catalogs. */
  example: string;
}

export const MERGE_MODES: MergeModeInfo[] = [
  { id: 'interleaved', label: 'Interleaved', description: 'Mix items from all sources (A B A B)', example: 'A1 B1 A2 B2' },
  { id: 'sequential', label: 'Sequential', description: 'Show all of source A, then B, etc.', example: 'all A, then all B' },
  { id: 'alternating', label: 'Alternating', description: 'Page 1 = A, page 2 = B, cycle', example: 'page 1 = A, page 2 = B' },
];

export function isMergeMode(value: unknown): value is MergeMode {
  return MERGE_MODES.some((mode) => mode.id === value);
}

export function mergeModeOf(value: unknown, fallback: MergeMode): MergeMode {
  return isMergeMode(value) ? value : fallback;
}

/** A merged catalog interleaves unless told otherwise. */
export const MERGED_CATALOG_MODE: MergeMode = 'interleaved';

/** A folder reads its catalogs one after another unless told otherwise. */
export const FOLDER_MERGE_MODE: MergeMode = 'sequential';
