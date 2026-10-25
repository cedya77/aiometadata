export const sourceBadgeStyles: Record<string, string> = {
  tmdb: "bg-blue-800/80 text-blue-200 border-blue-600/50 hover:bg-blue-800",
  tvdb: "bg-green-800/80 text-green-200 border-green-600/50 hover:bg-green-800",
  mal: "bg-indigo-800/80 text-indigo-200 border-indigo-600/50 hover:bg-indigo-800",
  tvmaze: "bg-orange-800/80 text-orange-200 border-orange-600/50 hover:bg-orange-800",
  mdblist: "bg-yellow-800/80 text-yellow-200 border-yellow-600/50 hover:bg-yellow-800",
  stremthru: "bg-purple-800/80 text-purple-200 border-purple-600/50 hover:bg-purple-800",
  custom: "bg-pink-800/80 text-pink-200 border-pink-600/50 hover:bg-pink-800",
  trakt: "bg-red-800/80 text-red-200 border-red-600/50 hover:bg-red-800",
  anilist: "bg-cyan-800/80 text-cyan-200 border-cyan-600/50 hover:bg-cyan-800",
  flixpatrol: "bg-emerald-800/80 text-emerald-200 border-emerald-600/50 hover:bg-emerald-800",
  merged: "bg-violet-800/80 text-violet-200 border-violet-600/50 hover:bg-violet-800",
  streaming: "bg-sky-800/80 text-sky-200 border-sky-600/50 hover:bg-sky-800",
  letterboxd: "bg-lime-800/80 text-lime-200 border-lime-600/50 hover:bg-lime-800",
  simkl: "bg-teal-800/80 text-teal-200 border-teal-600/50 hover:bg-teal-800",
  movielens: "bg-amber-800/80 text-amber-200 border-amber-600/50 hover:bg-amber-800",
  publicmetadb: "bg-fuchsia-800/80 text-fuchsia-200 border-fuchsia-600/50 hover:bg-fuchsia-800",
  lumiere: "bg-rose-800/80 text-rose-200 border-rose-600/50 hover:bg-rose-800",
};

export const sourceDotStyles: Record<string, string> = {
  tmdb: 'bg-blue-400',
  tvdb: 'bg-green-400',
  mal: 'bg-indigo-400',
  tvmaze: 'bg-orange-400',
  mdblist: 'bg-yellow-400',
  stremthru: 'bg-purple-400',
  custom: 'bg-pink-400',
  trakt: 'bg-red-400',
  anilist: 'bg-cyan-400',
  flixpatrol: 'bg-emerald-400',
  merged: 'bg-violet-400',
  streaming: 'bg-sky-400',
  letterboxd: 'bg-lime-400',
  simkl: 'bg-teal-400',
  movielens: 'bg-amber-400',
  publicmetadb: 'bg-fuchsia-400',
  lumiere: 'bg-rose-400',
};

export function getSourceDotStyle(source?: string): string {
  return sourceDotStyles[source || 'custom'] || 'bg-slate-400';
}

export const sourceBadgeLabels: Record<string, string> = {
  flixpatrol: 'TOP 10',
  publicmetadb: 'PMDB',
  movielens: 'MLENS',
};

export function getSourceBadgeStyle(source?: string): string {
  return sourceBadgeStyles[source || ''] || "bg-slate-700/80 text-slate-200 border-slate-500/50";
}

export function getSourceBadgeLabel(source?: string): string {
  const key = source || 'custom';
  return sourceBadgeLabels[key] || key.toUpperCase();
}
