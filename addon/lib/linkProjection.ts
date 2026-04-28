function getConfiguredHost(): string | null {
  if (!process.env.HOST_NAME) return null;
  return process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;
}

function buildStremioManifestUrl(userUUID?: string | null): string | null {
  const host = getConfiguredHost();
  if (!host) return null;
  const manifestPath = userUUID ? `stremio/${userUUID}/manifest.json` : 'manifest.json';
  return `${host}/${manifestPath}`;
}

function rewriteDiscoverManifestUrl(url: string, userUUID?: string | null): string {
  const prefix = 'stremio:///discover/';
  if (typeof url !== 'string' || !url.startsWith(prefix)) return url;

  const rest = url.slice(prefix.length);
  const separatorIndex = rest.indexOf('/');
  if (separatorIndex === -1) return url;

  const manifestUrl = buildStremioManifestUrl(userUUID);
  if (!manifestUrl) return url;

  return `${prefix}${encodeURIComponent(manifestUrl)}${rest.slice(separatorIndex)}`;
}

interface Link {
  url?: string;
  [key: string]: any;
}

function rewriteLinkDiscoverManifestUrl(link: Link, userUUID?: string | null): Link {
  if (!link || typeof link !== 'object') return link;
  if (!Object.prototype.hasOwnProperty.call(link, 'url')) return { ...link };
  return {
    ...link,
    url: rewriteDiscoverManifestUrl(link.url!, userUUID),
  };
}

function canonicalizeLinksForCache(links: Link[]): Link[] {
  if (!Array.isArray(links)) return links;
  return links.map(link => rewriteLinkDiscoverManifestUrl(link, null));
}

function applyLinksUserScopeProjection(meta: any, config: { userUUID?: string | null }): any {
  if (!Array.isArray(meta?.links)) return meta;
  meta.links = meta.links.map((link: Link) => rewriteLinkDiscoverManifestUrl(link, config.userUUID));
  return meta;
}

module.exports = {
  buildStremioManifestUrl,
  rewriteDiscoverManifestUrl,
  canonicalizeLinksForCache,
  applyLinksUserScopeProjection,
};
