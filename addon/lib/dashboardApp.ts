// The dashboard installs as a home screen app that opens where it was added: a Jellyfin tab opens on its own
// configuration and user, any other page on the dashboard.

export const DASHBOARD_APP_MANIFEST = '/dashboard-app.webmanifest';

const CONFIG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE_ID = /^[\w-]{1,64}$/;
const BACKGROUND = '#0c0d0e';

type AppTarget = { config: string; profile: string | null } | null;

function targetOf(config: unknown, profile: unknown): AppTarget {
  if (typeof config !== 'string' || !CONFIG_ID.test(config)) return null;
  return { config: config.toLowerCase(), profile: typeof profile === 'string' && PROFILE_ID.test(profile) ? profile : null };
}

function startUrl(target: AppTarget): string {
  if (!target) return '/dashboard';
  return `/dashboard/jellyfin/${target.config}${target.profile ? `?profile=${target.profile}` : ''}`;
}

export function dashboardAppManifest(query: any): Record<string, unknown> {
  const target = targetOf(query?.config, query?.profile);
  return {
    id: startUrl(target),
    name: target ? 'AIOMetadata' : 'AIOMetadata Dashboard',
    short_name: 'AIOM',
    description: target ? 'Your Jellyfin history, library and Year in Review' : 'The AIOMetadata dashboard',
    start_url: startUrl(target),
    scope: '/dashboard/',
    display: 'standalone',
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    icons: [
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/** The tags that let a dashboard page be added to a home screen. */
export function dashboardAppHead(path: string, query: any): string {
  const [, config] = /^\/dashboard\/jellyfin\/([^/]+)/i.exec(path) ?? [];
  const target = targetOf(config, query?.profile);
  const manifest = target ? `${DASHBOARD_APP_MANIFEST}?config=${target.config}${target.profile ? `&profile=${target.profile}` : ''}` : DASHBOARD_APP_MANIFEST;
  return [
    `<link rel="manifest" href="${manifest}" />`,
    '<link rel="apple-touch-icon" href="/pwa/apple-touch-icon.png" />',
    '<meta name="mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-title" content="AIOM" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black" />',
  ].join('\n    ');
}

export const DASHBOARD_APP_THEME = BACKGROUND;
