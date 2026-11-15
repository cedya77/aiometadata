// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useMemo, useState } from 'react';
import { ChevronDown, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const MAIN = 'main';

/** Copies a connected service's watchlist into this server's own list, once. */
export function ServerWatchlistImport() {
  const { config, auth } = useConfig();
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [profile, setProfile] = useState(MAIN);
  const [importing, setImporting] = useState(false);

  const services = useMemo(() => [
    { value: 'mdblist', label: 'MDBList', ready: Boolean(config.apiKeys?.mdblist) && config.mdblistWatchTracking !== false },
    { value: 'simkl', label: 'Simkl', ready: Boolean(config.apiKeys?.simklTokenId) && config.simklWatchTracking !== false },
    { value: 'anilist', label: 'AniList', ready: Boolean(config.apiKeys?.anilistTokenId) && config.anilistWatchTracking !== false },
    { value: 'mal', label: 'MyAnimeList', ready: Boolean(config.apiKeys?.malTokenId) && config.malWatchTracking !== false },
    { value: 'publicmetadb', label: 'PublicMetaDB', ready: Boolean(config.apiKeys?.publicmetadb) && config.publicmetadbWatchTracking !== false },
  ].filter((s) => s.ready), [config.apiKeys, config.mdblistWatchTracking, config.simklWatchTracking, config.anilistWatchTracking, config.malWatchTracking, config.publicmetadbWatchTracking]);

  const users = config.jellyfinUsers ?? [];
  const mainName = config.jellyfinUserName || config.addonName || auth.userUUID?.slice(0, 8) || 'Main';

  if (!services.length) return null;

  const picked = services.filter((s) => !skipped.has(s.value));
  const from = picked.length === 1 ? picked[0].label : picked.length === 2 ? `${picked[0].label} and ${picked[1].label}` : `${picked.length} services`;
  const sourceLabel = !picked.length
    ? 'Pick a service'
    : picked.length === services.length && services.length > 1
      ? 'Every connected'
      : picked.length <= 2 ? picked.map((s) => s.label).join(', ') : `${picked.length} services`;
  const toggle = (value: string) => setSkipped((prev) => {
    const next = new Set(prev);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  });
  const target = profile === MAIN ? null : users.find((u) => u.id === profile) ?? null;
  const forName = target ? ` for ${target.name}` : '';

  const run = async () => {
    if (!auth.userUUID) {
      toast.error('Save the configuration first, then import.');
      return;
    }
    setImporting(true);
    try {
      const response = await fetch(`/api/jellyfin/${encodeURIComponent(auth.userUUID)}/import-watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: auth.password || undefined, profile: target?.id, services: picked.map((s) => s.value) }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || `Could not import from ${from}`);
      const added = Number(result?.added) || 0;
      const held = (Number(result?.found) || 0) - added;
      toast.success(added ? `${added} ${added === 1 ? 'title' : 'titles'} imported from ${from}${forName}` : `Nothing new on ${from}${forName}`, {
        description: [
          held > 0 ? `${held} ${held === 1 ? 'was' : 'were'} already on the list.` : null,
          result?.complete === false ? 'Part of the watchlist could not be read; import again later for the rest.' : null,
        ].filter(Boolean).join(' ') || undefined,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not import from ${from}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="mt-3 border-t border-white/[0.06] pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Import from</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 w-40 justify-between text-xs font-normal">
              <span className="truncate">{sourceLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            {services.map((s) => (
              <DropdownMenuCheckboxItem
                key={s.value}
                checked={!skipped.has(s.value)}
                onCheckedChange={() => toggle(s.value)}
                onSelect={(e) => e.preventDefault()}
                className="text-xs"
              >
                {s.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {users.length > 0 && (
          <>
            <span className="text-xs text-muted-foreground">into</span>
            <Select value={profile} onValueChange={setProfile}>
              <SelectTrigger className="h-8 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={MAIN} className="text-xs">{mainName}</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id} className="text-xs">{u.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        <Button variant="outline" size="sm" className="h-8 text-xs" disabled={importing || !picked.length} onClick={() => { void run(); }}>
          {importing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Download className="h-3 w-3 mr-1" />}
          Import
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Copies the watchlist into this server's list once. Titles already on it are skipped, and nothing is written back to the service.
      </p>
    </div>
  );
}
