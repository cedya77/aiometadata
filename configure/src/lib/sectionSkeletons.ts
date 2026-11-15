import type { SettingsSectionId } from './settingsRoute';

/** Which control silhouette a card's rows should draw. */
export type ControlKind =
  /** A full-width trigger, `h-9 rounded-md`. */
  | 'select'
  /** A single `h-6 w-11 rounded-full` pill with a label beside it. */
  | 'switch'
  /** `controlCount` label+switch rows stacked. */
  | 'switch-list'
  /** `controlCount` label-above-field pairs. */
  | 'input'
  /** Prose only — no control silhouette. */
  | 'text';

export interface SkeletonCardSpec {
  /** Bars standing in for CardDescription. */
  descriptionLines: 1 | 2 | 3;
  control: ControlKind;
  /** Row repeat for 'switch-list' and 'input'. Ignored by the other kinds. */
  controlCount?: number;
}

export type SkeletonBlock =
  /** The page's real h2 + description, rendered as text rather than as bars. */
  | { kind: 'heading'; title: string; description: string }
  /** A Callout-shaped tinted strip. */
  | { kind: 'callout' }
  /** Presets' full-width gradient hero card. */
  | { kind: 'hero' }
  /** A row of pill-shaped buttons. */
  | { kind: 'toolbar'; buttons: number }
  /** One full-width card. */
  | { kind: 'card'; card: SkeletonCardSpec }
  /** Cards in a grid. `className` is copied from the page verbatim. */
  | { kind: 'grid'; className: string; cards: SkeletonCardSpec[] }
  /** Collapsed CollapsibleSettingCard headers: title + badge + chevron. */
  | { kind: 'collapsed-rows'; count: number }
  /** Catalog list rows: drag handle, title, trailing icon buttons. */
  | { kind: 'list-rows'; count: number };

export interface SkeletonSpec {
  /** Mirrors the page's outermost wrapper so the swap does not reflow. */
  className: string;
  blocks: SkeletonBlock[];
}

/** Every `kind` the renderer handles. Exported so tests catch typos in data. */
export const SKELETON_BLOCK_KINDS = [
  'heading',
  'callout',
  'hero',
  'toolbar',
  'card',
  'grid',
  'collapsed-rows',
  'list-rows',
] as const;

const TWO_COLUMN_GAP_6 = 'grid grid-cols-1 lg:grid-cols-2 gap-6';
const TWO_COLUMN_GAP_4 = 'grid grid-cols-1 lg:grid-cols-2 gap-4';
const THREE_COLUMN_GAP_6 = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6';

export const SECTION_SKELETONS: Record<SettingsSectionId, SkeletonSpec> = {
  'presets': {
    className: 'mx-auto w-full max-w-5xl space-y-10',
    blocks: [
      { kind: 'hero' },
      { kind: 'grid', className: THREE_COLUMN_GAP_6, cards: Array.from({ length: 3 }, () => ({ descriptionLines: 2, control: 'text' as const })) },
      { kind: 'grid', className: THREE_COLUMN_GAP_6, cards: Array.from({ length: 3 }, () => ({ descriptionLines: 2, control: 'text' as const })) },
    ],
  },

  'general': {
    className: 'space-y-8',
    blocks: [
      {
        kind: 'heading',
        title: 'General',
        description: 'Configure the basic display and content settings for your addon.',
      },
      {
        kind: 'grid',
        className: TWO_COLUMN_GAP_6,
        cards: [
          { descriptionLines: 2, control: 'select' },
          { descriptionLines: 2, control: 'switch-list', controlCount: 3 },
        ],
      },
    ],
  },

  'integrations': {
    className: 'space-y-8',
    blocks: [
      {
        kind: 'heading',
        title: 'Integrations & API Keys',
        description: 'Connect to external services to enhance metadata quality.',
      },
      {
        kind: 'grid',
        className: TWO_COLUMN_GAP_4,
        cards: Array.from({ length: 6 }, () => ({
          descriptionLines: 1 as const,
          control: 'input' as const,
          controlCount: 1,
        })),
      },
      { kind: 'toolbar', buttons: 1 },
    ],
  },

  'providers': {
    className: 'space-y-8',
    blocks: [
      {
        kind: 'heading',
        title: 'Meta Providers',
        description:
          'Choose your preferred source for metadata. Different providers may have better data for certain content.',
      },
      { kind: 'callout' },
      {
        kind: 'grid',
        className: THREE_COLUMN_GAP_6,
        cards: [
          { descriptionLines: 2, control: 'select' },
          { descriptionLines: 2, control: 'select' },
          { descriptionLines: 2, control: 'select' },
        ],
      },
      { kind: 'collapsed-rows', count: 3 },
    ],
  },

  'art-providers': {
    className: 'space-y-8',
    blocks: [
      {
        kind: 'heading',
        title: 'Art Providers',
        description:
          'Choose your preferred sources for different types of artwork. You can select different providers for posters, backgrounds, and logos.',
      },
      { kind: 'callout' },
      { kind: 'card', card: { descriptionLines: 1, control: 'switch-list', controlCount: 2 } },
      { kind: 'card', card: { descriptionLines: 1, control: 'select', controlCount: 3 } },
    ],
  },

  'filters': {
    className: 'space-y-8',
    blocks: [
      {
        kind: 'heading',
        title: 'Content Filters',
        description:
          'Filter the content displayed in catalogs and search results based on age ratings.',
      },
      {
        kind: 'grid',
        className: TWO_COLUMN_GAP_6,
        cards: [
          { descriptionLines: 2, control: 'select' },
          { descriptionLines: 2, control: 'switch' },
          { descriptionLines: 2, control: 'switch-list', controlCount: 2 },
          { descriptionLines: 2, control: 'switch-list', controlCount: 2 },
          { descriptionLines: 2, control: 'input', controlCount: 2 },
        ],
      },
      { kind: 'card', card: { descriptionLines: 1, control: 'input', controlCount: 2 } },
    ],
  },

  'search': {
    className: 'space-y-8',
    blocks: [
      {
        kind: 'heading',
        title: 'Search Settings',
        description: "Configure your addon's search functionality.",
      },
      { kind: 'card', card: { descriptionLines: 1, control: 'switch-list', controlCount: 5 } },
    ],
  },

  'catalogs': {
    className: 'space-y-8',
    blocks: [
      {
        kind: 'heading',
        title: 'Catalog Management',
        description: 'Drag to reorder. Click icons to toggle visibility.',
      },
      { kind: 'toolbar', buttons: 5 },
      { kind: 'list-rows', count: 8 },
    ],
  },

  // ConfigurationManager opens straight onto cards — it has no page h2.
  'watch-tracking': {
    className: 'space-y-8',
    blocks: [
      {
        kind: 'heading',
        title: 'Watch Tracking',
        description: 'Follow a watch from your app to your trackers.',
      },
      { kind: 'card', card: { descriptionLines: 2, control: 'switch-list', controlCount: 3 } },
      { kind: 'card', card: { descriptionLines: 1, control: 'switch-list', controlCount: 5 } },
      { kind: 'card', card: { descriptionLines: 2, control: 'text' } },
    ],
  },

  'people': {
    className: 'space-y-8',
    blocks: [
      {
        kind: 'heading',
        title: 'People',
        description: 'Everyone who watches here, each with their own catalogs, trackers and sign-in.',
      },
      { kind: 'grid', className: 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4', cards: [{ descriptionLines: 1, control: 'text' }, { descriptionLines: 1, control: 'text' }] },
      { kind: 'card', card: { descriptionLines: 2, control: 'switch-list', controlCount: 4 } },
    ],
  },

  'jellyfin': {
    className: 'space-y-8',
    blocks: [
      {
        kind: 'heading',
        title: 'Jellyfin',
        description: 'Connect Jellyfin apps to this configuration and choose how they play and browse.',
      },
      { kind: 'callout' },
      { kind: 'card', card: { descriptionLines: 1, control: 'input', controlCount: 1 } },
      { kind: 'grid', className: 'grid grid-cols-1 gap-3 md:grid-cols-2', cards: [{ descriptionLines: 1, control: 'input', controlCount: 1 }, { descriptionLines: 2, control: 'text' }] },
      { kind: 'card', card: { descriptionLines: 1, control: 'switch-list', controlCount: 4 } },
    ],
  },

  'configuration': {
    className: 'space-y-6',
    blocks: [
      { kind: 'card', card: { descriptionLines: 1, control: 'switch' } },
      { kind: 'card', card: { descriptionLines: 2, control: 'text' } },
      { kind: 'card', card: { descriptionLines: 1, control: 'text' } },
    ],
  },
};

/**
 * For the dashboard and rating entry points, which are not settings sections
 * and share none of their layout.
 */
export const GENERIC_SKELETON: SkeletonSpec = {
  className: 'space-y-6',
  blocks: [
    { kind: 'card', card: { descriptionLines: 2, control: 'text' } },
    {
      kind: 'grid',
      className: 'grid grid-cols-1 lg:grid-cols-2 gap-6',
      cards: [
        { descriptionLines: 1, control: 'text' },
        { descriptionLines: 1, control: 'text' },
      ],
    },
  ],
};
