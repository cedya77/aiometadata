// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { getSettleSeconds, getFrozenAgeSeconds } from './config';

export type StabilityStamp = { ongoing: boolean; endDate: string | null; native: 'frozen' | null };
export type StabilityResult = { stable: boolean; tier: 'frozen' | 'stable' | null; reason: string };

const ENDED_STATUSES = new Set([
  'ended', 'canceled', 'cancelled', 'released',
  'finished', 'finished airing',
]);

export function normalizeStatus(status: any): string {
  return String(status ?? '').trim().toLowerCase();
}

export const SUPPORTED_STABILITY_PROVIDERS = ['tmdb', 'tvdb', 'tvmaze', 'mal', 'kitsu'] as const;

export function deriveStabilityStamp(provider: string, raw: any, kind: 'movie' | 'series'): StabilityStamp {
  let ongoing = true;
  let endDate: string | null = null;
  let native: 'frozen' | null = null;

  switch (provider) {
    case 'tvdb': {
      const statusName = normalizeStatus(raw?.status?.name ?? raw?.status);
      if (raw?.status?.keepUpdated === false) native = 'frozen';
      if (kind === 'movie') {
        endDate = raw?.first_release?.date || raw?.releases?.[0]?.date || null;
        ongoing = (!!statusName && statusName !== 'released') || !endDate;
      } else {
        endDate = raw?.lastAired || null;
        ongoing = statusName === 'continuing' || statusName === 'upcoming' || !!raw?.nextAired || !endDate;
      }
      break;
    }
    case 'tvmaze':
      ongoing = normalizeStatus(raw?.status) !== 'ended';
      endDate = raw?.ended || null;
      break;
    case 'kitsu':
      ongoing = normalizeStatus(raw?.status) !== 'finished' || !raw?.endDate || !!raw?.nextRelease;
      endDate = raw?.endDate || null;
      break;
    case 'mal': {
      ongoing = raw?.airing === true || normalizeStatus(raw?.status) !== 'finished airing';
      const singleRelease = /^(movie|music)$/i.test(String(raw?.type || '')) || raw?.episodes === 1;
      const aired = raw?.aired?.to || (singleRelease ? raw?.aired?.from : null);
      endDate = aired ? String(aired).slice(0, 10) : null;
      break;
    }
    case 'tmdb':
      if (kind === 'movie') {
        ongoing = normalizeStatus(raw?.status) !== 'released';
        endDate = raw?.release_date || null;
      } else {
        const st = normalizeStatus(raw?.status);
        ongoing = raw?.in_production === true || !!raw?.next_episode_to_air || !ENDED_STATUSES.has(st);
        endDate = raw?.last_air_date || null;
      }
      break;
    default:
      break;
  }

  return { ongoing, endDate, native };
}

function endDateFallback(meta: any): string | null {
  if (meta.type === 'movie') {
    if (typeof meta.released === 'string') return meta.released.slice(0, 10);
    if (typeof meta.released === 'number') return new Date(meta.released).toISOString().slice(0, 10);
  }
  const ri = String(meta.releaseInfo || '');
  const m = ri.includes('-') ? /(\d{4})\s*$/.exec(ri) : null;
  return m ? `${m[1]}-12-31` : null;
}

function stampFromMeta(meta: any): StabilityStamp {
  if (meta._stability) return meta._stability as StabilityStamp;
  const st = normalizeStatus(meta.status);
  return {
    ongoing: st ? !ENDED_STATUSES.has(st) : true,
    endDate: endDateFallback(meta),
    native: null,
  };
}

export function classifyMetaStability(meta: any, now: number = Date.now()): StabilityResult {
  if (!meta || !meta.type) return { stable: false, tier: null, reason: 'no meta/type' };
  const kind: 'movie' | 'series' = meta.type === 'movie' ? 'movie' : 'series';
  const stamp = stampFromMeta(meta);
  
  if (stamp.ongoing) return { stable: false, tier: null, reason: 'ongoing/unreleased' };

  const endMs = stamp.endDate ? Date.parse(stamp.endDate) : NaN;
  if (!Number.isFinite(endMs)) return { stable: false, tier: null, reason: 'no end date' };

  const ageSec = (now - endMs) / 1000;
  if (ageSec < getSettleSeconds(kind)) {
    return { stable: false, tier: null, reason: `within settle window (${Math.floor(ageSec / 86400)}d)` };
  }
  const tier: 'frozen' | 'stable' = ageSec >= getFrozenAgeSeconds() ? 'frozen' : 'stable';
  return { stable: true, tier, reason: `finished ${Math.floor(ageSec / 86400)}d ago` };
}

module.exports = {
  normalizeStatus,
  deriveStabilityStamp,
  classifyMetaStability,
  SUPPORTED_STABILITY_PROVIDERS,
};
