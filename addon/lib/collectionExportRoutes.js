const consola = require('consola');
const database = require('./database');
const { toNuvioCollections } = require('./collectionBuilder/nuvioExport');
const { toLayoutFile } = require('./collectionBuilder/layoutExport');
const { buildBlueprintLookup } = require('./collectionBuilder/blueprintLookup');
const { proxyCollectionImages } = require('./collectionBuilder/imageProxy');
const { getCollectionImagePrefix } = require('./posterCache/config');
const { isAliasFeatureEnabled, getAliasForUuid } = require('./aliasResolver');
const buildInfo = require('./buildInfo');

const logger = consola.withTag('CollectionExport');

/** Alias holders get their alias in the URL, matching how install URLs are built. */
function manifestIdentifier(userUUID) {
  if (!isAliasFeatureEnabled()) return userUUID;
  return getAliasForUuid(userUUID) || userUUID;
}

function resolveBaseUrl(req) {
  const hostEnv = process.env.HOST_NAME;
  if (hostEnv) {
    return hostEnv.startsWith('http') ? hostEnv : `https://${hostEnv}`;
  }
  return `${req.protocol}://${req.get('host')}`;
}

/** Nuvio records which addon a source came from by the manifest id plus a base URL. */
function buildIdentity(req, userUUID, config) {
  const baseUrl = resolveBaseUrl(req);
  const identifier = manifestIdentifier(userUUID);
  const addonBaseUrl = `${baseUrl}/stremio/${identifier}`;
  return {
    addonId: buildInfo.name,
    addonBaseUrl,
    addonName: (config.addonName || '').trim() || 'AIOMetadata',
  };
}

async function loadEntries(userUUID) {
  let config = await database.getUserConfig(userUUID);
  if (!config) return { error: 'notFound' };
  if (config.parentConfig) config = await require('./configApi').loadSharedConfig(userUUID);
  let entries = Array.isArray(config.collections) ? config.collections : [];
  const prefix = config.collectionImagesViaCache ? getCollectionImagePrefix() : '';
  if (prefix) entries = proxyCollectionImages(entries, prefix);
  return { config, entries };
}

function sendJson(res, payload) {
  // These are pasted into another app's importer, so they must never be cached
  // stale after the user edits their collections.
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).send(JSON.stringify(payload, null, 2));
}

function register(addon) {
  addon.get('/stremio/:userUUID/aiometadata-collections.json', async (req, res) => {
    const { userUUID } = req.params;
    try {
      const { config, entries, error } = await loadEntries(userUUID);
      if (error === 'notFound') {
        return res.status(404).json({ err: 'User configuration not found.' });
      }

      const output = toLayoutFile(entries, buildBlueprintLookup(config.catalogs));
      logger.debug(`Served ${output.entries.length} layout entries for ${userUUID.substring(0, 8)}`);
      sendJson(res, output);
    } catch (err) {
      logger.error(`Layout export failed for ${userUUID}:`, err.message);
      res.status(500).json({ err: 'Failed to build the layout.' });
    }
  });

  addon.get('/stremio/:userUUID/nuvio-collections.json', async (req, res) => {
    const { userUUID } = req.params;
    try {
      const { config, entries, error } = await loadEntries(userUUID);
      if (error === 'notFound') {
        return res.status(404).json({ err: 'User configuration not found.' });
      }

      const identity = buildIdentity(req, userUUID, config);
      const blueprints = buildBlueprintLookup(config.catalogs);
      const { output } = toNuvioCollections(entries, identity, blueprints);
      logger.debug(`Served ${output.length} Nuvio collections for ${userUUID.substring(0, 8)}`);
      sendJson(res, output);
    } catch (err) {
      logger.error(`Nuvio collection export failed for ${userUUID}:`, err.message);
      res.status(500).json({ err: 'Failed to build collections.' });
    }
  });
}

module.exports = { register, buildIdentity, manifestIdentifier };
