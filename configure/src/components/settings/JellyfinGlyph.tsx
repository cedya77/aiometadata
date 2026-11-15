import { cn } from '@/lib/utils';

const MASK = 'url(/jellyfin_icon.svg) center / contain no-repeat';

export function JellyfinGlyph({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block h-4 w-4 shrink-0 bg-current', className)} style={{ mask: MASK, WebkitMask: MASK }} />;
}
