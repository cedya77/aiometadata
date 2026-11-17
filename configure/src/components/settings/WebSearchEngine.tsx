// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SettingRow } from './SettingRow';

const FASTCRW_NOTE = 'fastCRW searches the web and hands the model what it found, so any model can use it. A search costs 2 fastCRW credits, and the same search is reused for a while.';
const FASTCRW_MISSING = 'No fastCRW key is set, so this searches without the web. Add one under Integrations.';

/** Which engine searches the web, where the provider has a search of its own too. */
export function WebSearchEngineSelect({ id, own, via, available, onChange }: {
  id: string;
  own: string;
  via?: 'fastcrw';
  /** fastCRW can be reached: a key of the configuration's own, or one the instance offers. */
  available: boolean;
  onChange: (via: 'fastcrw' | undefined) => void;
}) {
  return (
    <SettingRow
      htmlFor={id}
      label="Search with"
      description={via === 'fastcrw' ? (available ? FASTCRW_NOTE : FASTCRW_MISSING) : `${own} runs the search, on its own terms and billing.`}
      control={
        <Select value={via === 'fastcrw' ? 'fastcrw' : 'own'} onValueChange={(value) => onChange(value === 'fastcrw' ? 'fastcrw' : undefined)}>
          <SelectTrigger id={id} aria-label="Search with" className="w-full sm:w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="own">{own}</SelectItem>
            <SelectItem value="fastcrw">fastCRW</SelectItem>
          </SelectContent>
        </Select>
      }
    />
  );
}

/** Web search where the provider has none of its own, so fastCRW is the only engine. */
export function FastcrwSearchRow({ id, label, checked, available, onChange }: {
  id: string;
  label: string;
  checked: boolean;
  available: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <SettingRow
      htmlFor={id}
      label={label}
      description={available ? FASTCRW_NOTE : FASTCRW_MISSING}
      control={<Switch id={id} className="shrink-0" checked={checked} onCheckedChange={onChange} />}
    />
  );
}
