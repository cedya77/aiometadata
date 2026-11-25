// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { LiveTvPick } from '@/contexts/config';
import { checkStreamManifest, isManifestUrl } from '@/lib/jellyfinClient';
import { MAX_PICKED, onlyPicked, sameAddon, withGroups, withOnly } from '@/lib/liveTvGroups';
import { cn } from '@/lib/utils';

const CHECK_STALE_MS = 5 * 60_000;

export function LiveTvGroups({ id, name, main, addonUrl, rated, value, onChange, row }: {
  id: string;
  name: string;
  main?: boolean;
  /** The playback addon this person plays from. */
  addonUrl: string;
  /** Whether this person is held to a content rating. */
  rated: boolean;
  value?: LiveTvPick;
  onChange: (next: LiveTvPick | undefined) => void;
  row: (label: string, description: string, body: ReactNode) => ReactNode;
}) {
  const url = addonUrl.trim();
  const readable = isManifestUrl(url);
  const manifest = useQuery({
    queryKey: ['stream-manifest', url],
    queryFn: ({ signal }) => checkStreamManifest(url, signal),
    enabled: readable,
    staleTime: CHECK_STALE_MS,
    retry: false,
  });
  const [search, setSearch] = useState('');
  const [warning, setWarning] = useState(false);

  const check = manifest.data;
  const groups = useMemo(() => (check?.ok ? check.groups : []), [check]);
  const stale = Boolean(value && !sameAddon(value.addon, url));
  const picked = useMemo(() => new Set(stale ? [] : value?.groups ?? []), [stale, value]);
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = groups.filter((group) => words.every((word) => group.toLowerCase().includes(word)));
  const gone = useMemo(() => [...picked].filter((group) => !groups.includes(group)), [picked, groups]);

  const unreadable = !readable || (check !== undefined && !check.ok);
  const none = check?.ok && !groups.length;
  if (!groups.length && !(value && (unreadable || none))) return null;

  const set = (next: string[]) => onChange(withGroups(stale ? undefined : value, url, next));
  const toggle = (group: string) => set(picked.has(group) ? [...picked].filter((g) => g !== group) : [...picked, group]);
  const only = onlyPicked(stale ? undefined : value, rated);
  const who = main ? 'you' : name || 'this person';

  const description = picked.size
    ? `The channel groups ${who} get${main ? '' : 's'} in Live TV.`
    : rated
      ? `The channel groups ${who} get${main ? '' : 's'} in Live TV. None picked means no Live TV, because of the content rating.`
      : `The channel groups ${who} get${main ? '' : 's'} in Live TV. None picked means all of them.`;

  return (
    <>
      {row('Live TV groups', description, (
        <div className="space-y-2 sm:max-w-xl">
          {stale ? <p className="text-xs text-amber-400">These were picked for another addon.{none ? '' : ' Pick them again.'}</p> : null}
          {unreadable || none ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{none ? 'This addon has no channel groups.' : "Couldn't read the groups from your browser."} {value?.groups.length ?? 0} picked.</span>
              {value ? <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => onChange(undefined)}>Clear</Button> : null}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={`${id}-search`}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search groups"
                  aria-label="Search groups"
                  className="h-8 min-w-40 flex-1"
                />
                <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">{picked.size} of {groups.length}</span>
                <Button variant="outline" size="sm" className="h-8 px-2 text-xs" disabled={!words.length || !shown.length} onClick={() => set([...picked, ...shown])}>Pick shown</Button>
                <Button variant="outline" size="sm" className="h-8 px-2 text-xs" disabled={!picked.size} onClick={() => set([])}>Clear</Button>
              </div>
              <ul className="max-h-64 divide-y overflow-y-auto rounded-md border" aria-label="Channel groups">
                {shown.map((group) => (
                  <li key={group}>
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/30">
                      <input type="checkbox" className="h-4 w-4 shrink-0 accent-primary" checked={picked.has(group)} disabled={!picked.has(group) && picked.size >= MAX_PICKED} onChange={() => toggle(group)} />
                      <span className={cn('min-w-0 truncate', picked.has(group) ? 'text-foreground' : 'text-muted-foreground')}>{group}</span>
                    </label>
                  </li>
                ))}
                {shown.length ? null : <li className="px-3 py-2 text-sm text-muted-foreground">No group matches.</li>}
              </ul>
              {gone.length ? (
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>Picked but no longer offered:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {gone.map((group) => (
                      <Button key={group} variant="outline" size="sm" className="h-7 max-w-full truncate px-2 text-xs" onClick={() => toggle(group)} aria-label={`Remove ${group}`}>{group} ×</Button>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
          {picked.size ? (
            <label htmlFor={`${id}-only`} className="flex items-start justify-between gap-4 pt-1">
              <span className="min-w-0 space-y-0.5">
                <span className="block text-sm font-medium">Only these groups</span>
                <span className="block text-xs text-muted-foreground">
                  {only ? 'Search, favourites and the groups menu stay in them too.' : 'Lists and the guide show them. Search can open every channel.'}
                </span>
              </span>
              <Switch id={`${id}-only`} checked={only} onCheckedChange={(on) => (rated && !on ? setWarning(true) : value && onChange(withOnly(value, on, rated)))} />
            </label>
          ) : null}
        </div>
      ))}
      <AlertDialog open={warning} onOpenChange={setWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Let {who} reach every channel?</AlertDialogTitle>
            <AlertDialogDescription>
              {main ? 'You have' : `${name || 'This person'} has`} a content rating. With this off, search can find and open every channel, including those outside these groups.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction onClick={() => value && onChange(withOnly(value, false, rated))}>Turn off</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
