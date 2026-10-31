import { useMemo, useSyncExternalStore } from 'react';
import type { DashboardTab, JellyfinTitlePerson, JellyfinTitleRef } from '@/hooks/useDashboardQueries';

export type DashboardPage = { kind: 'title'; ref: JellyfinTitleRef; season?: number | null } | { kind: 'person'; person: JellyfinTitlePerson };

export type JellyfinSection = 'overview' | 'library' | 'shows' | 'calendar' | 'history' | 'year' | 'trackers';

export const JELLYFIN_SECTIONS: readonly JellyfinSection[] = ['overview', 'library', 'shows', 'calendar', 'history', 'year', 'trackers'];

export interface DashboardRoute {
  tab: DashboardTab | null;
  config: string | null;
  profile: string | null;
  page: DashboardPage | null;
  section?: JellyfinSection;
}

export interface DashboardLocation extends DashboardRoute {
  stack: DashboardPage[];
}

const BASE = '/dashboard';
const TABS: readonly DashboardTab[] = ['overview', 'analytics', 'content', 'performance', 'system', 'operations', 'users', 'jellyfin', 'logs', 'settings'];
const NAVIGATE_EVENT = 'aiom:dashboard-navigate';
const MAIN_PROFILE = 'main';

interface HistoryEntry {
  key: string;
  stack: DashboardPage[];
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function encode(part: string): string {
  return encodeURIComponent(part).replace(/%3A/gi, ':');
}

export function slugOf(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}

export function parseDashboardUrl(pathname: string, search: string): DashboardRoute {
  const parts = pathname.replace(/^\/dashboard/i, '').split('/').filter(Boolean).map(decode);
  const tab = TABS.find((name) => name === parts[0]) ?? null;
  if (tab !== 'jellyfin' || !parts[1]) return { tab, config: null, profile: null, page: null };
  const section = JELLYFIN_SECTIONS.find((name) => name === parts[2]) ?? 'overview';
  const at = section === parts[2] ? 3 : 2;
  const [kind, id] = [parts[at], parts[at + 1]];
  let page: DashboardPage | null = null;
  if (id && (kind === 'movie' || kind === 'series')) page = { kind: 'title', ref: { id, type: kind } };
  else if (id && kind === 'item') page = { kind: 'title', ref: { item: id } };
  else if (id && kind === 'person') page = { kind: 'person', person: { id, name: '', role: null, type: '', photo: null } };
  const profile = new URLSearchParams(search).get('profile');
  return { tab, config: parts[1], profile: profile === MAIN_PROFILE ? '' : profile, page, section };
}

export function dashboardUrl(route: DashboardRoute, name?: string): string {
  if (!route.tab) return BASE;
  let path = `${BASE}/${route.tab}`;
  if (route.tab !== 'jellyfin' || !route.config) return path;
  path += `/${encode(route.config)}`;
  if (route.section && route.section !== 'overview') path += `/${route.section}`;
  const page = route.page;
  if (page) {
    const [kind, id] = page.kind === 'person' ? ['person', page.person.id] : 'item' in page.ref ? ['item', page.ref.item] : [page.ref.type, page.ref.id];
    path += `/${kind}/${encode(id)}`;
    const slug = slugOf(name ?? (page.kind === 'person' ? page.person.name : ''));
    if (slug) path += `/${slug}`;
  }
  return route.profile === null ? path : `${path}?${new URLSearchParams({ profile: route.profile || MAIN_PROFILE })}`;
}

function entryOf(state: unknown): HistoryEntry | null {
  const entry = (state as { dashboard?: HistoryEntry } | null)?.dashboard;
  return entry && Array.isArray(entry.stack) ? entry : null;
}

function newEntry(stack: DashboardPage[]): HistoryEntry {
  return { key: Math.random().toString(36).slice(2), stack };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

function snapshot(): string {
  return `${dashboardUrl(parseDashboardUrl(window.location.pathname, window.location.search))} ${entryOf(window.history.state)?.key ?? ''}`;
}

export function useDashboardRoute(): DashboardLocation {
  const current = useSyncExternalStore(subscribe, snapshot, () => '');
  return useMemo(() => {
    const route = parseDashboardUrl(window.location.pathname, window.location.search);
    const held = entryOf(window.history.state)?.stack;
    const stack = route.page ? (held?.length ? held : [route.page]) : [];
    return { ...route, stack };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
}

export function navigateDashboard(route: DashboardRoute, options: { replace?: boolean; stack?: DashboardPage[] } = {}): void {
  const here = parseDashboardUrl(window.location.pathname, window.location.search);
  const stack = route.page ? options.stack ?? [route.page] : [];
  const url = dashboardUrl(route.section === undefined && route.tab === here.tab && route.config === here.config ? { ...route, section: here.section } : route);
  if (!options.replace && url === dashboardUrl(here) && (entryOf(window.history.state)?.stack.length ?? 0) === stack.length) return;
  const state = { dashboard: newEntry(stack) };
  if (options.replace) window.history.replaceState(state, '', url);
  else window.history.pushState(state, '', url);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export function nameDashboardPage(name: string, page?: DashboardPage): void {
  const route = parseDashboardUrl(window.location.pathname, window.location.search);
  if (!route.page) return;
  const url = dashboardUrl({ ...route, page: page ?? route.page }, name);
  if (url === window.location.pathname + window.location.search) return;
  window.history.replaceState(window.history.state, '', url);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export function settleDashboardEntry(): void {
  if (entryOf(window.history.state)) return;
  const route = parseDashboardUrl(window.location.pathname, window.location.search);
  const here = window.location.pathname + window.location.search;
  if (route.page) {
    window.history.replaceState({ dashboard: newEntry([]) }, '', dashboardUrl({ ...route, page: null }));
    window.history.pushState({ dashboard: newEntry([route.page]) }, '', here);
  } else {
    window.history.replaceState({ dashboard: newEntry([]) }, '', here);
  }
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}
