// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { AGE_RATING_ORDER } from '@/lib/ageRatings';
import type { TagDef } from '@/contexts/config';

const CHIP = 'rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors';
const CHIP_ON = 'border-primary bg-primary text-primary-foreground';
const CHIP_OFF = 'border-muted-foreground/30 text-muted-foreground hover:text-foreground';

export type TagLimit = Pick<TagDef, 'ageRating' | 'allowUnratedContent'>;

interface TagLimitPickerProps {
  id: string;
  value: TagLimit;
  onChange: (patch: TagLimit) => void;
}

export function TagLimitPicker({ id, value, onChange }: TagLimitPickerProps) {
  const hasLimit = !!value.ageRating && value.ageRating !== 'None';

  return (
    <div className="space-y-2 rounded-lg bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onChange({ ageRating: 'None', allowUnratedContent: undefined })}
          aria-pressed={!hasLimit}
          className={cn(CHIP, !hasLimit ? CHIP_ON : CHIP_OFF)}
        >
          No rating limit
        </button>
        {AGE_RATING_ORDER.map((rating) => (
          <button
            key={rating}
            type="button"
            onClick={() => onChange({ ageRating: rating })}
            aria-pressed={value.ageRating === rating}
            className={cn(CHIP, value.ageRating === rating ? CHIP_ON : CHIP_OFF)}
          >
            {rating}
          </button>
        ))}
      </div>
      {hasLimit && (
        <div className="flex items-center gap-2">
          <Switch
            id={`tag-unrated-${id}`}
            checked={value.allowUnratedContent !== false}
            onCheckedChange={(checked) => onChange({ allowUnratedContent: checked })}
          />
          <Label className="text-xs" htmlFor={`tag-unrated-${id}`}>Show unrated titles</Label>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {hasLimit
          ? `Installing this profile shows only titles rated ${value.ageRating} or lower in its catalogs and in search. It can only tighten the content rating you saved in Filters, never lift it.`
          : 'Give a profile a content rating so it installs already restricted, instead of aiming one at catalogs that cannot be filtered.'}
      </p>
    </div>
  );
}
