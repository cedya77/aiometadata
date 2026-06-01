import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getTagColor } from '@/lib/tagColors';
import type { TagColorKey } from '@/contexts/config';

interface TagChipProps {
  name: string;
  color?: TagColorKey | string;
  onRemove?: () => void;
  onClick?: () => void;
  dimmed?: boolean;
  className?: string;
}

export function TagChip({ name, color, onRemove, onClick, dimmed, className }: TagChipProps) {
  const c = getTagColor(color);
  return (
    <span
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
        c.chip,
        dimmed && 'opacity-40 grayscale',
        onClick && 'cursor-pointer hover:opacity-90',
        className,
      )}
    >
      {name}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 -mr-1 rounded-full p-0.5 hover:bg-black/25"
          aria-label={`Remove ${name} tag`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
