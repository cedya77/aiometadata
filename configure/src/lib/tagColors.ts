import type { TagColorKey } from '@/contexts/config';

export const TAG_COLORS: Record<TagColorKey, { chip: string; swatch: string }> = {
  blue: { chip: 'bg-blue-800/80 text-blue-200 border-blue-600/50', swatch: 'bg-blue-500' },
  green: { chip: 'bg-green-800/80 text-green-200 border-green-600/50', swatch: 'bg-green-500' },
  red: { chip: 'bg-red-800/80 text-red-200 border-red-600/50', swatch: 'bg-red-500' },
  violet: { chip: 'bg-violet-800/80 text-violet-200 border-violet-600/50', swatch: 'bg-violet-500' },
  amber: { chip: 'bg-amber-800/80 text-amber-200 border-amber-600/50', swatch: 'bg-amber-500' },
  cyan: { chip: 'bg-cyan-800/80 text-cyan-200 border-cyan-600/50', swatch: 'bg-cyan-500' },
  pink: { chip: 'bg-pink-800/80 text-pink-200 border-pink-600/50', swatch: 'bg-pink-500' },
  emerald: { chip: 'bg-emerald-800/80 text-emerald-200 border-emerald-600/50', swatch: 'bg-emerald-500' },
  orange: { chip: 'bg-orange-800/80 text-orange-200 border-orange-600/50', swatch: 'bg-orange-500' },
  indigo: { chip: 'bg-indigo-800/80 text-indigo-200 border-indigo-600/50', swatch: 'bg-indigo-500' },
  rose: { chip: 'bg-rose-800/80 text-rose-200 border-rose-600/50', swatch: 'bg-rose-500' },
  slate: { chip: 'bg-slate-700/80 text-slate-200 border-slate-500/50', swatch: 'bg-slate-500' },
};

export const TAG_COLOR_KEYS = Object.keys(TAG_COLORS) as TagColorKey[];

export function getTagColor(key?: string) {
  return TAG_COLORS[(key as TagColorKey)] ?? TAG_COLORS.slate;
}

export function nextTagColor(used: string[]): TagColorKey {
  const free = TAG_COLOR_KEYS.find((k) => !used.includes(k));
  return free ?? TAG_COLOR_KEYS[used.length % TAG_COLOR_KEYS.length];
}
