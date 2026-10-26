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
  openrouter: '',
  traktTokenId: '',
  simklTokenId: '',
  anilistTokenId: '',
  customDescriptionBlurb: '',
};

/**
 * The legacy `managers` map holds a manager account key in the clear, so it is dropped
 * whatever the export options say: a file people pass around must never carry one. The
 * destination survives, only the secret goes. An account's keyId is indirect, so it
 * follows the same rule as the other token ids and leaves only when keys are excluded.
 */
function withoutManagerSecrets(
  config: AppConfig,
  excludeApiKeys: boolean
): Pick<AppConfig, 'managers' | 'managerAccounts'> {
  const managers = Object.fromEntries(
    Object.entries(config.managers || {}).map(([id, saved]) => [id, { instanceUrl: saved?.instanceUrl }])
  );
  const managerAccounts = (config.managerAccounts || []).map(account =>
    excludeApiKeys ? { ...account, keyId: undefined } : account
  );
  return {
    ...(Object.keys(managers).length > 0 ? { managers } : {}),
    ...(managerAccounts.length > 0 ? { managerAccounts } : {}),
  };
}

export function exportConfigFile(
  config: AppConfig,
  { addonVersion, excludeApiKeys }: ExportConfigOptions
): ExportConfigResult {
  const configToExport: AppConfig = {
    ...config,
    apiKeys: excludeApiKeys ? emptyApiKeys : { ...config.apiKeys },
    ...withoutManagerSecrets(config, excludeApiKeys),
    // The link holds the parent's password, so like a manager key it never leaves in a file.
    parentConfig: undefined,
    ...(excludeApiKeys ? { jellyfinUserPin: undefined } : {}),
    ...(excludeApiKeys && config.jellyfinUsers
      ? { jellyfinUsers: config.jellyfinUsers.map(({ pin: _pin, ...user }) => (user.accounts ? { ...user, accounts: { ...user.accounts, apiKeys: {} } } : user)) }
      : {}),
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
