// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { TagChip } from '@/components/TagChip';
import type { TagDef } from '@/contexts/config';

/** Which server users an entry is for; none picked means all of them. */
export function UserTagsField({ tags, value, onChange }: { tags: TagDef[]; value?: string[]; onChange: (next: string[] | undefined) => void }) {
  if (!tags.length) return null;
  const chosen = (value ?? []).filter(tag => tags.some(t => t.name === tag));
  const toggle = (name: string) => {
    const next = chosen.includes(name) ? chosen.filter(t => t !== name) : [...chosen, name];
    onChange(next.length ? next : undefined);
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">Users</Label>
        <Badge variant="outline" className="border-purple-400/60 text-[10px] text-purple-400">Jellyfin only</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map(tag => (
          <TagChip
            key={tag.name}
            name={tag.name}
            color={tag.color}
            onClick={() => toggle(tag.name)}
            pressed={chosen.includes(tag.name)}
            dimmed={chosen.length > 0 && !chosen.includes(tag.name)}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {chosen.length === 0
          ? 'Every user of the Jellyfin server sees it, trimmed to the catalogs their tags reach. Pick tags to show it to the users made of them only.'
          : `Only Jellyfin users made of ${chosen.length === 1 ? 'this tag' : 'one of these tags'} see it. The Nuvio export is unaffected.`}
      </p>
    </div>
  );
}
