// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useWebSearch, type WebSearchEngineInfo } from '@/hooks/useWebSearch';
import { SettingRow } from './SettingRow';

const OWN = 'own';

function engineNote(engine: WebSearchEngineInfo | undefined, reachable: boolean): string {
  if (!engine) return '';
  if (!reachable) return `${engine.name} cannot be reached without a key, so this searches without the web. Add one under Integrations.`;
  return `${engine.name} searches the web and hands the model what it found, so any model can use it. ${engine.about} The same search is reused for a while.`;
}

/** The engines to offer: those reachable, and the chosen one even when it no longer is, so it can be changed. */
function useChoices(via?: string) {
  const { engines, available } = useWebSearch();
  const listed = engines.filter((engine) => available.includes(engine) || engine.id === via);
  return { listed, available, chosen: engines.find((engine) => engine.id === via) };
}

/** Which engine searches the web, where the AI provider has a search of its own too. */
export function WebSearchEngineSelect({ id, own, via, onChange }: {
  id: string;
  own: string;
  via?: string;
  onChange: (via: string | undefined) => void;
}) {
  const { listed, available, chosen } = useChoices(via);
  return (
    <SettingRow
      htmlFor={id}
      label="Search with"
      description={chosen ? engineNote(chosen, available.includes(chosen)) : `${own} runs the search, on its own terms and billing.`}
      control={
        <Select value={chosen ? chosen.id : OWN} onValueChange={(value) => onChange(value === OWN ? undefined : value)}>
          <SelectTrigger id={id} aria-label="Search with" className="w-full sm:w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={OWN}>{own}</SelectItem>
            {listed.map((engine) => <SelectItem key={engine.id} value={engine.id}>{engine.name}</SelectItem>)}
          </SelectContent>
        </Select>
      }
    />
  );
}

/** Web search where the AI provider has none of its own, so only an engine here can search; `via` unset is off. */
export function EngineOnlySearch({ id, label, on, via, onChange }: {
  id: string;
  label: string;
  on: boolean;
  via?: string;
  onChange: (via: string | undefined) => void;
}) {
  const { listed, available, chosen } = useChoices(via);
  const shown = on ? chosen : available[0];
  return (
    <>
      <SettingRow
        htmlFor={id}
        label={label}
        description={engineNote(shown, Boolean(shown && available.includes(shown)))}
        control={<Switch id={id} className="shrink-0" checked={on} onCheckedChange={(checked) => onChange(checked ? (chosen && available.includes(chosen) ? chosen.id : available[0]?.id) : undefined)} />}
      />
      {on && listed.length > 1 && (
        <SettingRow
          htmlFor={`${id}-engine`}
          label="Search with"
          control={
            <Select value={chosen?.id} onValueChange={(value) => onChange(value)}>
              <SelectTrigger id={`${id}-engine`} aria-label="Search with" className="w-full sm:w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {listed.map((engine) => <SelectItem key={engine.id} value={engine.id}>{engine.name}</SelectItem>)}
              </SelectContent>
            </Select>
          }
        />
      )}
    </>
  );
}
