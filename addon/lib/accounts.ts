export type AccountService = 'simkl' | 'mdblist' | 'publicmetadb' | 'anilist' | 'mal';

export const ACCOUNT_SERVICES: Record<AccountService, { key: string; master: string }> = {
  simkl: { key: 'simklTokenId', master: 'simklWatchTracking' },
  mdblist: { key: 'mdblist', master: 'mdblistWatchTracking' },
  publicmetadb: { key: 'publicmetadb', master: 'publicmetadbWatchTracking' },
  anilist: { key: 'anilistTokenId', master: 'anilistWatchTracking' },
  mal: { key: 'malTokenId', master: 'malWatchTracking' },
};

export const ACCOUNT_SERVICE_LIST = Object.keys(ACCOUNT_SERVICES) as AccountService[];

/** Someone else, with at least one account of their own. */
export function isHolderCard(card: any): boolean {
  if (!card || card.trackers === true) return false;
  const keys = card.accounts?.apiKeys ?? {};
  return ACCOUNT_SERVICE_LIST.some((service) => Boolean(keys[ACCOUNT_SERVICES[service].key]));
}

export function holderCards(config: any): any[] {
  const cards = Array.isArray(config?.jellyfinUsers) ? config.jellyfinUsers : [];
  return cards.filter((card: any) => typeof card?.id === 'string' && card.id && isHolderCard(card));
}

export function withAccountOwner(config: any, owner: string | null | undefined): any {
  if (!owner) return config;
  const card = holderCards(config).find((c) => c.id === owner);
  if (!card) return config;
  return { ...config, jellyfinAccounts: card.accounts, jellyfinAccountOwner: card.id };
}

export function accountOwner(config: any): string {
  return config?.jellyfinAccounts && typeof config.jellyfinAccountOwner === 'string' ? config.jellyfinAccountOwner : '';
}

/** The config with the account fields of one service, or all five, taken from the holder. */
export function trackerConfig(config: any, only?: AccountService): any {
  const accounts = config?.jellyfinAccounts;
  if (!accounts) return config;
  const out: any = { ...config, apiKeys: { ...(config.apiKeys ?? {}) }, watchTracking: { ...(config.watchTracking ?? {}) } };
  for (const service of only ? [only] : ACCOUNT_SERVICE_LIST) {
    const { key, master } = ACCOUNT_SERVICES[service];
    out.apiKeys[key] = accounts.apiKeys?.[key] || undefined;
    out[master] = accounts[master];
    out.watchTracking[service] = accounts.watchTracking?.[service];
  }
  if (!only || only === 'simkl') out.simklUser = accounts.simklUser;
  return out;
}

export function credentialOf(config: any, service: AccountService): string | undefined {
  const keys = config?.jellyfinAccounts ? config.jellyfinAccounts.apiKeys : config?.apiKeys;
  return keys?.[ACCOUNT_SERVICES[service].key] || undefined;
}

/** The token id a tracker call uses; null for a Jellyfin user without that account, so nothing falls back to yours. */
export function ownTokenId(config: any, service: AccountService): string | null | undefined {
  const credential = credentialOf(config, service);
  return credential ?? (config?.jellyfinAccounts ? null : undefined);
}

const SLOTS: Array<[AccountService, RegExp]> = [
  ['mdblist', /^mdblist\.(watchlist(\.(movies|series))?|upnext|recommended\..+)$/],
  ['simkl', /^simkl\.(watchlist\..+|upnext(\.anime)?)$/],
  ['mal', /^mal\.(userlist\..+|suggestions)$/],
  ['anilist', /^anilist\.(?!trending$)[^.]+$/],
  ['publicmetadb', /^publicmetadb\.(upnext|watchlist)$/],
];

export function rowOwner(catalog: { metadata?: any } | null | undefined): string {
  const owner = catalog?.metadata?.accountOwner;
  return typeof owner === 'string' ? owner : '';
}

/** The service a catalog belongs to as "this account's own list"; null for public and named lists. */
export function slotServiceOf(catalog: { id?: string; metadata?: any } | null | undefined): AccountService | null {
  const id = String(catalog?.id ?? '').replace(/_(movie|series|anime|all)$/, '');
  if (id.startsWith('publicmetadb.pick.')) return rowOwner(catalog) ? 'publicmetadb' : null;
  if (id.startsWith('publicmetadb.list.') && catalog?.metadata?.listType === 'watchlist') return 'publicmetadb';
  if (id.startsWith('anilist.') && catalog?.metadata?.isCustomList) return null;
  for (const [service, pattern] of SLOTS) if (pattern.test(id)) return service;
  return null;
}

export function servesCatalog(config: any, catalog: any): boolean {
  const owner = rowOwner(catalog);
  if (owner) return config?.jellyfinAccountOwner === owner && Boolean(credentialOf(config, 'publicmetadb'));
  if (String(catalog?.id ?? '').startsWith('publicmetadb.pick.') && config?.jellyfinAccounts) return false;
  const service = slotServiceOf(catalog);
  if (!service) return true;
  const holder = Boolean(config?.jellyfinAccounts);
  if (!holder && catalog?.metadata?.accountsOnly !== true) return true;
  if (!credentialOf(config, service)) return false;
  if (holder && String(catalog?.id ?? '').startsWith('publicmetadb.list.')) return Boolean(config.jellyfinAccounts.publicmetadbWatchlist);
  return true;
}

/** Which accounts decide what servesCatalog shows, without any credential in it. */
export function servedAccountsKey(config: any): string {
  const held = ACCOUNT_SERVICE_LIST.filter((service) => credentialOf(config, service)).join(',');
  return config?.jellyfinAccounts?.publicmetadbWatchlist ? `${held}+pmdbwl` : held;
}

export function pmdbListIdFor(config: any, catalogId: string): string {
  const own = config?.jellyfinAccounts?.publicmetadbWatchlist;
  if (own && catalogId.startsWith('publicmetadb.list.')) {
    const entry = (config.catalogs ?? []).find((c: any) => c?.id === catalogId);
    if (slotServiceOf(entry ?? { id: catalogId }) === 'publicmetadb') return String(own);
  }
  return catalogId.replace('publicmetadb.list.', '');
}

/** A holder's own account on its slots; the installation's keys everywhere else, still carrying the holder for filters and merged sources. */
export function viewerConfigFor(config: any, owner: unknown, catalogId: string): any {
  const viewer = withAccountOwner(config, typeof owner === 'string' ? owner : '');
  if (!viewer.jellyfinAccounts) return config;
  const bare = String(catalogId).replace(/_(movie|series|anime|all)$/, '');
  const entry = (viewer.catalogs ?? []).find((c: any) => c?.id === bare) ?? { id: bare };
  const service = slotServiceOf(entry);
  return service ? trackerConfig(viewer, service) : viewer;
}

function cardOf(config: any, owner: string): any {
  return (Array.isArray(config?.jellyfinUsers) ? config.jellyfinUsers : []).find((c: any) => c?.id === owner);
}

export function setAccountKey(config: any, owner: string, service: AccountService, value: string): void {
  const { key } = ACCOUNT_SERVICES[service];
  if (!owner) {
    config.apiKeys = { ...(config.apiKeys ?? {}), [key]: value };
    return;
  }
  const card = cardOf(config, owner);
  if (!card) return;
  card.accounts = { ...(card.accounts ?? {}), apiKeys: { ...(card.accounts?.apiKeys ?? {}), [key]: value } };
}

export function detachCardAccount(config: any, owner: string, service: AccountService): { tokenId?: string; apiKeys: string[]; fields: string[] } | null {
  const card = cardOf(config, owner);
  if (!card?.accounts?.apiKeys?.[ACCOUNT_SERVICES[service].key]) return null;
  const { key, master } = ACCOUNT_SERVICES[service];
  const accounts = {
    ...card.accounts,
    apiKeys: { ...card.accounts.apiKeys },
    watchTracking: { ...(card.accounts.watchTracking ?? {}) },
    labels: { ...(card.accounts.labels ?? {}) },
  };
  const tokenId = accounts.apiKeys[key];
  delete accounts.apiKeys[key];
  delete accounts[master];
  delete accounts.watchTracking[service];
  delete accounts.labels[service];
  const fields = [master];
  if (service === 'simkl') { delete accounts.simklUser; fields.push('simklUser'); }
  if (service === 'publicmetadb') { delete accounts.publicmetadbWatchlist; fields.push('publicmetadbWatchlist'); }
  card.accounts = accounts;
  return { tokenId, apiKeys: [key], fields };
}
