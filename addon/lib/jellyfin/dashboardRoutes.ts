// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// The Jellyfin dashboard API: overview, per-configuration views, tracker sync,
// drift and matches, history import and copy, playlists, calendar feeds and
// the year in review. index.ts registers these routes in its own order.
import consola from 'consola';
const database: any = require('../database');

export function registerJellyfinDashboardRoutes(addon: any, deps: any): void {
  const { jellyfinRoute, requireDashboardAdmin } = deps;

  addon.get("/api/dashboard/jellyfin", requireDashboardAdmin, async (req, res) => {
    try {
      res.json(await require('./dashboard').dashboardOverview());
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to fetch Jellyfin playback data' });
    }
  });

  addon.get("/api/dashboard/jellyfin/search", requireDashboardAdmin, async (req, res) => {
    try {
      res.json(await require('./dashboard').dashboardSearch(String(req.query.q ?? '')));
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to search Jellyfin playback' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/export", jellyfinRoute({ reach: "config", heavy: true, turn: "files" }), async (req, res) => {
    try {
      const userUUID = String(req.params.userUUID);
      const config = await database.getUserConfig(userUUID).catch(() => null);
      const payload = await require('./historyTransfer').buildHistoryExport(userUUID, config);
      res.setHeader('Content-Disposition', `attachment; filename="aiometadata-history-${userUUID.slice(0, 8)}-${payload.exportedAt.slice(0, 10)}.json"`);
      res.json(payload);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to export the watch history' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/import", jellyfinRoute({ reach: "config", heavy: true, turn: "files" }), (req, res, next) => {
    const { historyImportBody } = require('./historyTransfer');
    if (!req.ownPage) return historyImportBody()(req, res, next);
    const limit = require('./ownPage').ownPageImportMb();
    return historyImportBody(limit)(req, res, (error) => {
      if (error?.type === 'entity.too.large') return res.status(413).json({ error: `That file is over the ${limit} MB this page takes` });
      return next(error);
    });
  }, async (req, res) => {
    try {
      const userUUID = String(req.params.userUUID);
      const config = await database.getUserConfig(userUUID).catch(() => null);
      if (!config) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      const outcome = await require('./historyTransfer').receiveHistoryImport(userUUID, config, req.body, req.query);
      res.status(outcome.status).json(outcome.body);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to import the watch history' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/import", jellyfinRoute({ reach: "config" }), async (req, res) => {
    try {
      res.json({ job: await require('./historyTransfer').historyImportStatus(String(req.params.userUUID)) });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the import' });
    }
  });

  addon.delete("/api/dashboard/jellyfin/:userUUID/import", jellyfinRoute({ reach: "config" }), async (req, res) => {
    try {
      const dismissed = await require('./historyTransfer').dismissHistoryImport(String(req.params.userUUID));
      res.status(dismissed ? 200 : 409).json(dismissed ? { ok: true } : { error: 'The import is still running' });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to clear the import' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/plays", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const kind = req.query.kind === 'played' ? 'played' : 'progress';
      const offset = parseInt(String(req.query.offset ?? ''), 10);
      const limit = parseInt(String(req.query.limit ?? ''), 10);
      const payload = await require('./dashboard').dashboardPlays(String(req.params.userUUID), profile, kind, Number.isFinite(offset) ? offset : 0, Number.isFinite(limit) ? limit : 30);
      if (!payload) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json(payload);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read Jellyfin plays' });
    }
  });

  // Art the dashboard draws into images it exports, read here so the browser can use it: public image hosts only.
  addon.get("/api/dashboard/art", jellyfinRoute({ reach: "session" }), async (req, res) => {
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    if (!/^https?:\/\//i.test(url) || url.length > 2048) {
      res.status(400).json({ error: 'An image URL is expected' });
      return;
    }
    const { fetchImage, isNotModified, OversizeImage } = require('../posterCache/upstream');
    try {
      const outcome = await fetchImage(url);
      if (isNotModified(outcome)) {
        res.status(502).json({ error: 'The image could not be read' });
        return;
      }
      res.setHeader('Content-Type', outcome.contentType);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(outcome.body);
    } catch (error) {
      if (error instanceof OversizeImage) error.stream?.destroy?.();
      // Always 502: a card asks for many paths at once, and a run of 4xx answers reads as probing to WAFs and ban lists.
      res.status(502).json({ error: 'The image could not be read' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/year", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const year = parseInt(String(req.query.year ?? ''), 10);
      // Next year is let through for the zones already in it; the review checks the viewer's own zone.
      if (!Number.isInteger(year) || year < 1970 || year > new Date().getUTCFullYear() + 1) {
        res.status(400).json({ error: 'Pick a year' });
        return;
      }
      const have = Number(req.query.have);
      const payload = await require('./yearReview').dashboardYear(String(req.params.userUUID), profile, year, Number.isFinite(have) && have > 0 ? have : null);
      if (!payload) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      if (payload.notBegun) {
        res.status(400).json({ error: 'Pick a year' });
        return;
      }
      res.json(payload);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the year in review' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/shows", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const payload = await require('./dashboard').dashboardShows(String(req.params.userUUID), profile, req.query.fresh === '1');
      if (!payload) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json(payload);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read Jellyfin shows' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/calendar", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const from = Number(req.query.from);
      const to = Number(req.query.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
        res.status(400).json({ error: 'Name the window as from and to times' });
        return;
      }
      const rows = await require('./dashboard').dashboardCalendar(String(req.params.userUUID), profile, from, to);
      if (!rows) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json(rows === 'pending' ? { rows: [], pending: true } : { rows });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the Jellyfin calendar' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/calendar/feed", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const secret = await require('./calendarFeed').calendarFeedSecret(String(req.params.userUUID), profile);
      res.json({ secret });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the calendar feed' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/calendar/feed", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.body?.profile === 'string' ? req.body.profile : null;
      const secret = await require('./calendarFeed').issueCalendarFeed(String(req.params.userUUID), profile);
      if (!secret) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json({ secret });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to create the calendar feed' });
    }
  });

  addon.delete("/api/dashboard/jellyfin/:userUUID/calendar/feed", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      await require('./calendarFeed').revokeCalendarFeed(String(req.params.userUUID), profile);
      res.json({ success: true });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to turn off the calendar feed' });
    }
  });

  addon.get("/calendar/:secret.ics", async (req, res) => {
    try {
      const body = await require('./calendarFeed').calendarFeed(String(req.params.secret));
      if (!body) {
        res.status(404).type('text/plain').send('No such calendar');
        return;
      }
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.type('text/calendar; charset=utf-8').send(body);
    } catch (error) {
      consola.error('[Calendar Feed] Error:', error);
      res.status(500).type('text/plain').send('Could not build the calendar');
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/library", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const tab = ['watchlist', 'ratings', 'dropped'].includes(String(req.query.tab)) ? String(req.query.tab) : 'watchlist';
      const kind = ['movie', 'series'].includes(String(req.query.kind)) ? String(req.query.kind) : 'all';
      const limit = parseInt(String(req.query.limit ?? ''), 10);
      const offset = parseInt(String(req.query.offset ?? ''), 10);
      const payload = await require('./dashboard').dashboardLibrary(String(req.params.userUUID), profile, tab, kind, Number.isFinite(offset) ? offset : 0, Number.isFinite(limit) ? limit : 48);
      if (!payload) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json(payload);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the Jellyfin library' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/library/undrop", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const metaId = typeof req.body?.metaId === 'string' ? req.body.metaId.trim() : '';
      const profile = typeof req.body?.profile === 'string' ? req.body.profile : null;
      if (!metaId) {
        res.status(400).json({ error: 'Name the show to pick back up' });
        return;
      }
      const undropped = await require('./dashboard').undropShow(String(req.params.userUUID), profile, metaId);
      if (undropped === null) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json({ undropped });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to pick the show back up' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/searches", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const payload = await require('./dashboard').dashboardSearches(String(req.params.userUUID), profile);
      if (!payload) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json(payload);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to list searches' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/find", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const query = String(req.query.q ?? '').trim().slice(0, 100);
      if (!query) {
        res.json({ query, available: true, results: [] });
        return;
      }
      const catalog = typeof req.query.catalog === 'string' && req.query.catalog ? req.query.catalog : null;
      const payload = await require('./dashboard').dashboardFindTitles(String(req.params.userUUID), profile, query, catalog);
      if (!payload) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json(payload);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to search titles' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/title", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const ref = {
        item: typeof req.query.item === 'string' ? req.query.item : undefined,
        id: typeof req.query.id === 'string' ? req.query.id : undefined,
        type: req.query.type === 'movie' ? 'movie' : 'series',
      };
      const payload = await require('./dashboard').dashboardTitle(String(req.params.userUUID), profile, ref);
      if (!payload) {
        res.status(404).json({ error: 'No such title' });
        return;
      }
      res.json(payload);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the title' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/person", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const item = typeof req.query.item === 'string' ? req.query.item : '';
      const payload = item ? await require('./dashboard').dashboardPerson(String(req.params.userUUID), profile, item) : null;
      if (!payload) {
        res.status(404).json({ error: 'No such person' });
        return;
      }
      res.json(payload);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the person' });
    }
  });

  const PERSON_ROLES = new Set(['all', 'Actor', 'Director', 'Writer', 'Producer', 'Composer']);

  addon.get("/api/dashboard/jellyfin/:userUUID/person/titles", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const item = typeof req.query.item === 'string' ? req.query.item : '';
      const kind = req.query.kind === 'movie' || req.query.kind === 'series' ? req.query.kind : 'all';
      const role = typeof req.query.role === 'string' && PERSON_ROLES.has(req.query.role) ? req.query.role : 'all';
      const offset = Number.parseInt(String(req.query.offset ?? '0'), 10);
      const limit = Number.parseInt(String(req.query.limit ?? '40'), 10);
      const payload = item
        ? await require('./dashboard').dashboardPersonTitles(String(req.params.userUUID), profile, item, kind, role, req.query.order === 'oldest', Number.isFinite(offset) ? offset : 0, Number.isFinite(limit) ? limit : 40)
        : null;
      if (!payload) {
        res.status(404).json({ error: 'No such person' });
        return;
      }
      res.json(payload);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the filmography' });
    }
  });

  const TITLE_ACTIONS = new Set(['played', 'unplayed', 'playedUpTo', 'unplayedFrom', 'watchlist', 'unwatchlist', 'drop', 'undrop', 'rate']);

  addon.post("/api/dashboard/jellyfin/:userUUID/title/action", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const action = String(req.body?.action ?? '');
      const itemIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds.filter((id) => typeof id === 'string' && id).slice(0, 500) : [];
      if (!TITLE_ACTIONS.has(action) || !itemIds.length) {
        res.status(400).json({ error: 'Name an action and the items it applies to' });
        return;
      }
      const profile = typeof req.body?.profile === 'string' ? req.body.profile : null;
      const rating = req.body?.rating === null || req.body?.rating === undefined ? null : Number(req.body.rating);
      const done = await require('./dashboard').dashboardTitleAction(String(req.params.userUUID), profile, action, itemIds, rating);
      if (done === null) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      if (done === false) {
        res.status(422).json({ error: 'The title could not be read, so nothing was changed' });
        return;
      }
      res.json({ done });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to change the title' });
    }
  });

  const dashboardProfile = (value) => (typeof value === 'string' ? value : null);
  const dashboardItemIds = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string' && /^[0-9a-f-]{32,36}$/i.test(id)).slice(0, 500) : []);

  addon.get("/api/dashboard/jellyfin/:userUUID/playlists", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const payload = await require('./dashboardPlaylists').dashboardPlaylists(String(req.params.userUUID), dashboardProfile(req.query.profile));
      if (!payload) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json(payload);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the playlists' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/playlists/:playlistId", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const playlists = require('./dashboardPlaylists');
      if (!playlists.isPlaylistId(req.params.playlistId)) {
        res.status(404).json({ error: 'No such playlist' });
        return;
      }
      const offset = Math.max(0, parseInt(String(req.query.offset ?? 0), 10) || 0);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? 20), 10) || 20));
      const payload = await playlists.dashboardPlaylist(String(req.params.userUUID), dashboardProfile(req.query.profile), req.params.playlistId, offset, limit);
      if (!payload || payload.missing) {
        res.status(404).json({ error: payload ? 'No such playlist' : 'No such configuration' });
        return;
      }
      res.json(payload);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the playlist' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/playlists/preview", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const itemIds = dashboardItemIds(req.body?.itemIds);
      if (!itemIds.length) {
        res.status(400).json({ error: 'Name the items to add' });
        return;
      }
      const payload = await require('./dashboardPlaylists').dashboardPlaylistPreview(String(req.params.userUUID), dashboardProfile(req.body?.profile), itemIds);
      if (!payload) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json(payload);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the playlists' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/playlists/change", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const playlists = require('./dashboardPlaylists');
      const body = req.body ?? {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const id = body.id;
      let change = null;
      if (body.op === 'create' && name) change = { op: 'create', name, itemIds: dashboardItemIds(body.itemIds) };
      else if (!playlists.isPlaylistId(id)) change = null;
      else if (body.op === 'rename' && name) change = { op: 'rename', id, name };
      else if (body.op === 'delete') change = { op: 'delete', id };
      else if (body.op === 'add' && dashboardItemIds(body.itemIds).length) change = { op: 'add', id, itemIds: dashboardItemIds(body.itemIds), position: Number.isInteger(body.position) ? body.position : null };
      else if (body.op === 'remove' && dashboardItemIds(body.itemIds).length) change = { op: 'remove', id, itemIds: dashboardItemIds(body.itemIds) };
      else if (body.op === 'move' && dashboardItemIds([body.itemId]).length && Number.isInteger(body.to)) change = { op: 'move', id, itemId: body.itemId, to: body.to };
      if (!change) {
        res.status(400).json({ error: 'That playlist change could not be read' });
        return;
      }
      const outcome = await playlists.dashboardPlaylistChange(String(req.params.userUUID), dashboardProfile(body.profile), change);
      if (!outcome) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      if (!outcome.ok) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }
      res.json(outcome);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to change the playlist' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/progress/remove", jellyfinRoute({ reach: "heldProfile", field: "profileKey" }), async (req, res) => {
    try {
      const videoId = typeof req.body?.videoId === 'string' && req.body.videoId.length <= 300 ? req.body.videoId : '';
      const profileKey = typeof req.body?.profileKey === 'string' && req.body.profileKey.length <= 200 ? req.body.profileKey : '';
      if (!videoId) {
        res.status(400).json({ error: 'Name the episode or film to remove' });
        return;
      }
      const done = await require('./dashboard').dashboardClearResume(String(req.params.userUUID), profileKey, videoId);
      if (done === null) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      if (!done) {
        res.status(400).json({ error: 'That play could not be removed' });
        return;
      }
      res.json({ done });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to remove it from Continue Watching' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/sync/same-viewing", jellyfinRoute({ reach: "heldProfile", field: "profile" }), async (req, res) => {
    try {
      const video = typeof req.body?.video === 'string' && req.body.video.length <= 300 ? req.body.video : '';
      const profileKey = typeof req.body?.profile === 'string' && req.body.profile.length <= 200 ? req.body.profile : '';
      const at = Number(req.body?.at);
      const theirs = Number(req.body?.theirs);
      if (!video || !Number.isFinite(at) || !Number.isFinite(theirs)) {
        res.status(400).json({ error: 'Name the play and the date the tracker has' });
        return;
      }
      const done = await require('./dashboard').dashboardSameViewing(String(req.params.userUUID), profileKey, video, at, theirs);
      if (done === null) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      if (done === 'invalid') {
        res.status(400).json({ error: 'That play or profile does not match a rewatch' });
        return;
      }
      if (!done) {
        res.status(409).json({ error: 'That play is no longer in the history' });
        return;
      }
      res.json({ done });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to join the play to the earlier viewing' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/title/watch-date", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId : '';
      const from = req.body?.from === null ? null : Number(req.body?.from);
      const to = Number(req.body?.to);
      if (!itemId || (from !== null && !Number.isFinite(from)) || !Number.isFinite(to) || to < Date.UTC(1900, 0, 1) || to > Date.now() + 5 * 60 * 1000) {
        res.status(400).json({ error: 'Name the item, the viewing and a date that is not in the future' });
        return;
      }
      const profile = typeof req.body?.profile === 'string' ? req.body.profile : null;
      const moved = await require('./dashboard').dashboardWatchDate(String(req.params.userUUID), profile, itemId, from, Math.round(to));
      if (moved === null) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      if (!moved) {
        res.status(409).json({ error: 'That viewing is no longer in the history' });
        return;
      }
      res.json({ moved });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to change the watch date' });
    }
  });

  addon.get("/api/dashboard/trackers", jellyfinRoute({ reach: "session" }), (req, res) => {
    res.json({ trackers: require('../trackers').trackerFacts() });
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/sync", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const sync = await require('./dashboard').dashboardSync(String(req.params.userUUID), profile);
      if (!sync) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json(sync);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the tracker sync' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/sync/run", jellyfinRoute({ reach: "accounts", accounts: ["key"], heavy: true, turn: "trackers" }), async (req, res) => {
    try {
      const key = typeof req.body?.key === 'string' ? req.body.key : '';
      if (!key) {
        res.status(400).json({ error: 'Name the tracker account to read' });
        return;
      }
      const done = await require('./dashboard').dashboardSyncNow(String(req.params.userUUID), key, req.body?.full === true);
      if (!done) {
        res.status(404).json({ error: 'No such tracker account on this configuration' });
        return;
      }
      res.json(done);
    } catch (error: any) {
      consola.error('[Dashboard API] Error:', error);
      res.status(502).json({ error: `The tracker refused the read: ${String(error?.trackerSaid ?? error?.message ?? 'no answer').slice(0, 200)}` });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/sync/outbox", jellyfinRoute({ reach: "config" }), async (req, res) => {
    try {
      const action = req.body?.action === 'retry' || req.body?.action === 'drop' ? req.body.action : null;
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 500) : [];
      if (!action || !ids.length) {
        res.status(400).json({ error: 'Name retry or drop and the writes it applies to' });
        return;
      }
      const count = await require('./dashboard').dashboardOutbox(String(req.params.userUUID), action, ids);
      if (count === null) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json({ count });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to change the waiting writes' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/sync/drift", jellyfinRoute({ reach: "profile", turn: "trackers" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const drift = await require('./dashboard').dashboardDrift(String(req.params.userUUID), profile);
      if (!drift) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json(drift);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to compare the trackers' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/sync/drift", jellyfinRoute({ reach: "profile", accounts: ["key"], heavy: true, turn: "trackers" }), async (req, res) => {
    try {
      const key = typeof req.body?.key === 'string' ? req.body.key : '';
      const action = ['push', 'pull', 'leave', 'restore'].includes(req.body?.action) ? req.body.action : null;
      const items = Array.isArray(req.body?.items) ? req.body.items.filter((item) => typeof item === 'string').slice(0, 500) : null;
      const origin = typeof req.body?.origin === 'string' && req.body.origin.length <= 32 ? req.body.origin : null;
      const profile = typeof req.body?.profile === 'string' ? req.body.profile : null;
      if (!key || !action || ((action === 'leave' || action === 'restore') && !origin)) {
        res.status(400).json({ error: 'Name the tracker account, the action and, to leave out or show again, the import' });
        return;
      }
      const count = await require('./dashboard').dashboardDriftAction(String(req.params.userUUID), key, action, items, origin, profile);
      if (count === null) {
        res.status(404).json({ error: 'No such tracker account on this configuration' });
        return;
      }
      res.json({ count });
    } catch (error: any) {
      consola.error('[Dashboard API] Error:', error);
      res.status(502).json({ error: `The tracker could not be read first: ${String(error?.trackerSaid ?? error?.message ?? 'no answer').slice(0, 200)}` });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/sync/drift/imported", jellyfinRoute({ reach: "profile", accounts: ["key"] }), async (req, res) => {
    try {
      const key = typeof req.query.key === 'string' ? req.query.key : '';
      const origin = typeof req.query.origin === 'string' ? req.query.origin.slice(0, 32) : '';
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const items = key && origin ? await require('./dashboard').dashboardDriftImported(String(req.params.userUUID), key, origin, profile) : null;
      if (!items) {
        res.status(404).json({ error: 'No such tracker account on this configuration' });
        return;
      }
      res.json({ items });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to list the imported watches' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/sync/drift/item", jellyfinRoute({ reach: "accounts", accounts: ["key"] }), async (req, res) => {
    try {
      const key = typeof req.query.key === 'string' ? req.query.key : '';
      const video = typeof req.query.video === 'string' ? req.query.video.slice(0, 120) : '';
      const side = req.query.side === 'ahead' ? 'ahead' : 'behind';
      const bases = typeof req.query.bases === 'string' ? req.query.bases.split(',').slice(0, 20) : [];
      const detail = key && video ? await require('./dashboard').dashboardDriftItem(String(req.params.userUUID), key, side, video, bases) : null;
      if (!detail) {
        res.status(404).json({ error: 'No such title on this tracker account' });
        return;
      }
      res.json(detail);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the details' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/sync/match/search", jellyfinRoute({ reach: "accounts", accounts: ["key"] }), async (req, res) => {
    try {
      const key = typeof req.query.key === 'string' ? req.query.key : '';
      const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
      const kind = req.query.kind === 'movie' ? 'movie' : 'series';
      if (!key || query.length < 2) {
        res.status(400).json({ error: 'Name the tracker account and what to look for' });
        return;
      }
      const results = await require('./dashboard').dashboardMatchSearch(String(req.params.userUUID), key, query, kind);
      if (!results) {
        res.status(404).json({ error: 'No tracker account on this configuration that titles can be matched on' });
        return;
      }
      res.json({ results });
    } catch (error: any) {
      consola.error('[Dashboard API] Error:', error);
      res.status(502).json({ error: 'The tracker could not be searched' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/sync/match/detail", jellyfinRoute({ reach: "accounts", accounts: ["key"] }), async (req, res) => {
    try {
      const key = typeof req.body?.key === 'string' ? req.body.key : '';
      const detail = key ? await require('./dashboard').dashboardMatchDetail(String(req.params.userUUID), key, req.body?.candidate) : null;
      if (!detail) {
        res.status(404).json({ error: 'That title could not be read from the tracker' });
        return;
      }
      res.json(detail);
    } catch (error: any) {
      consola.error('[Dashboard API] Error:', error);
      res.status(502).json({ error: 'The tracker could not be read' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/sync/matches", jellyfinRoute({ reach: "accounts", accounts: ["key"] }), async (req, res) => {
    try {
      const key = typeof req.query.key === 'string' ? req.query.key : '';
      const matches = key ? await require('./dashboard').dashboardMatches(String(req.params.userUUID), key) : null;
      if (!matches) {
        res.status(404).json({ error: 'No tracker account on this configuration that titles can be matched on' });
        return;
      }
      res.json({ matches });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the matched titles' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/sync/match", jellyfinRoute({ reach: "accounts", accounts: ["key"] }), async (req, res) => {
    try {
      const key = typeof req.body?.key === 'string' ? req.body.key : '';
      const saved = key ? await require('./dashboard').dashboardMatchSave(String(req.params.userUUID), key, req.body) : null;
      if (!saved) {
        res.status(400).json({ error: 'Pick a title on the tracker and the title it stands for here' });
        return;
      }
      res.json(saved);
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to save the match' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/sync/match/remove", jellyfinRoute({ reach: "accounts", accounts: ["key"] }), async (req, res) => {
    try {
      const key = typeof req.body?.key === 'string' ? req.body.key : '';
      const group = typeof req.body?.group === 'string' ? req.body.group : '';
      const removed = key && group ? await require('./dashboard').dashboardMatchRemove(String(req.params.userUUID), key, group) : false;
      if (!removed) {
        res.status(404).json({ error: 'No such match' });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to remove the match' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/sync/copy/preview", jellyfinRoute({ reach: "profile", accounts: ["from", "to"], heavy: true, turn: "trackers" }), async (req, res) => {
    try {
      const profile = typeof req.body?.profile === 'string' ? req.body.profile : null;
      const from = typeof req.body?.from === 'string' ? req.body.from : '';
      const to = typeof req.body?.to === 'string' ? req.body.to : '';
      const since = Number(req.body?.since) > 0 ? Number(req.body.since) : 0;
      const what = ['ratings', 'watchlist', 'dropped'].includes(req.body?.what) ? req.body.what : 'watches';
      const preview = await require('./dashboard').dashboardCopyPreview(String(req.params.userUUID), profile, from, to, since, what, req.body?.retry === true);
      if (!preview) {
        res.status(404).json({ error: 'Pick two different trackers on this configuration that can copy this' });
        return;
      }
      res.json(preview);
    } catch (error: any) {
      consola.error('[Dashboard API] Error:', error);
      res.status(502).json({ error: `The trackers could not be compared: ${String(error?.trackerSaid ?? error?.message ?? 'no answer').slice(0, 200)}` });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/sync/copy/describe", jellyfinRoute({ reach: "session" }), async (req, res) => {
    try {
      const videos = Array.isArray(req.body?.videos) ? req.body.videos.filter((v) => typeof v === 'string').slice(0, 120) : [];
      res.json(await require('./dashboard').dashboardCopyDescribe(String(req.params.userUUID), videos));
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to name the titles' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/sync/copy", jellyfinRoute({ reach: "config" }), async (req, res) => {
    try {
      res.json({ jobs: await require('./dashboard').dashboardCopyJobs(String(req.params.userUUID)) });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to read the copies' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/sync/copy", jellyfinRoute({ reach: "profile", accounts: ["from", "to"], heavy: true, turn: "trackers" }), async (req, res) => {
    try {
      const profile = typeof req.body?.profile === 'string' ? req.body.profile : null;
      const from = typeof req.body?.from === 'string' ? req.body.from : '';
      const to = typeof req.body?.to === 'string' ? req.body.to : '';
      const since = Number(req.body?.since) > 0 ? Number(req.body.since) : 0;
      const titles = Array.isArray(req.body?.titles) ? req.body.titles.filter((t) => typeof t === 'string').slice(0, 5000) : null;
      const what = ['ratings', 'watchlist', 'dropped'].includes(req.body?.what) ? req.body.what : 'watches';
      const id = await require('./dashboard').dashboardCopyStart(String(req.params.userUUID), profile, from, to, since, titles, what, req.body?.retry === true);
      if (id === null) {
        res.status(404).json({ error: 'Pick two different trackers on this configuration' });
        return;
      }
      res.json({ id });
    } catch (error: any) {
      consola.error('[Dashboard API] Error:', error);
      res.status(502).json({ error: `The copy could not start: ${String(error?.trackerSaid ?? error?.message ?? 'no answer').slice(0, 200)}` });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/sync/copy/:id", jellyfinRoute({ reach: "config" }), async (req, res) => {
    try {
      const action = ['pause', 'resume', 'stop'].includes(req.body?.action) ? req.body.action : null;
      const id = Number(req.params.id);
      if (!action || !Number.isInteger(id)) {
        res.status(400).json({ error: 'Name pause, resume or stop' });
        return;
      }
      const ok = await require('./dashboard').dashboardCopyControl(String(req.params.userUUID), id, action);
      res.status(ok ? 200 : 409).json({ ok });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to change the copy' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID/devices", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const devices = await require('./dashboard').dashboardDevices(String(req.params.userUUID), profile);
      if (!devices) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json({ devices });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to list devices' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/devices/open", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : '';
      const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId : '';
      if (!deviceId || !itemId) {
        res.status(400).json({ error: 'Name a device and an item' });
        return;
      }
      const profile = typeof req.body?.profile === 'string' ? req.body.profile : null;
      const start = Number(req.body?.startPositionTicks);
      const sent = await require('./dashboard').dashboardOpenOn(String(req.params.userUUID), profile, deviceId, {
        itemId,
        itemType: typeof req.body?.itemType === 'string' ? req.body.itemType : '',
        itemName: typeof req.body?.itemName === 'string' ? req.body.itemName : '',
        play: req.body?.play === true,
        startPositionTicks: Number.isFinite(start) && start > 0 ? start : undefined,
      });
      if (sent === null) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      if (!sent) {
        res.status(409).json({ error: 'That device is no longer connected' });
        return;
      }
      res.json({ sent });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to reach the device' });
    }
  });

  addon.post("/api/dashboard/jellyfin/:userUUID/shows/refresh", jellyfinRoute({ reach: "session", heavy: true }), async (req, res) => {
    try {
      const metaId = typeof req.body?.metaId === 'string' ? req.body.metaId.trim() : '';
      if (!metaId) {
        res.status(400).json({ error: 'Name the show to refresh' });
        return;
      }
      res.json({ refreshed: await require('./dashboard').refreshShow(String(req.params.userUUID), metaId) });
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to refresh the show' });
    }
  });

  addon.get("/api/dashboard/jellyfin/:userUUID", jellyfinRoute({ reach: "profile" }), async (req, res) => {
    try {
      const profile = typeof req.query.profile === 'string' ? req.query.profile : null;
      const rows = parseInt(String(req.query.rows ?? ''), 10);
      const offset = parseInt(String(req.query.tz ?? ''), 10);
      const payload = await require('./dashboard').dashboardConfiguration(String(req.params.userUUID), profile, Number.isFinite(rows) ? rows : undefined, Number.isFinite(offset) && Math.abs(offset) <= 14 * 60 ? offset : 0);
      if (!payload) {
        res.status(404).json({ error: 'No such configuration' });
        return;
      }
      res.json(require('./ownPage').ownPageOverview(req, payload));
    } catch (error) {
      consola.error('[Dashboard API] Error:', error);
      res.status(500).json({ error: 'Failed to fetch Jellyfin playback data' });
    }
  });
}
