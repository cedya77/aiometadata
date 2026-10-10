import type { AppConfig, CatalogConfig } from '@/contexts/config';
import { buildShareableCatalog, isUserSpecific } from '@/lib/catalogShare';
import type { ConfigTemplate, RequiredKeyId } from './types';

export const TEMPLATE_KIND = 'aiometadata.setupTemplate';
export const TEMPLATE_VERSION = 1;

export interface TemplateEnvelope {
  kind: typeof TEMPLATE_KIND;
  version: number;
  exportedAt: string;
  template: ConfigTemplate;
}

const SHARED_SETTING_KEYS = [
  'providers',
  'artProviders',
  'search',
  'mal',
  'tmdb',
  'tvdbSeasonType',
  'language',
  'contentRatingCountry',
  'ageRating',
  'sfw',
  'includeAdult',
] as const;

function pickSharedSettings(config: AppConfig): Partial<AppConfig> {
  const settings: Partial<AppConfig> = {};
  for (const key of SHARED_SETTING_KEYS) {
    const value = config[key];
    if (value !== undefined) (settings as Record<string, unknown>)[key] = value;
  }
  return settings;
}

function requiredKeysFromCatalogs(catalogs: CatalogConfig[]): RequiredKeyId[] {
  const sources = new Set(catalogs.map(catalog => catalog.source));
  const keys: RequiredKeyId[] = [];
  if (sources.has('tmdb')) keys.push('tmdb');
  if (sources.has('tvdb')) keys.push('tvdb');
  if (sources.has('mdblist')) keys.push('mdblist');
  return keys;
}

export function buildTemplateFromConfig(config: AppConfig, name: string): TemplateEnvelope {
  const enabled = (config.catalogs ?? []).filter(catalog => catalog.enabled);
  const portable = enabled.filter(catalog => !isUserSpecific(catalog.id));

  const builtIn = portable.filter(catalog => !catalog.id.includes('.discover.') && catalog.source !== 'mdblist');
  const carried = portable
    .filter(catalog => catalog.id.includes('.discover.') || catalog.source === 'mdblist')
    .map(catalog => buildShareableCatalog(catalog) as CatalogConfig);

  const template: ConfigTemplate = {
    id: `shared.${Date.now().toString(36)}`,
    name,
    tagline: `${portable.length} catalogs`,
    lineup: { catalogIds: builtIn.map(catalog => `${catalog.id}:${catalog.type}`) },
    catalogs: carried,
    settings: pickSharedSettings(config),
    requires: requiredKeysFromCatalogs(portable),
    source: { kind: 'imported', importedAt: new Date().toISOString() },
  };

  return {
    kind: TEMPLATE_KIND,
    version: TEMPLATE_VERSION,
    exportedAt: new Date().toISOString(),
    template,
  };
}

export function downloadTemplate(envelope: TemplateEnvelope): void {
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const slug = envelope.template.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  anchor.href = url;
  anchor.download = `aiometadata-setup-${slug || 'template'}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function parseTemplate(raw: unknown): ConfigTemplate {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const envelope = (typeof parsed === 'string' ? JSON.parse(parsed) : parsed) as Partial<TemplateEnvelope>;

  if (!envelope || envelope.kind !== TEMPLATE_KIND) {
    throw new Error('That file is not an AIOMetadata setup template.');
  }
  const template = envelope.template;
  if (!template?.id || !template.name || !template.lineup) {
    throw new Error('That template is missing the fields we need.');
  }
  return {
    ...template,
    source: { kind: 'imported', importedAt: new Date().toISOString(), url: undefined },
  };
}

/** Falls back to the addon proxy when the browser blocks the link on CORS. */
export async function fetchTemplate(url: string): Promise<ConfigTemplate> {
  const read = async (target: string) => {
    const response = await fetch(target);
    const body = await response.text();
    if (!response.ok) throw new Error(`The link returned ${response.status}`);
    return parseTemplate(body);
  };

  try {
    return await read(url);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return read(`/api/proxy-manifest?url=${encodeURIComponent(url)}`);
  }
}
