// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export type SaveStage = 'draft' | 'applied' | 'saved';

export interface SaveStageInput {
  builderJson: string;
  configJson: string;
  /** Null while no save target exists, so "clean" cannot be distinguished from "unknown". */
  configDirty: boolean | null;
}

export function deriveSaveStage({ builderJson, configJson, configDirty }: SaveStageInput): SaveStage {
  if (builderJson !== configJson) return 'draft';
  return configDirty === false ? 'saved' : 'applied';
}

export function describeSaveStage(stage: SaveStage, target: 'nuvio' | 'jellyfin' = 'nuvio'): { label: string; hint: string } {
  if (stage === 'draft') {
    return { label: 'Draft', hint: 'These edits are not in your configuration yet.' };
  }
  if (stage === 'applied') {
    return { label: 'Applied', hint: 'In your configuration, not yet on the server.' };
  }
  return {
    label: 'Saved',
    hint: target === 'jellyfin'
      ? 'Applied and stored on the server. Jellyfin clients show it the next time they load.'
      : 'Applied and stored on the server. Nuvio still needs to import it again to show the change.',
  };
}
