import { AppConfig } from '@/contexts/config';

interface ExportConfigOptions {
  addonVersion: string;
  excludeApiKeys: boolean;
}

interface ExportConfigResult {
  apiKeysExcluded: boolean;
  enabledCatalogs: number;
  totalCatalogs: number;
}

const emptyApiKeys: AppConfig['apiKeys'] = {
  gemini: '',
  tmdb: '',
  tvdb: '',
  fanart: '',
  rpdb: '',
  topPoster: '',
  mdblist: '',
  traktTokenId: '',
  simklTokenId: '',
  anilistTokenId: '',
  customDescriptionBlurb: '',
};

export function exportConfigFile(
  config: AppConfig,
  { addonVersion, excludeApiKeys }: ExportConfigOptions
): ExportConfigResult {
  const configToExport: AppConfig = {
    ...config,
    apiKeys: excludeApiKeys ? emptyApiKeys : { ...config.apiKeys },
  };

  const totalCatalogs = config.catalogs?.length || 0;
  const enabledCatalogs = config.catalogs?.filter((catalog) => catalog.enabled).length || 0;

  const exportData = {
    version: addonVersion || 'unknown',
    exportedAt: new Date().toISOString(),
    config: configToExport,
    metadata: {
      apiKeysExcluded: excludeApiKeys,
      totalCatalogs,
      enabledCatalogs,
    },
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `aiometadata-config-${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);

  return {
    apiKeysExcluded: excludeApiKeys,
    totalCatalogs,
    enabledCatalogs,
  };
}
