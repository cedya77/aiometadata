import consola from 'consola';
import { envInt } from '../envNumber';

const logger = consola.withTag('Recommendations');
const redis: any = require('../../lib/redisClient');
const { runWithRequestContext }: any = require('../../lib/logBuffer');

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

function seenKey(viewer: string): string {
  return `recommendations:seen:${viewer}`;
}

/** A row that was opened is kept warm; one nobody reads is left to lapse. */
export async function markSeen(viewer: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(seenKey(viewer), '1', 'EX', envInt('RECOMMENDATION_ACTIVE_DAYS', 7, 1) * 24 * 60 * 60);
  } catch (error: any) {
    logger.debug(`Could not mark ${viewer} as active: ${error?.message || error}`);
  }
}

export async function rowStamp(viewer: string): Promise<string> {
  if (!redis) return '';
  try {
    return (await redis.get(`recommendations:stamp:${viewer}`)) || '';
  } catch {
    return '';
  }
}

export async function bumpRowStamp(viewer: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(`recommendations:stamp:${viewer}`, String(Date.now()), 'EX', 90 * 24 * 60 * 60);
  } catch (error: any) {
    logger.debug(`Could not mark rows of ${viewer} as rebuilt: ${error?.message || error}`);
  }
}

function usable(config: any): boolean {
  const hasHistory = require('./history').canReadHistory(config);
  const hasModel = !!(config?.apiKeys?.gemini || config?.apiKeys?.openrouter
    || process.env.GEMINI_API_KEY || process.env.BUILT_IN_GEMINI_API_KEY || process.env.OPENROUTER_API_KEY);
  return hasHistory && hasModel;
}

export async function sweepRecommendations(): Promise<{ checked: number; refreshed: number }> {
  const out = { checked: 0, refreshed: 0 };
  if (!redis || sweeping) return out;
  sweeping = true;
  try {
    const database: any = require('../../lib/database');
    const { withGlobalEpoch }: any = require('../../lib/cacheEpoch');
    const { runWithSourceRefetch }: any = require('../../lib/cacheSourceRefetch');
    const { RECOMMENDATION_CATALOGS, isRecommendationCatalog }: any = require('./catalog');
    const { picksKey, recommend }: any = require('./rank');
    const { getTasteProfile }: any = require('./profile');
    const { runAsProfile }: any = require('./history');
    const leadMs = envInt('RECOMMENDATION_REFRESH_LEAD', 3600, 60) * 1000;

    const seen: string[] = [];
    let cursor = '0';
    do {
      const [next, keys]: [string, string[]] = await redis.scan(cursor, 'MATCH', 'recommendations:seen:*', 'COUNT', 500);
      cursor = next;
      for (const key of keys) seen.push(key.slice('recommendations:seen:'.length));
    } while (cursor !== '0');

    for (const viewer of seen) {
      await new Promise((resolve) => setImmediate(resolve));
      const [userId, profileId] = viewer.split('#');
      let config: any;
      try {
        config = await database.getUserConfig(userId);
      } catch {
        continue;
      }
      if (!config) continue;
      const user = { id: userId };
      const wanted = (config?.catalogs || [])
        .filter((catalog: any) => catalog?.enabled && isRecommendationCatalog(catalog.id))
        .map((catalog: any) => catalog.id);
      if (!wanted.length || !usable(config)) continue;

      await runAsProfile(config, user.id, profileId || null, async (viewerConfig: any) => {
        let profile: any = null;
        for (const id of wanted) {
          const kind = RECOMMENDATION_CATALOGS.find((entry: any) => entry.id === id)?.kind;
          if (!kind) continue;
          out.checked += 1;
          const ttlMs = await redis.pttl(withGlobalEpoch(picksKey(viewerConfig, user.id, kind)));
          if (!(ttlMs > 0 && ttlMs <= leadMs)) continue;
          try {
            profile = profile ?? (await runWithRequestContext(user.id, () => getTasteProfile(viewerConfig, user.id)));
            if (!profile) break;
            const picks = await runWithRequestContext(user.id, () => runWithSourceRefetch(() => recommend(viewerConfig, user.id, profile, kind)));
            out.refreshed += 1;
            logger.info(`Refreshed ${id} for ${viewer} ${Math.round(ttlMs / 60000)} min before it lapsed: ${picks.length} picks`);
          } catch (error: any) {
            logger.warn(`Could not refresh ${id} for ${viewer}: ${error?.message || error}`);
          }
        }
      });
    }
  } catch (error: any) {
    logger.warn(`Recommendation refresh sweep failed: ${error?.message || error}`);
  } finally {
    sweeping = false;
  }
  return out;
}

export function startRecommendationRefresh(): void {
  if (timer || !redis) return;
  const every = envInt('RECOMMENDATION_REFRESH_SWEEP', 900, 60) * 1000;
  timer = setInterval(() => {
    sweepRecommendations().catch(() => undefined);
  }, every);
  timer.unref?.();
  logger.info(`Recommendation refresh sweep every ${Math.round(every / 60000)} min, ${envInt('RECOMMENDATION_REFRESH_LEAD', 3600, 60) / 60} min before a row lapses`);
}

module.exports = { markSeen, rowStamp, bumpRowStamp, sweepRecommendations, startRecommendationRefresh };
