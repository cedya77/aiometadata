/**
 * Typed by hand on a TV remote as often as pasted, so the alphabet leaves out
 * the characters that are read wrong and the groups keep the place visible.
 */
export function newClientPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export const CODE_LENGTH = 6;

export const emptyCode = (): string[] => Array.from({ length: CODE_LENGTH }, () => '');

export function normaliseStreamUrl(value: string): string {
  return value.replace(/^\s*stremio:\/\//i, 'https://');
}

export function isManifestUrl(value: string): boolean {
  return /^https?:\/\/\S+\/manifest\.json$/i.test(value.trim());
}

export type ManifestCheck =
  | { ok: true; name: string; version?: string; streams: boolean }
  | { ok: false };

const MANIFEST_TIMEOUT_MS = 6000;

export async function checkStreamManifest(url: string, signal?: AbortSignal): Promise<ManifestCheck> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward);
  try {
    const response = await fetch(url.trim(), { signal: controller.signal });
    if (!response.ok) return { ok: false };
    const manifest = await response.json();
    if (!manifest || typeof manifest !== 'object') return { ok: false };
    const resources: unknown[] = Array.isArray(manifest.resources) ? manifest.resources : [];
    const streams = resources.some((resource) =>
      resource === 'stream' || (typeof resource === 'object' && resource !== null && (resource as { name?: unknown }).name === 'stream'));
    return {
      ok: true,
      name: typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : 'Addon',
      version: typeof manifest.version === 'string' ? manifest.version : undefined,
      streams,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false };
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}
