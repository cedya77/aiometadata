import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useConfig } from '@/contexts/ConfigContext';
import { useCatalogTags } from '@/hooks/useCatalogTags';
import { TagChip } from '@/components/TagChip';
import { TagEditorDialog } from '@/components/TagEditorDialog';
import { cn } from '@/lib/utils';
import type { CatalogConfig } from '@/contexts/config';

type CatalogTagRowMode = 'all' | 'chips' | 'button';

export function CatalogTagRow({
  catalog,
  mode = 'all',
  className,
}: {
  catalog: CatalogConfig;
  mode?: CatalogTagRowMode;
  className?: string;
}) {
  const { config } = useConfig();
  const { removeTagFromCatalogs } = useCatalogTags();
  const [open, setOpen] = useState(false);

  const colorMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of config.tags ?? []) m[t.name] = t.color;
    return m;
  }, [config.tags]);

  const key = `${catalog.id}-${catalog.type}`;
  const targetKeys = useMemo(() => new Set([key]), [key]);
  const tags = catalog.tags ?? [];
  const showChips = mode !== 'button';
  const showButton = mode !== 'chips';

  if (mode === 'chips' && tags.length === 0) return null;

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1 align-middle", className)}>
      {showChips && tags.map((t) => (
          <TagChip
            key={t}
            name={t}
            color={colorMap[t]}
            onRemove={() => removeTagFromCatalogs(targetKeys, t)}
          />
        ))}
      {showButton && (
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={`Edit tags for ${catalog.name}`}
            className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-muted-foreground/40 px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/60 hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            {tags.length === 0 && <span>Tag</span>}
          </button>
          <TagEditorDialog
            open={open}
            onOpenChange={setOpen}
            targetKeys={targetKeys}
            title={catalog.name}
          />
        </>
      )}
    </span>
  );
}
