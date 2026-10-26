import type { AppConfig } from '../contexts/config';
import { readValue, ART_TYPES, CONTENT_TYPES, type ContentType } from './artProviders';
import { fieldStrategy } from '../../../addon/lib/parentConfig';

export type ApiKeyId =
  | 'tmdb'
  | 'tvdb'
  | 'fanart'
  | 'mdblist'
  | 'rpdb'
  | 'topPoster'
  | 'publicmetadb'
  | 'ai_service';

export interface ConfigCaps {
  hasBuiltInTmdb: boolean;
  hasBuiltInTvdb: boolean;
  hasBuiltInGemini?: boolean;
}

export interface KeyStatus {
  id: ApiKeyId;
  name: string;
  anchor: string;
  configured: boolean;
  reason: string | null;
  required: boolean;
}

type ConfigLike = Partial<AppConfig> & Record<string, any>;

export const API_KEY_ROWS: { id: ApiKeyId; name: string; anchor: string }[] = [
  { id: 'tmdb', name: 'TMDB', anchor: 'tmdb' },
  { id: 'tvdb', name: 'TVDB', anchor: 'tvdb' },
  { id: 'fanart', name: 'Fanart', anchor: 'fanart' },
  { id: 'mdblist', name: 'MDBList', anchor: 'mdblist' },
  { id: 'rpdb', name: 'RPDB', anchor: 'rpdb' },
  { id: 'topPoster', name: 'TOP Posters', anchor: 'topPoster' },
  { id: 'publicmetadb', name: 'PublicMetaDB', anchor: 'publicmetadb' },
  { id: 'ai_service', name: 'AI Service', anchor: 'gemini' },
];

/** True when `provider` is selected for any content type / art type combination. */
export function usesArtProvider(config: ConfigLike, provider: string): boolean {
  const artProviders = config?.artProviders;
  if (!artProviders) return false;
  return CONTENT_TYPES.some((contentType: ContentType) =>
    ART_TYPES.some((artType) => readValue(artProviders as any, contentType, artType) === provider)
  );
}

export function enabledCatalogs(config: ConfigLike): Record<string, any>[] {
  return (config?.catalogs ?? []).filter((c: { enabled?: boolean }) => !!c?.enabled);
}

export function aiProvider(config: ConfigLike): 'gemini' | 'openrouter' {
  return config?.search?.ai_provider === 'openrouter' ? 'openrouter' : 'gemini';
}

/** True when `provider` is the movie, series or anime meta provider. */
export function usesMetaProvider(config: ConfigLike, provider: string): boolean {
  const providers = config?.providers;
  if (!providers) return false;
  return providers.movie === provider
    || providers.series === provider
    || providers.anime === provider;
}

export function requirementFor(config: ConfigLike, id: ApiKeyId): string | null {
  switch (id) {
    case 'tmdb':
      return 'The addon cannot fetch metadata without it'; // the addon cannot operate without it
    case 'tvdb': {
      const roles: string[] = [];
      if (usesMetaProvider(config, 'tvdb')) roles.push('a meta provider');
      if (usesArtProvider(config, 'tvdb')) roles.push('an art provider');
      return roles.length > 0 ? `Selected as ${roles.join(' and ')}` : null;
    }
    case 'fanart':
      return usesArtProvider(config, 'fanart') ? 'Selected as an art provider' : null;
    case 'mdblist': {
      const count = enabledCatalogs(config).filter(
        (c) => typeof c?.id === 'string' && c.id.startsWith('mdblist.')
      ).length;
      if (count === 0) return null;
      return count === 1
        ? '1 of your enabled catalogs comes from MDBList'
        : `${count} of your enabled catalogs come from MDBList`;
    }
    case 'ai_service':
      if (config?.search?.ai_enabled !== true) return null;
      return aiProvider(config) === 'openrouter'
        ? 'AI search is enabled and set to OpenRouter'
        : 'AI search is enabled and set to Gemini';
    // Optional enhancements: reported for visibility, never block a save.
    case 'rpdb':
    case 'topPoster':
    case 'publicmetadb':
      return null;
    default:
      return null;
  }
}

/** Retained wrapper: `required` is exactly "there is a reason". */
export function isKeyInUse(config: ConfigLike, id: ApiKeyId): boolean {
  return requirementFor(config, id) !== null;
}

export function isKeyConfigured(config: ConfigLike, id: ApiKeyId, caps: ConfigCaps): boolean {
  const apiKeys: Record<string, string | undefined> = config?.apiKeys || {};
  const keyName = id !== 'ai_service' ? id : aiProvider(config) === 'openrouter' ? 'openrouter' : 'gemini';
  // A key taken from the parent is checked by the server, against the merged config, on save.
  if (config?.parentConfig && fieldStrategy(config.parentConfig, 'apiKeys', `apiKeys.${keyName}`) !== 'override') {
    return true;
  }
  if (id === 'ai_service') {
    // The unselected provider's key cannot serve a search, so it cannot satisfy
    // the requirement either.
    return aiProvider(config) === 'openrouter'
      ? !!apiKeys.openrouter?.trim()
      : !!apiKeys.gemini?.trim() || !!caps.hasBuiltInGemini;
  }
  const hasUserKey = !!apiKeys[id]?.trim();
  if (id === 'tmdb') return hasUserKey || caps.hasBuiltInTmdb;
  if (id === 'tvdb') return hasUserKey || caps.hasBuiltInTvdb;
  return hasUserKey;
}

export function keyStatuses(config: ConfigLike, caps: ConfigCaps): KeyStatus[] {
  return API_KEY_ROWS.map(({ id, name, anchor }) => {
    const reason = requirementFor(config, id);
    return {
      id,
      name,
      anchor,
      configured: isKeyConfigured(config, id, caps),
      reason,
      required: reason !== null,
    };
  });
}

/** Required keys that are absent. A save is blocked exactly when this is non-empty. */
export function missingRequiredKeys(config: ConfigLike, caps: ConfigCaps): KeyStatus[] {
  return keyStatuses(config, caps).filter((row) => row.required && !row.configured);
}
