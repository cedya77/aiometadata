// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import React from 'react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useConfig } from '@/contexts/ConfigContext';
import { formatTTL } from '@/lib/catalogTTL';

interface CacheTTLFieldProps {
  value: number | null;
  onChange: (value: number | null) => void;
  min: number;
  max?: number;
  step?: number;
  id?: string;
  label?: string;
  help?: string;
}

export const CacheTTLField = ({
  value,
  onChange,
  min,
  max = 604800,
  step,
  id,
  label = 'Cache TTL (seconds)',
  help,
}: CacheTTLFieldProps) => {
  const { catalogTTL } = useConfig();
  const resolvedStep = step ?? (min === 0 ? 60 : Math.min(3600, Math.max(min, 60)));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {value !== null && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto py-0.5 px-2 text-xs"
            onClick={() => onChange(null)}
          >
            Use instance default
          </Button>
        )}
      </div>
      <div className="flex items-center space-x-2">
        <input
          id={id}
          type="number"
          value={value ?? ''}
          onChange={(e) => {
            const parsed = parseInt(e.target.value, 10);
            onChange(Number.isNaN(parsed) ? null : parsed);
          }}
          min={min}
          max={max}
          step={resolvedStep}
          placeholder={catalogTTL.toString()}
          className="flex-1 px-3 py-2 border border-input bg-background rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
        />
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          ({formatTTL(value ?? catalogTTL)})
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {value === null
          ? `Following the instance default (${formatTTL(catalogTTL)}). It tracks that default as it changes. Enter a value to override.`
          : help}
      </p>
    </div>
  );
};
