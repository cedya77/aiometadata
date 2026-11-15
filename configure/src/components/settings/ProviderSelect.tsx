// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface SelectableOption {
  value: string;
  label: string;
  requiresKey?: 'tvdb';
}

export function ProviderSelect({
  id,
  ariaLabel,
  value,
  onValueChange,
  options,
  includeMetaDefault = false,
  hasTvdbKey,
  disabled = false,
  className,
}: {
  id: string;
  ariaLabel: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectableOption[];
  includeMetaDefault?: boolean;
  hasTvdbKey: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const isBlocked = (option: SelectableOption) => option.requiresKey === 'tvdb' && !hasTvdbKey;

  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn('w-full', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {includeMetaDefault ? <SelectItem value="meta">Meta Provider (default)</SelectItem> : null}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={isBlocked(option)}>
            {option.label}
            {isBlocked(option) ? ' (API key required)' : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
