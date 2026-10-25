import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import type { CatalogConfig, JellyfinUser } from "@/contexts/config";
import { createPublicMetaDBPickCatalog } from "@/utils/catalogUtils";

interface Pick {
  id: string;
  name: string;
  description?: string;
  filters?: { media_types?: string[] };
}

interface ProfilePicksProps {
  user: JellyfinUser;
  catalogs: CatalogConfig[];
  onAddCatalogs: (entries: CatalogConfig[]) => void;
  onRemoveCatalogs: (ids: string[]) => void;
}

export function ProfilePicks({ user, catalogs, onAddCatalogs, onRemoveCatalogs }: ProfilePicksProps) {
  const [picks, setPicks] = useState<Pick[] | null>(null);
  const [loading, setLoading] = useState(false);
  const apiKey = user.accounts?.apiKeys?.publicmetadb;

  const owned = catalogs.filter((c) => c.id.startsWith('publicmetadb.pick.') && c.metadata?.accountOwner === user.id);
  const taken = new Set(catalogs.map((c) => c.id));

  const load = async () => {
    if (!apiKey) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/publicmetadb/picks?apikey=${encodeURIComponent(apiKey)}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const items: Pick[] = data.items || [];
      setPicks(items);
      if (!items.length) toast.info(`${user.name} has no picks on PublicMetaDB yet`);
    } catch {
      toast.error(`Could not load ${user.name}'s picks`);
    } finally {
      setLoading(false);
    }
  };

  const add = (pick: Pick) => {
    const entry = createPublicMetaDBPickCatalog(pick);
    onAddCatalogs([{ ...entry, metadata: { ...(entry.metadata ?? {}), accountOwner: user.id } }]);
    toast.success(`Added ${pick.name} for ${user.name}`);
  };

  const offered = (picks ?? []).filter((pick) => !taken.has(`publicmetadb.pick.${pick.id}`));

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex items-center gap-2">
        <Label className="text-xs font-medium">Picks</Label>
        <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" disabled={loading || !apiKey} onClick={load}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : picks ? 'Reload' : 'Load picks'}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {user.name}'s own picks, ranked by their taste. Your picks are not shown to {user.name} while this account is connected.
      </p>
      {owned.length ? (
        <ul className="space-y-1">
          {owned.map((row) => (
            <li key={row.id} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              <span className="text-[11px] capitalize text-muted-foreground">{row.type}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${row.name}`}
                onClick={() => onRemoveCatalogs([row.id])}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {picks && offered.length ? (
        <ul className="space-y-1">
          {offered.map((pick) => (
            <li key={pick.id} className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-xs">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{pick.name}</span>
                {pick.description ? <span className="block truncate text-[11px] text-muted-foreground">{pick.description}</span> : null}
              </span>
              <Button size="sm" variant="ghost" className="h-7 shrink-0 text-xs" onClick={() => add(pick)}>
                <Plus className="mr-1 h-3 w-3" /> Add
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {picks && picks.length > 0 && !offered.length ? (
        <p className="text-[11px] text-muted-foreground">Every pick on this account is already a row.</p>
      ) : null}
    </div>
  );
}
