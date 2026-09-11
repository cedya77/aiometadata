import express from 'express';
import consola from 'consola';
import { envInt } from '../../utils/envNumber';
import { randomUUID, timingSafeEqual } from 'crypto';
import {
  attachJellyfinContext,
  clientInfo,
  loadConfig,
  requireAuth,
  serverIdFor,
} from './context';
import { mintToken, readToken, revokeToken } from './tokens';
import {
  collectionFolder,
  EMPTY_USER_DATA,
  itemList,
  publicSystemInfo,
  sessionInfo,
  systemInfo,
  userDto,
  SERVER_NAME,
} from './dto';
import { buildViews, collectionTypeFor, findCatalogByViewId, getCatalogs, getSearchableCatalogs, isBrowsable } from './views';
import { decodeJellyfinId } from './ids';
import { buildEpisodes, buildSeasons, fetchMeta, fetchWindow, filterByIncludeTypes, includeTypesFilter, metaToBaseItem, recallImages } from './items';
import { encodeJellyfinId, normaliseJellyfinId, parseStremioId, stremioIdFor } from './ids';
import { coalesce, fetchStreams, mediaSourceFor, normaliseStreamBase, recallIssued, recallStreams, rememberStreams, toPlayable } from './streams';
import { resumeSnapshot, resumeUserData } from './resume';
import { applyWatchedState, isWatched, watchedSnapshot } from './watched';
import { registerStubs } from './stubs';
import { recordPlayed, recordPlaying, recordProgress, recordStopped, recordUnplayed } from './playstate';

const database: any = require('../database');

const logger = consola.withTag('Jellyfin');

function maxMediaSources(): number {
  return envInt('JELLYFIN_MAX_MEDIA_SOURCES', 50, 1);
}

function encodeSeriesId(descriptor: any): string {
  return encodeJellyfinId({ k: 'series', t: descriptor.t, i: descriptor.i });
}

function localAddress(req: any): string {
  const host = process.env.HOST_NAME || req.get('host') || '';
  return host.startsWith('http') ? host : `https://${host}`;
}

function baseFor(req: any): string {
  return `${localAddress(req)}/jellyfin/${req.params.userUUID}`;
}

function userNameFor(config: any, userUUID: string): string {
  return config?.jellyfinUserName || config?.addonName || userUUID.slice(0, 8);
}

export function createJellyfinRouter(options: { loginRateLimit?: any } = {}): any {
  const loginRateLimit = options.loginRateLimit || ((_req: any, _res: any, next: any) => next());
  const router = express.Router({ mergeParams: true, caseSensitive: false });

  router.use(express.json({ limit: '1mb', type: ['application/json', 'text/json', 'application/*+json'] }));
  router.use(express.urlencoded({ extended: false }));

  router.use((req: any, res: any, next: any) => {
    res.setHeader('Access-Control-Allow-Origin', req.get('origin') || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  router.use((req: any, _res: any, next: any) => {
    if (/^\/emby(\/|$)/i.test(req.url)) req.url = req.url.replace(/^\/emby/i, '') || '/';
    next();
  });

  router.use((req: any, _res: any, next: any) => {
    const query = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : '';
    logger.debug(`${req.method} ${req.path}${query}`);
    next();
  });

  router.use(attachJellyfinContext);

  // --- Handshake ---

  router.get('/System/Info/Public', (req: any, res: any) => {
    res.json(publicSystemInfo(serverIdFor(req.params.userUUID), baseFor(req)));
  });

  router.all('/System/Ping', (_req: any, res: any) => {
    res.json(SERVER_NAME);
  });

  router.get('/QuickConnect/Enabled', (_req: any, res: any) => {
    res.json(false);
  });

  router.get('/Branding/Configuration', (_req: any, res: any) => {
    res.json({ LoginDisclaimer: '', CustomCss: '', SplashscreenEnabled: false });
  });

  router.get('/Branding/Splashscreen', (_req: any, res: any) => {
    res.status(404).end();
  });

  // The web client asks for this while the sign-in page is still loading, so it
  // has to answer before there is a token to answer with.
  router.get(['/Branding/Css', '/Branding/Css.css'], (_req: any, res: any) => {
    res.type('text/css').send('');
  });

  router.get('/Users/Public', (_req: any, res: any) => {
    res.json([]);
  });

  // --- Authentication ---

  /** Compared in constant time so a wrong guess reveals nothing by how long it took. */
  const matchesAppPassword = (stored: string, supplied: string): boolean => {
    const a = Buffer.from(String(stored));
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  router.post('/Users/AuthenticateByName', loginRateLimit, async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const password = req.body?.Pw ?? req.body?.pw ?? req.body?.Password ?? '';

    let config = await database.verifyUserAndGetConfig(userUUID, String(password));

    // An account that signs in through a provider has no configuration password
    // to type, and a client's sign-in form cannot run that flow, so a password
    // issued for these clients is accepted here as well.
    if (!config) {
      const stored = await database.getUserConfig(userUUID).catch(() => null);
      if (stored?.jellyfinAppPassword && matchesAppPassword(stored.jellyfinAppPassword, String(password))) {
        config = stored;
      }
    }

    if (!config) {
      logger.debug(`Rejected Jellyfin login for ${userUUID}`);
      res.status(401).json({ Message: 'Invalid username or password' });
      return;
    }

    const serverId = serverIdFor(userUUID);
    const userId = serverId;
    const name = userNameFor(config, userUUID);
    const token = await mintToken(userUUID);

    res.json({
      User: userDto(userId, serverId, name),
      SessionInfo: sessionInfo(userId, serverId, name, clientInfo(req)),
      AccessToken: token,
      ServerId: serverId,
    });
  });

  router.post('/Sessions/Logout', async (req: any, res: any) => {
    await revokeToken(req.jellyfin?.token);
    res.status(204).end();
  });

  // --- Authenticated surface ---

  router.use(requireAuth);

  router.get('/System/Info', (req: any, res: any) => {
    res.json(systemInfo(serverIdFor(req.params.userUUID), baseFor(req)));
  });

  router.get('/System/Endpoint', (_req: any, res: any) => {
    res.json({ IsLocal: false, IsInNetwork: false });
  });

  router.get('/System/Configuration', (_req: any, res: any) => {
    res.json({ EnableMetrics: false, ServerName: SERVER_NAME });
  });

  const meHandler = async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const serverId = serverIdFor(userUUID);
    const config = await database.getUserConfig(userUUID);
    res.json(userDto(serverId, serverId, userNameFor(config, userUUID)));
  };
  router.get('/Users/Me', meHandler);
  router.get('/Users/:userId', meHandler);

  const viewsHandler = async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await loadConfig(req);
    if (!config) {
      res.json(itemList([], 0, 0));
      return;
    }
    const views = await buildViews(userUUID, serverIdFor(userUUID), config);
    res.json(itemList(views, views.length, 0));
  };
  router.get(['/Users/:userId/Views', '/UserViews'], viewsHandler);
  router.get('/Library/MediaFolders', viewsHandler);

  // Part of at least one client's startup, so a 404 here is fatal.
  router.get('/Library/VirtualFolders', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await loadConfig(req);
    if (!config) {
      res.json([]);
      return;
    }
    const views = await buildViews(userUUID, serverIdFor(userUUID), config);
    res.json(
      views.map((view: any) => ({
        Name: view.Name,
        Locations: [view.Path],
        CollectionType: view.CollectionType ?? null,
        LibraryOptions: {
          Enabled: true,
          EnableRealtimeMonitor: false,
          PathInfos: [],
        },
        ItemId: view.Id,
        PrimaryImageItemId: view.Id,
        RefreshStatus: 'Idle',
      }))
    );
  });

  // Both spellings: newer clients ask the /UserViews form, and a 404 is fatal.
  router.get(['/UserViews/GroupingOptions', '/Users/:userId/GroupingOptions'], async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await loadConfig(req);
    if (!config) {
      res.json([]);
      return;
    }
    const views = await buildViews(userUUID, serverIdFor(userUUID), config);
    res.json(views.map((v: any) => ({ Name: v.Name, Id: v.Id })));
  });

  const qInt = (req: any, name: string, fallback: number): number => {
    const raw = req.query[name] ?? req.query[name.charAt(0).toLowerCase() + name.slice(1)];
    const parsed = parseInt(String(raw), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  router.get(['/Items', '/Users/:userId/Items'], async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const startIndex = Math.max(0, qInt(req, 'StartIndex', 0));
    const limit = Math.min(Math.max(1, qInt(req, 'Limit', 100)), 500);
    const includeItemTypes = req.query.IncludeItemTypes ?? req.query.includeItemTypes;
    const parentId = req.query.ParentId ?? req.query.parentId;
    const filters = String(req.query.Filters ?? req.query.filters ?? '');

    if (filters.includes('IsFavorite')) {
      res.json(itemList([], 0, startIndex));
      return;
    }

    const config = await loadConfig(req);
    if (!config) {
      res.json(itemList([], 0, startIndex));
      return;
    }

    const serverId = serverIdFor(userUUID);
    const searchTerm = req.query.SearchTerm ?? req.query.searchTerm;

    // Clients send Genres pipe-delimited, or GenreIds holding our own guids.
    // A catalog's genre extra takes exactly one value, so only the first is
    // passed on rather than silently dropping the filter altogether.
    const genreNames: string[] = [];
    const rawGenres = req.query.Genres ?? req.query.genres ?? req.query.Genre ?? req.query.genre;
    if (typeof rawGenres === 'string' && rawGenres) {
      genreNames.push(...rawGenres.split('|').filter(Boolean));
    }

    const rawGenreIds = req.query.GenreIds ?? req.query.genreIds;
    if (!genreNames.length && typeof rawGenreIds === 'string' && rawGenreIds) {
      for (const id of rawGenreIds.split('|').filter(Boolean)) {
        const decoded = await decodeJellyfinId(id);
        if (decoded && decoded.k === 'genre') genreNames.push(decoded.g);
      }
    }

    // A client builds one row per kind by ruling out the kinds another row owns.
    // Where that leaves nothing this server publishes, the row wants to be empty
    // rather than filled with the same titles under a heading they do not belong
    // to. Only movies and episodes are video; a series is a folder.
    const queryList = (...values: any[]): Set<string> =>
      new Set(
        values
          .flat()
          .filter(Boolean)
          .flatMap((value: any) => String(value).split(','))
          .map((value: string) => value.trim())
          .filter(Boolean)
      );

    const excluded = queryList(req.query.ExcludeItemTypes ?? req.query.excludeItemTypes);
    const wantedMedia = queryList(req.query.MediaTypes ?? req.query.mediaTypes);

    if (excluded.size || wantedMedia.size) {
      const survives = (['Movie', 'Series', 'Episode'] as const).some((kind) => {
        if (excluded.has(kind)) return false;
        if (!wantedMedia.size) return true;
        return wantedMedia.has(kind === 'Series' ? 'Unknown' : 'Video');
      });

      if (!survives) {
        res.json(itemList([], 0, startIndex));
        return;
      }
    }

    const extras: Record<string, string> = {};
    if (genreNames.length) extras.genre = genreNames[0];
    if (searchTerm) extras.search = String(searchTerm);

    if (genreNames.length > 1) {
      logger.debug(`Only the first of ${genreNames.length} genres is filterable: ${genreNames[0]}`);
    }

    if (!parentId) {
      // Clients build search rows here, one call per section: /Search/Hints is
      // a single flat list with no way to express them.
      if (searchTerm) {
        const found = await searchAcross(
          userUUID,
          config,
          serverId,
          String(searchTerm),
          startIndex + limit,
          includeItemTypes
        );
        const page = found.slice(startIndex, startIndex + limit);
        res.json(itemList(page, found.length, startIndex));
        return;
      }

      const recursive = String(req.query.Recursive ?? req.query.recursive ?? '')
        .toLowerCase() === 'true';

      if (!recursive) {
        const views = await buildViews(userUUID, serverId, config);
        res.json(itemList(views.slice(startIndex, startIndex + limit), views.length, startIndex));
        return;
      }

      // Nothing here carries an added-date, so a cross-library row is the
      // catalogs of that type walked in order, with one running offset across
      // all of them so paging does not restart at every catalog boundary.
      const wanted = includeItemTypes
        ? new Set(String(includeItemTypes).split(',').map((t) => t.trim()).filter(Boolean))
        : null;

      const pool = (await getCatalogs(userUUID, config)).filter(isBrowsable).filter((catalog: any) => {
        if (!wanted || !wanted.size) return true;
        const kind = collectionTypeFor(catalog.type);
        if (kind === 'movies') return wanted.has('Movie');
        if (kind === 'tvshows') return wanted.has('Series');
        return true;
      });

      const collected: any[] = [];
      let offset = 0;
      let more = false;

      for (const catalog of pool) {
        if (collected.length >= limit) break;

        const page = await fetchWindow(
          userUUID,
          catalog,
          Math.max(0, startIndex - offset),
          limit - collected.length + Math.max(0, offset - startIndex),
          extras,
          includeTypesFilter(catalog.type, includeItemTypes ? String(includeItemTypes) : undefined)
        ).catch(() => ({ items: [] as any[], hasMore: false }));

        const viewId = encodeJellyfinId({ k: 'view', t: catalog.type, c: catalog.id });
        for (const meta of page.items) {
          if (!meta?.id) continue;
          if (offset >= startIndex && collected.length < limit) {
            collected.push(metaToBaseItem(meta, catalog.type, serverId, viewId));
          }
          offset += 1;
        }

        if (page.hasMore) {
          offset += 1;
          more = true;
        }
        if (page.hasMore && collected.length >= limit) break;
      }

      const across = filterByIncludeTypes(
        collected,
        includeItemTypes ? String(includeItemTypes) : undefined
      );
      await applyWatchedState(across, await watchedSnapshot(userUUID, config), userUUID);

      res.json(itemList(
        across,
        more && across.length >= limit ? startIndex + across.length + limit : startIndex + across.length,
        startIndex
      ));
      return;
    }

    let catalog: any;
    {
      const descriptor = await decodeJellyfinId(String(parentId));

      if (descriptor && (descriptor.k === 'series' || descriptor.k === 'season')) {
        const meta = await fetchMeta(userUUID, 'series', descriptor.i);
        if (!meta) {
          res.json(itemList([], 0, startIndex));
          return;
        }
        const children = descriptor.k === 'season'
          ? buildEpisodes(meta, descriptor.t, encodeSeriesId(descriptor), serverId, descriptor.s)
          : buildSeasons(meta, descriptor.t, String(parentId), serverId);
        await applyWatchedState(children, await watchedSnapshot(userUUID, config), userUUID);
        const page = children.slice(startIndex, startIndex + limit);
        res.json(itemList(page, children.length, startIndex));
        return;
      }

      if (!descriptor || descriptor.k !== 'view') {
        res.json(itemList([], 0, startIndex));
        return;
      }
      const found = await findCatalogByViewId(userUUID, config, descriptor.t, descriptor.c);
      if (!found) {
        res.json(itemList([], 0, startIndex));
        return;
      }
      catalog = found;
    }

    const window = await fetchWindow(
      userUUID,
      catalog,
      startIndex,
      limit,
      extras,
      includeTypesFilter(catalog.type, includeItemTypes ? String(includeItemTypes) : undefined)
    );
    const hasMore = window.hasMore;

    const items = window.items
      .filter((meta: any) => meta && meta.id)
      .map((meta: any) => metaToBaseItem(meta, catalog.type, serverId, String(parentId)));

    const filtered = filterByIncludeTypes(items, includeItemTypes ? String(includeItemTypes) : undefined)
      .slice(0, limit);

    // Catalogs report no total, so one page of lookahead keeps the client asking
    // and collapses to the truth once a window comes back short. This only holds
    // because fetchWindow always fills a window, making short mean finished.
    const total = hasMore && filtered.length > 0
      ? startIndex + filtered.length + limit
      : startIndex + filtered.length;

    await applyWatchedState(filtered, await watchedSnapshot(userUUID, config), userUUID);
    res.json(itemList(filtered, total, startIndex));
  });

  const resolveMediaSources = async (
    req: any,
    descriptor: any,
    runtimeTicks: number | null
  ): Promise<any[]> => {
    if (!descriptor || (descriptor.k !== 'movie' && descriptor.k !== 'episode')) return [];

    const config = await loadConfig(req);
    const base = normaliseStreamBase(config?.jellyfinStreamUrl || '');
    if (!base) {
      logger.debug(`No stream addon configured for ${req.params.userUUID}`);
      return [];
    }

    const stremioId = stremioIdFor(descriptor);
    if (!stremioId) return [];

    const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
    const cacheKey = `${req.params.userUUID}:${stremioType}:${stremioId}`;

    const streams =
      recallStreams(cacheKey) ??
      (await coalesce(cacheKey, async () => {
        const fetched = await fetchStreams(base, stremioType, stremioId);
        if (fetched.length) rememberStreams(cacheKey, fetched);
        return fetched;
      }));

    const seen = new Set<string>();
    const sources: any[] = [];
    for (const stream of streams) {
      const playable = toPlayable(stream);
      if (!playable || seen.has(playable.id)) continue;
      seen.add(playable.id);
      sources.push(mediaSourceFor(playable, runtimeTicks));
    }

    logger.debug(`Streams ${stremioType}/${stremioId}: ${streams.length} offered, ${sources.length} playable`);
    return sources.slice(0, maxMediaSources());
  };

  /**
   * Real sources replace the placeholder, and the item mirrors the default
   * source's tracks and container: a client reads those off the item, not only
   * off the source.
   */
  const attachSources = async (
    req: any,
    item: any,
    descriptor: any,
    itemId: string
  ): Promise<void> => {
    const resolved = withDefaultSourceId(
      await resolveMediaSources(req, descriptor, item.RunTimeTicks ?? null),
      itemId
    );
    if (!resolved.length) return;

    item.MediaSources = resolved;
    item.MediaStreams = resolved[0].MediaStreams;
    item.Container = resolved[0].Container;
    if (resolved.length > 1) item.MediaSourceCount = resolved.length;
  };

  /**
   * A client picks the source whose Id matches the item's own, so the default
   * one has to carry the item guid rather than its own hash or nothing is
   * selectable.
   */
  const withDefaultSourceId = (sources: any[], itemId: string): any[] => {
    if (!sources.length) return sources;
    const id = normaliseJellyfinId(itemId);
    return sources.map((source, index) =>
      index === 0 ? { ...source, Id: id, ETag: id } : source
    );
  };

  const playbackHandler = async (req: any, res: any) => {
    const itemId = String(req.params.itemId);
    const descriptor = await decodeJellyfinId(itemId);

    if (!descriptor || (descriptor.k !== 'movie' && descriptor.k !== 'episode')) {
      res.status(404).json({ MediaSources: [], PlaySessionId: '', ErrorCode: 'NotAllowed' });
      return;
    }

    const requested = req.query.MediaSourceId ?? req.body?.MediaSourceId;
    const all = await resolveMediaSources(req, descriptor, null);
    const withIds = withDefaultSourceId(all, itemId);

    let sources = withIds;
    if (typeof requested === 'string' && requested && normaliseJellyfinId(requested) !== normaliseJellyfinId(itemId)) {
      const picked = withIds.filter((s: any) => s.Id === requested);
      if (picked.length) sources = picked;
    }

    if (!sources.length) {
      res.json({ MediaSources: [], PlaySessionId: randomUUID(), ErrorCode: 'NoCompatibleStream' });
      return;
    }

    res.json({ MediaSources: sources, PlaySessionId: randomUUID() });
  };

  // Some clients never fetch the URL a MediaSource carries: they ask the server
  // for the video and expect to be sent on.
  const videoStreamHandler = async (req: any, res: any) => {
    const itemId = String(req.params.itemId);
    const descriptor = await decodeJellyfinId(itemId);
    if (!descriptor || (descriptor.k !== 'movie' && descriptor.k !== 'episode')) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }

    const requested = req.query.MediaSourceId ?? req.query.mediaSourceId;
    const wantedId = typeof requested === 'string' && requested ? normaliseJellyfinId(requested) : null;

    // A source the client already holds is sent to the URL it was issued with.
    // The stream addon's URL stands on its own, so nothing is resolved again: a
    // fresh search can come back without the file, and did, mid-playback.
    if (wantedId && wantedId !== normaliseJellyfinId(itemId)) {
      const pinned = await recallIssued(wantedId);
      if (pinned) {
        res.redirect(302, pinned);
        return;
      }
    }

    // No pin for it, so it is resolved: a client that never called PlaybackInfo
    // or has outlived the pin gets the source matched from a fresh list.
    const sources = withDefaultSourceId(await resolveMediaSources(req, descriptor, null), itemId);
    if (!sources.length) {
      res.status(404).json({ Message: 'No playable stream' });
      return;
    }

    const wanted = wantedId
      ? sources.find((s: any) => normaliseJellyfinId(s.Id) === wantedId)
      : undefined;

    if (wantedId && !wanted) {
      logger.debug(`Source ${requested} is no longer offered for ${itemId}`);
      res.status(404).json({ Message: 'Media source not found' });
      return;
    }

    const chosen = wanted ?? sources[0];
    if (!chosen?.Path) {
      res.status(404).json({ Message: 'No playable stream' });
      return;
    }

    logger.debug(`Redirecting ${itemId} to its source`);
    res.redirect(302, chosen.Path);
  };

  router.get(
    [
      '/Videos/:itemId/stream',
      '/Videos/:itemId/stream.:ext',
      '/Videos/:itemId/stream/:filename',
      '/Videos/:itemId/original',
      '/Videos/:itemId/original.:ext',
    ],
    videoStreamHandler
  );

  router.get('/Items/:itemId/PlaybackInfo', playbackHandler);
  router.post('/Items/:itemId/PlaybackInfo', playbackHandler);
  router.get('/Items/:itemId/MediaSources', async (req: any, res: any) => {
    const captured: any[] = [];
    await playbackHandler(req, {
      json: (body: any) => captured.push(body),
      status: () => ({ end: () => undefined, json: () => undefined }),
    });
    res.json(captured[0]?.MediaSources ?? []);
  });

  const genreOptionsFor = async (req: any, parentId: any): Promise<{ catalog: any; genres: string[] }> => {
    const config = await loadConfig(req);
    if (!config || !parentId) return { catalog: null, genres: [] };

    const descriptor = await decodeJellyfinId(String(parentId));
    if (!descriptor || descriptor.k !== 'view') return { catalog: null, genres: [] };

    const catalog = await findCatalogByViewId(req.params.userUUID, config, descriptor.t, descriptor.c);
    if (!catalog) return { catalog: null, genres: [] };

    const extra = (catalog.extra ?? []).find((e: any) => e?.name === 'genre');
    const options = Array.isArray(extra?.options) ? extra.options : [];
    return {
      catalog,
      genres: options.filter((g: any) => typeof g === 'string' && g && g !== 'None'),
    };
  };

  // Each catalog returns its own ranked list, so results are interleaved rather
  // than concatenated: one catalog's weak matches would bury another's best.
  const searchAcross = async (
    userUUID: string,
    config: any,
    serverId: string,
    term: string,
    limit: number,
    includeItemTypes: any
  ): Promise<any[]> => {
    // Only catalogs whose type could answer: asking a movie-only catalog for
    // Series spends a request on a result that would be filtered away.
    const wanted = includeItemTypes
      ? new Set(String(includeItemTypes).split(',').map((t) => t.trim()).filter(Boolean))
      : null;
    const catalogs = getSearchableCatalogs(await getCatalogs(userUUID, config)).filter(
      (catalog: any) => {
        if (!wanted || !wanted.size) return true;
        const kind = collectionTypeFor(catalog.type);
        if (kind === 'movies') return wanted.has('Movie');
        if (kind === 'tvshows') return wanted.has('Series');
        return true;
      }
    );

    const pages = await Promise.all(
      catalogs.map((catalog: any) =>
        fetchWindow(userUUID, catalog, 0, limit, { search: term })
          .then((window) => ({ catalog, items: window.items }))
          .catch(() => ({ catalog, items: [] as any[] }))
      )
    );

    const seen = new Set<string>();
    const items: any[] = [];
    const depth = Math.max(0, ...pages.map((p) => p.items.length));
    for (let rank = 0; rank < depth; rank++) {
      for (const page of pages) {
        const meta = page.items[rank];
        if (!meta?.id) continue;
        // The same title reaches us from more than one catalog under different
        // ids, so identity alone cannot spot the repeat. Only the leading year
        // is compared: one catalog says '2023-' where another says '2023-2024'.
        const year = String(meta.year ?? meta.releaseInfo ?? '').slice(0, 4);
        const title = `${String(meta.name || '').toLowerCase()}|${year}`;
        if (seen.has(String(meta.id)) || (meta.name && seen.has(title))) continue;
        seen.add(String(meta.id));
        if (meta.name) seen.add(title);
        items.push(metaToBaseItem(meta, page.catalog.type, serverId, null));
      }
    }

    return filterByIncludeTypes(items, includeItemTypes ? String(includeItemTypes) : undefined);
  };

  router.get('/Search/Hints', async (req: any, res: any) => {
    const term = String(req.query.SearchTerm ?? req.query.searchTerm ?? '').trim();
    const limit = Math.min(Math.max(1, qInt(req, 'Limit', 20)), 50);
    const includeItemTypes = req.query.IncludeItemTypes ?? req.query.includeItemTypes;

    if (!term) {
      res.json({ SearchHints: [], TotalRecordCount: 0 });
      return;
    }

    const config = await loadConfig(req);
    if (!config) {
      res.json({ SearchHints: [], TotalRecordCount: 0 });
      return;
    }

    const userUUID = req.params.userUUID;
    const serverId = serverIdFor(userUUID);
    const items = await searchAcross(userUUID, config, serverId, term, limit, includeItemTypes);

    const filtered = items.slice(0, limit);

    res.json({
      SearchHints: filtered.map((item: any) => ({
        ItemId: item.Id,
        Id: item.Id,
        Name: item.Name,
        Type: item.Type,
        MediaType: item.MediaType ?? 'Video',
        ProductionYear: item.ProductionYear,
        PrimaryImageTag: item.ImageTags?.Primary,
        BackdropImageTag: item.BackdropImageTags?.[0],
        BackdropImageItemId: item.Id,
        PrimaryImageAspectRatio: item.PrimaryImageAspectRatio,
        RunTimeTicks: item.RunTimeTicks,
      })),
      TotalRecordCount: filtered.length,
    });
  });

  router.get('/Genres', async (req: any, res: any) => {
    const parentId = req.query.ParentId ?? req.query.parentId;
    const { catalog, genres } = await genreOptionsFor(req, parentId);
    if (!catalog) {
      res.json(itemList([], 0, 0));
      return;
    }

    const serverId = serverIdFor(req.params.userUUID);
    const items = genres.map((genre: string) => ({
      Name: genre,
      Id: encodeJellyfinId({ k: 'genre', t: catalog.type, c: catalog.id, g: genre }),
      ServerId: serverId,
      Type: 'Genre',
      IsFolder: false,
      ImageTags: {},
      BackdropImageTags: [],
      ImageBlurHashes: {},
    }));
    res.json(itemList(items, items.length, 0));
  });

  /**
   * A genre is looked up by name across every browsable catalog, since the
   * client asking has only the name. An unmatched name still answers with a
   * genre rather than a 404, so a stale link renders instead of erroring.
   */
  router.get('/Genres/:name', async (req: any, res: any) => {
    const name = decodeURIComponent(String(req.params.name));
    const serverId = serverIdFor(req.params.userUUID);
    const config = await loadConfig(req);

    let match: { catalog: any; genre: string } | null = null;
    if (config) {
      const catalogs = (await getCatalogs(req.params.userUUID, config)).filter(isBrowsable);
      for (const catalog of catalogs) {
        const extra = (catalog.extra ?? []).find((e: any) => e?.name === 'genre');
        const options: any[] = Array.isArray(extra?.options) ? extra.options : [];
        const found = options.find(
          (g: any) => typeof g === 'string' && g.toLowerCase() === name.toLowerCase()
        );
        if (found) {
          match = { catalog, genre: found };
          break;
        }
      }
    }

    res.json({
      Name: match ? match.genre : name,
      Id: encodeJellyfinId({
        k: 'genre',
        t: match ? match.catalog.type : 'movie',
        c: match ? match.catalog.id : '',
        g: match ? match.genre : name,
      }),
      ServerId: serverId,
      Type: 'Genre',
      IsFolder: false,
      ImageTags: {},
      BackdropImageTags: [],
      ImageBlurHashes: {},
    });
  });

  router.get(['/Items/Filters', '/Items/Filters2'], async (req: any, res: any) => {
    const parentId = req.query.ParentId ?? req.query.parentId;
    const { catalog, genres } = await genreOptionsFor(req, parentId);
    const serverId = serverIdFor(req.params.userUUID);

    res.json({
      Genres: genres,
      Tags: [],
      OfficialRatings: [],
      Years: [],
      GenreItems: catalog
        ? genres.map((genre: string) => ({
            Name: genre,
            Id: encodeJellyfinId({ k: 'genre', t: catalog.type, c: catalog.id, g: genre }),
            ServerId: serverId,
          }))
        : [],
    });
  });

  /**
   * Images are remembered as items are built, which a client outlives: it holds
   * ids across a restart and asks for their art before anything has rebuilt
   * them. Resolving from the id keeps posters working instead of every one
   * turning into a 404 until the list happens to be walked again.
   */
  const imagesFor = async (req: any, itemId: string): Promise<any | undefined> => {
    const userUUID = req.params.userUUID;
    const scope = serverIdFor(userUUID);

    const known = await recallImages(scope, itemId);
    if (known) return known;

    const descriptor = await decodeJellyfinId(itemId);
    if (!descriptor) return undefined;
    if (descriptor.k === 'movie' || descriptor.k === 'series' || descriptor.k === 'season') {
      const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
      const meta = await fetchMeta(userUUID, stremioType, descriptor.i);
      if (!meta) return undefined;
      metaToBaseItem(meta, descriptor.t, scope, null);
      return (await recallImages(scope, itemId)) ?? {
        primary: meta.poster || undefined,
        backdrop: meta.background || undefined,
        logo: meta.logo || undefined,
        thumb: meta.landscapePoster || undefined,
      };
    }

    if (descriptor.k === 'episode') {
      const meta = await fetchMeta(userUUID, 'series', descriptor.i);
      if (!meta) return undefined;
      const seriesId = encodeSeriesId(descriptor);
      buildEpisodes(meta, descriptor.t, seriesId, scope, null);
      return (await recallImages(scope, itemId)) ?? { primary: meta.poster || undefined };
    }

    return undefined;
  };

  // Walked for a breadcrumb when a client opens an item. A season names its
  // series, an episode both, and anything else has no parent worth naming.
  router.get('/Items/:itemId/Ancestors', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const descriptor = await decodeJellyfinId(String(req.params.itemId));
    if (!descriptor || (descriptor.k !== 'episode' && descriptor.k !== 'season')) {
      res.json([]);
      return;
    }

    const meta = await fetchMeta(userUUID, 'series', descriptor.i);
    if (!meta) {
      res.json([]);
      return;
    }

    const serverId = serverIdFor(userUUID);
    const series = metaToBaseItem(meta, descriptor.t, serverId, null);
    const chain: any[] = [];

    if (descriptor.k === 'episode' && descriptor.s !== null && descriptor.s !== undefined) {
      const season = buildSeasons(meta, descriptor.t, series.Id, serverId)
        .find((entry: any) => entry.IndexNumber === descriptor.s);
      if (season) chain.push(season);
    }

    chain.push(series);
    res.json(chain);
  });

  router.get('/Items/:itemId/Images/:imageType', async (req: any, res: any) => {
    const images = await imagesFor(req, String(req.params.itemId));
    if (!images) {
      res.status(404).end();
      return;
    }
    const kind = String(req.params.imageType).toLowerCase();
    const url =
      kind === 'primary' ? images.primary
      : kind === 'backdrop' ? images.backdrop
      : kind === 'logo' ? images.logo
      : kind === 'thumb' ? images.thumb
      : undefined;

    if (!url) {
      res.status(404).end();
      return;
    }
    res.redirect(302, url);
  });

  // A bare array, not a list. Some clients build their whole view from this and
  // never call /Items, so an empty answer reads as a server with no content.
  router.get(['/Items/Latest', '/Users/:userId/Items/Latest'], async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const parentId = req.query.ParentId ?? req.query.parentId;
    const limit = Math.min(Math.max(1, qInt(req, 'Limit', 20)), 100);
    const includeItemTypes = req.query.IncludeItemTypes ?? req.query.includeItemTypes;

    if (!parentId) {
      res.json([]);
      return;
    }

    const config = await loadConfig(req);
    if (!config) {
      res.json([]);
      return;
    }

    const descriptor = await decodeJellyfinId(String(parentId));
    if (!descriptor || descriptor.k !== 'view') {
      res.json([]);
      return;
    }

    const catalog = await findCatalogByViewId(userUUID, config, descriptor.t, descriptor.c);
    if (!catalog) {
      res.json([]);
      return;
    }

    const serverId = serverIdFor(userUUID);
    const window = await fetchWindow(userUUID, catalog, 0, limit);
    const items = window.items
      .filter((meta: any) => meta && meta.id)
      .map((meta: any) => metaToBaseItem(meta, catalog.type, serverId, String(parentId)));

    res.json(
      filterByIncludeTypes(items, includeItemTypes ? String(includeItemTypes) : undefined).slice(0, limit)
    );
  });

  router.get(['/UserItems/Resume', '/Users/:userId/Items/Resume'], async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await loadConfig(req);
    if (!config) {
      res.json(itemList([], 0, 0));
      return;
    }

    const startIndex = Math.max(0, qInt(req, 'StartIndex', 0));
    const limit = Math.min(Math.max(1, qInt(req, 'Limit', 20)), 100);
    const rows = await resumeSnapshot(userUUID, config);
    if (!rows.length) {
      res.json(itemList([], 0, startIndex));
      return;
    }

    const serverId = serverIdFor(userUUID);
    const window = rows.slice(startIndex, startIndex + limit);
    const watched = await watchedSnapshot(userUUID, config);

    // One meta per title, not per row: a show with several part-watched
    // episodes is the normal shape of this list.
    const metas = new Map<string, any>();
    await Promise.all(
      [...new Set(window.map((row) => row.metaId))].map(async (metaId) => {
        const row = window.find((r) => r.metaId === metaId)!;
        const meta = await fetchMeta(userUUID, row.kind === 'movie' ? 'movie' : 'series', metaId);
        if (meta) metas.set(metaId, meta);
      })
    );

    const items: any[] = [];
    for (const row of window) {
      const meta = metas.get(row.metaId);
      if (!meta) continue;

      if (row.kind === 'movie') {
        const item = metaToBaseItem(meta, row.mediaType, serverId, null);
        item.UserData = resumeUserData(item.Id, row, item.RunTimeTicks ?? null, isWatched(watched, row.videoId));
        items.push(item);
        continue;
      }

      const parsed = parseStremioId(row.videoId);
      if (!parsed) continue;

      const seriesId = encodeJellyfinId({ k: 'series', t: row.mediaType, i: String(meta.id) });
      const wantedId = encodeJellyfinId({
        k: 'episode',
        t: row.mediaType,
        i: parsed.base,
        s: parsed.season,
        e: parsed.episode as number,
      });

      const episodes = buildEpisodes(meta, row.mediaType, seriesId, serverId, null);
      const target = episodes.find((episode: any) => episode.Id === wantedId);

      if (!target) {
        logger.debug(`Resume row ${row.videoId} is not in its meta`);
        continue;
      }

      target.UserData = resumeUserData(target.Id, row, target.RunTimeTicks ?? null, isWatched(watched, row.videoId));
      items.push(target);
    }

    res.json(itemList(items, rows.length, startIndex));
  });

  const seriesMetaFor = async (req: any) => {
    const descriptor = await decodeJellyfinId(String(req.params.seriesId));
    if (!descriptor || descriptor.k !== 'series') return null;
    const meta = await fetchMeta(req.params.userUUID, 'series', descriptor.i);
    return meta ? { descriptor, meta } : null;
  };

  router.get('/Shows/:seriesId/Seasons', async (req: any, res: any) => {
    const found = await seriesMetaFor(req);
    if (!found) {
      res.json(itemList([], 0, 0));
      return;
    }
    const seasons = buildSeasons(found.meta, found.descriptor.t, String(req.params.seriesId), serverIdFor(req.params.userUUID));
    res.json(itemList(seasons, seasons.length, 0));
  });

  router.get('/Shows/:seriesId/Episodes', async (req: any, res: any) => {
    const found = await seriesMetaFor(req);
    if (!found) {
      res.json(itemList([], 0, 0));
      return;
    }
    const raw = req.query.Season ?? req.query.season;
    let season: number | null = null;
    if (raw !== undefined) {
      const parsed = parseInt(String(raw), 10);
      if (Number.isFinite(parsed)) season = parsed;
    } else {
      const seasonId = req.query.SeasonId ?? req.query.seasonId;
      if (seasonId) {
        const seasonDescriptor = await decodeJellyfinId(String(seasonId));
        if (seasonDescriptor && seasonDescriptor.k === 'season') season = seasonDescriptor.s;
      }
    }

    const episodes = buildEpisodes(
      found.meta,
      found.descriptor.t,
      String(req.params.seriesId),
      serverIdFor(req.params.userUUID),
      season
    );
    const episodesConfig = await loadConfig(req);
    if (episodesConfig) {
      await applyWatchedState(episodes, await watchedSnapshot(req.params.userUUID, episodesConfig), req.params.userUUID);
    }
    res.json(itemList(episodes, episodes.length, 0));
  });

  router.get('/Shows/NextUp', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const config = await loadConfig(req);
    const startIndex = Math.max(0, qInt(req, 'StartIndex', 0));
    const limit = Math.min(Math.max(1, qInt(req, 'Limit', 20)), 100);

    if (!config) {
      res.json(itemList([], 0, startIndex));
      return;
    }

    const snapshot = await watchedSnapshot(userUUID, config);
    const rows = snapshot.nextUp;
    if (!rows.length) {
      res.json(itemList([], 0, startIndex));
      return;
    }

    const serverId = serverIdFor(userUUID);
    const window = rows.slice(startIndex, startIndex + limit);

    const items: any[] = [];
    await Promise.all(
      window.map(async (row, index) => {
        const meta = await fetchMeta(userUUID, 'series', row.metaId);
        if (!meta) return;

        const seriesId = encodeJellyfinId({ k: 'series', t: row.mediaType, i: String(meta.id) });
        const episodes = buildEpisodes(meta, row.mediaType, seriesId, serverId, null);

        // Matched on the video id where the tracker gave one, and on the
        // numbering otherwise, because a season is not always in the same
        // space as the id the meta publishes.
        const target = row.videoId
          ? episodes.find((episode: any) => {
              const parsed = parseStremioId(row.videoId as string);
              if (!parsed) return false;
              return episode.Id === encodeJellyfinId({
                k: 'episode',
                t: row.mediaType,
                i: parsed.base,
                s: parsed.season,
                e: parsed.episode as number,
              });
            })
          : episodes.find(
              (episode: any) =>
                episode.IndexNumber === row.episode &&
                (row.season === null || episode.ParentIndexNumber === row.season)
            );

        if (target) items[index] = target;
      })
    );

    const found = items.filter(Boolean);
    await applyWatchedState(found, snapshot, userUUID);
    res.json(itemList(found, rows.length, startIndex));
  });

  router.get('/Items/Counts', (_req: any, res: any) => {
    res.json({
      MovieCount: 0,
      SeriesCount: 0,
      EpisodeCount: 0,
      ArtistCount: 0,
      ProgramCount: 0,
      TrailerCount: 0,
      SongCount: 0,
      AlbumCount: 0,
      MusicVideoCount: 0,
      BoxSetCount: 0,
      BookCount: 0,
      ItemCount: 0,
    });
  });

  router.get(['/Items/:itemId', '/Users/:userId/Items/:itemId'], async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const descriptor = await decodeJellyfinId(req.params.itemId);
    if (!descriptor) {
      res.status(404).json({ Message: 'Item not found' });
      return;
    }

    if (descriptor.k === 'episode') {
      const meta = await fetchMeta(userUUID, 'series', descriptor.i);
      if (!meta) {
        res.status(404).json({ Message: 'Item not found' });
        return;
      }
      const seriesId = encodeSeriesId(descriptor);
      // Numbering can differ between the series meta and the one an episode's
      // own id resolves to, so the guid is matched rather than the index.
      const episodes = buildEpisodes(meta, descriptor.t, seriesId, serverIdFor(userUUID), null);
      const wanted = normaliseJellyfinId(String(req.params.itemId));
      const episode =
        episodes.find((e: any) => e.Id === wanted) ??
        episodes.find((e: any) => e.IndexNumber === descriptor.e && e.ParentIndexNumber === descriptor.s);
      if (!episode) {
        res.status(404).json({ Message: 'Item not found' });
        return;
      }

      const fields = String(req.query.Fields ?? req.query.fields ?? '');
      if (fields.includes('MediaSources')) {
        await attachSources(req, episode, descriptor, String(req.params.itemId));
      }

      const episodeConfig = await loadConfig(req);
      if (episodeConfig) {
        await applyWatchedState([episode], await watchedSnapshot(userUUID, episodeConfig), userUUID);
      }

      res.json(episode);
      return;
    }

    // A season is an item a client opens directly, and answering 404 leaves it
    // waiting on a page it will never get.
    if (descriptor.k === 'season') {
      const meta = await fetchMeta(userUUID, 'series', descriptor.i);
      if (!meta) {
        res.status(404).json({ Message: 'Item not found' });
        return;
      }

      const serverId = serverIdFor(userUUID);
      const seriesId = encodeSeriesId(descriptor);
      const season = buildSeasons(meta, descriptor.t, seriesId, serverId)
        .find((entry: any) => entry.IndexNumber === descriptor.s);

      if (!season) {
        res.status(404).json({ Message: 'Item not found' });
        return;
      }

      const seasonConfig = await loadConfig(req);
      if (seasonConfig) {
        await applyWatchedState([season], await watchedSnapshot(userUUID, seasonConfig), userUUID);
      }

      res.json(season);
      return;
    }

    if (descriptor.k === 'movie' || descriptor.k === 'series') {
      const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
      const meta = await fetchMeta(userUUID, stremioType, descriptor.i);
      if (!meta) {
        res.status(404).json({ Message: 'Item not found' });
        return;
      }
      const item = metaToBaseItem(meta, descriptor.t, serverIdFor(userUUID), null);

      // The client reads MediaSources straight off the item when it asks for
      // them in Fields, and reports "no file" without ever calling PlaybackInfo
      // if they are absent. Only ever resolved for a single item, never a list.
      const fields = String(req.query.Fields ?? req.query.fields ?? '');
      if (descriptor.k === 'movie' && fields.includes('MediaSources')) {
        await attachSources(req, item, descriptor, String(req.params.itemId));
      }

      if (descriptor.k === 'series') {
        const seasons = buildSeasons(meta, descriptor.t, item.Id, serverIdFor(userUUID));
        item.ChildCount = seasons.length;
        item.RecursiveItemCount = (Array.isArray(meta.videos) ? meta.videos : []).length;
      }

      const itemConfig = await loadConfig(req);
      if (itemConfig) {
        await applyWatchedState([item], await watchedSnapshot(userUUID, itemConfig), userUUID);
      }

      res.json(item);
      return;
    }

    if (descriptor.k === 'view') {
      const config = await loadConfig(req);
      const catalog = config
        ? await findCatalogByViewId(userUUID, config, descriptor.t, descriptor.c)
        : null;
      if (!catalog) {
        res.status(404).json({ Message: 'Item not found' });
        return;
      }
      res.json(
        collectionFolder(
          req.params.itemId,
          serverIdFor(userUUID),
          catalog.name,
          collectionTypeFor(catalog.type),
          null
        )
      );
      return;
    }

    res.status(404).json({ Message: 'Item not found' });
  });

  router.get('/Sessions', async (req: any, res: any) => {
    const userUUID = req.params.userUUID;
    const serverId = serverIdFor(userUUID);
    const config = await database.getUserConfig(userUUID);
    res.json([sessionInfo(serverId, serverId, userNameFor(config, userUUID), clientInfo(req))]);
  });

  router.post(['/Sessions/Capabilities', '/Sessions/Capabilities/Full'], (_req: any, res: any) => {
    res.status(204).end();
  });

  router.get('/DisplayPreferences/:id', (req: any, res: any) => {
    res.json({
      Id: req.params.id,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      RememberIndexing: false,
      RememberSorting: false,
      PrimaryImageHeight: 250,
      PrimaryImageWidth: 250,
      ScrollDirection: 'Horizontal',
      ShowBackdrop: true,
      ShowSidebar: false,
      Client: 'emby',
      CustomPrefs: {},
    });
  });

  router.post('/DisplayPreferences/:id', (_req: any, res: any) => {
    res.status(204).end();
  });

  router.get('/Localization/Options', (_req: any, res: any) => {
    res.json([{ Name: 'English', Value: 'en-US' }]);
  });

  router.get(['/Localization/Cultures', '/Localization/Countries', '/Localization/ParentalRatings'], (_req: any, res: any) => {
    res.json([]);
  });

  // A client reports its own playback to the server it is signed into, which is
  // this one, so the events the hand-off exists to relay arrive here directly.
  // Answering must never block playback, so each is acknowledged and acted on
  // after the response.
  const ack = (res: any) => res.status(204).end();

  router.post(['/Sessions/Playing', '/PlayingItems/:itemId'], (req: any, res: any) => {
    ack(res);
    recordPlaying(req, req.body).catch((error: any) =>
      logger.debug(`Playing report failed: ${error.message}`)
    );
  });

  router.post(['/Sessions/Playing/Progress', '/PlayingItems/:itemId/Progress'], (req: any, res: any) => {
    ack(res);
    recordProgress(req, req.body).catch((error: any) =>
      logger.debug(`Progress report failed: ${error.message}`)
    );
  });

  router.post('/Sessions/Playing/Stopped', (req: any, res: any) => {
    ack(res);
    recordStopped(req, req.body).catch((error: any) =>
      logger.debug(`Stopped report failed: ${error.message}`)
    );
  });

  router.delete('/PlayingItems/:itemId', (req: any, res: any) => {
    ack(res);
    recordStopped(req, req.body || {}).catch((error: any) =>
      logger.debug(`Stopped report failed: ${error.message}`)
    );
  });

  router.post('/Sessions/Playing/Ping', (_req: any, res: any) => ack(res));

  // A client reads the new state back out of the response here rather than
  // trusting a bare acknowledgement, and reports the server as not supporting
  // the operation when the body is empty.
  const playedState = (itemId: string, played: boolean): any => {
    const id = normaliseJellyfinId(itemId);
    return {
      ...EMPTY_USER_DATA,
      Key: id,
      ItemId: id,
      Played: played,
      PlayCount: played ? 1 : 0,
      PlaybackPositionTicks: 0,
      PlayedPercentage: played ? 100 : 0,
      LastPlayedDate: played ? new Date().toISOString() : null,
    };
  };

  router.post(['/Users/:userId/PlayedItems/:itemId', '/UserPlayedItems/:itemId'], (req: any, res: any) => {
    res.json(playedState(String(req.params.itemId), true));
    recordPlayed(req, { ItemId: req.params.itemId }).catch((error: any) =>
      logger.debug(`Played report failed: ${error.message}`)
    );
  });

  router.delete(['/Users/:userId/PlayedItems/:itemId', '/UserPlayedItems/:itemId'], (req: any, res: any) => {
    res.json(playedState(String(req.params.itemId), false));
    recordUnplayed(req, { ItemId: req.params.itemId }).catch((error: any) =>
      logger.debug(`Unplayed report failed: ${error.message}`)
    );
  });

  registerStubs(router);

  router.use((req: any, res: any) => {
    logger.debug(`Unsupported endpoint: ${req.method} ${req.path}`);
    res.status(404).json({ Message: `Unsupported Jellyfin endpoint: ${req.method} ${req.path}` });
  });

  return router;
}

export function register(addon: any, options: { loginRateLimit?: any; enabled?: () => boolean } = {}): void {
  const enabled = options.enabled || (() => false);

  const gate = (req: any, res: any, next: any) => {
    if (!enabled()) {
      res.status(404).json({ Message: 'Jellyfin API is disabled' });
      return;
    }
    next();
  };

  addon.use('/jellyfin/:userUUID', gate, createJellyfinRouter({ loginRateLimit: options.loginRateLimit }));
}

export { readToken };
