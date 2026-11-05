/** A built-in tag, not stored in a configuration: a holder sees every catalog that carries no tag. */
export const UNTAGGED_TAG = 'Untagged';

export function isUntaggedTag(name: unknown): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === UNTAGGED_TAG.toLowerCase();
}

/** True when an entry's own tags meet a lowercase set of wanted tags, counting Untagged as "carries none". */
export function carriesAnyTag(own: unknown, wanted: Set<string>): boolean {
  const list = Array.isArray(own) ? own.filter(Boolean) : [];
  if (list.length === 0) return wanted.has(UNTAGGED_TAG.toLowerCase());
  return list.some((t) => wanted.has(String(t).toLowerCase()));
}
