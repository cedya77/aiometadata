import express from 'express';

/**
 * Surfaces stock clients probe that have no meaning here. Empty lists keep them
 * quiet; anything genuinely unknown still falls through to a 404, never a 401,
 * which some clients read as a signal to log out.
 */
const EMPTY_LIST = { Items: [] as unknown[], TotalRecordCount: 0, StartIndex: 0 };

const LIST_ROUTES = [
  '/Years',
  '/Studios',
  '/Artists',
  '/Artists/AlbumArtists',
  '/MusicGenres',
  '/Channels',
  '/Playlists',
  '/Items/:itemId/Collections',
  '/Trailers',
  '/Items/Suggestions',
  '/Users/:userId/Suggestions',
  '/Items/:itemId/Intros',
  '/Users/:userId/Items/Intros',
  '/Users/:userId/Items/:itemId/Intros',
  '/Items/:itemId/ThemeSongs',
  '/Items/:itemId/ThemeVideos',
  '/Items/:itemId/Chapters',
  '/Videos/:itemId/AdditionalParts',
  '/System/ActivityLog/Entries',
  '/LiveTv/Programs',
  '/LiveTv/Recordings',
  '/LiveTv/Timers',
  '/LiveTv/SeriesTimers',
  '/LiveTv/Channels',
  '/LiveTv/Programs/Recommended',
  '/LiveTv/Recordings/Folders',
];

const ARRAY_ROUTES = [
  '/Plugins',
  '/ScheduledTasks',
  '/Packages',
  '/Repositories',
  '/Notifications/Types',
  '/Notifications/Services',
  '/Auth/Keys',
  '/Auth/PasswordResetProviders',
  '/Auth/Providers',
  '/Environment/Drives',
  '/Library/PhysicalPaths',
  '/Sessions/SyncPlay/List',
  '/SyncPlay/List',
  '/Items/:itemId/SpecialFeatures',
  '/Users/:userId/Items/:itemId/SpecialFeatures',
  '/Items/:itemId/LocalTrailers',
  '/Users/:userId/Items/:itemId/LocalTrailers',
  '/Movies/Recommendations',
];

const BITRATE_TEST_DEFAULT = 102400;
const BITRATE_TEST_MAX = 10 * 1024 * 1024;

export function registerStubs(router: any): void {
  for (const path of LIST_ROUTES) {
    router.get(path, (_req: any, res: any) => res.json(EMPTY_LIST));
  }
  for (const path of ARRAY_ROUTES) {
    router.get(path, (_req: any, res: any) => res.json([]));
  }

  router.post('/Sessions/Viewing', (_req: any, res: any) => res.status(204).end());
  router.post('/ClientLog/Document', (_req: any, res: any) => res.json({ FileName: `client-${Date.now()}.log` }));

  router.get('/Items/:itemId/ThemeMedia', (req: any, res: any) => {
    const empty = { ...EMPTY_LIST, OwnerId: req.params.itemId };
    res.json({
      ThemeVideosResult: empty,
      ThemeSongsResult: empty,
      SoundtrackSongsResult: empty,
    });
  });

  router.get('/LiveTv/Info', (_req: any, res: any) => {
    res.json({ Services: [], IsEnabled: false, EnabledUsers: [] });
  });

  router.get('/Playback/BitrateTest', (req: any, res: any) => {
    const requested = Math.floor(Number(req.query.Size ?? req.query.size));
    const size = requested > 0 ? Math.min(requested, BITRATE_TEST_MAX) : BITRATE_TEST_DEFAULT;
    res.type('application/octet-stream').send(Buffer.alloc(size));
  });
}

export { EMPTY_LIST };
