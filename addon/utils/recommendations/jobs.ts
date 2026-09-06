import consola from 'consola';
import { RECOMMENDATION_CATALOGS } from './catalog';

const logger = consola.withTag('Recommendations');

export type JobStage = 'queued' | 'reading-history' | 'building-profile' | 'choosing' | 'fetching-art' | 'done' | 'error';

export interface Job {
  kind: string;
  catalogId: string;
  stage: JobStage;
  picks: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

/**
 * In memory on purpose. A job is only interesting while somebody is watching the
 * dialog that started it; the work it does lands in the shared cache, which is
 * what actually survives. A restart losing a job costs one regeneration.
 */
const jobs = new Map<string, Job>();

const keyOf = (userUUID: string, catalogId: string) => `${userUUID}:${catalogId}`;

export function listJobs(userUUID: string): Job[] {
  return [...jobs.entries()]
    .filter(([key]) => key.startsWith(`${userUUID}:`))
    .map(([, job]) => job);
}

export function isRunning(userUUID: string, catalogId: string): boolean {
  const job = jobs.get(keyOf(userUUID, catalogId));
  return !!job && job.stage !== 'done' && job.stage !== 'error';
}

/**
 * Generates one catalog end to end, reporting where it has got to.
 *
 * Everything the request path would do is done here instead: the profile, the
 * picks, and one pass of art fetching so the meta caches are warm. By the time
 * somebody installs the manifest, opening the row is a cache read.
 */
export function startJob(config: any, userUUID: string, catalogId: string): Job {
  const existing = jobs.get(keyOf(userUUID, catalogId));
  if (existing && isRunning(userUUID, catalogId)) return existing;

  const entry = RECOMMENDATION_CATALOGS.find(candidate => candidate.id === catalogId);
  if (!entry) throw new Error(`Unknown recommendation catalog: ${catalogId}`);

  const job: Job = { kind: entry.kind, catalogId, stage: 'queued', picks: 0, startedAt: Date.now() };
  jobs.set(keyOf(userUUID, catalogId), job);

  void (async () => {
    try {
      const { collectWatchedRows }: any = require('./history');
      job.stage = 'reading-history';
      await collectWatchedRows(config, userUUID);

      const { getTasteProfile }: any = require('./profile');
      job.stage = 'building-profile';
      const profile = await getTasteProfile(config, userUUID);
      if (!profile) throw new Error('Not enough watch history to build a profile');

      const { recommend }: any = require('./rank');
      job.stage = 'choosing';
      const picks = await recommend(config, userUUID, profile, entry.kind);
      job.picks = picks.length;

      // Warms the meta caches the row will read, so the first open is not the
      // first time every poster and rating is fetched.
      const { getRecommendationCatalog }: any = require('./catalog');
      job.stage = 'fetching-art';
      await getRecommendationCatalog(entry.type, catalogId, 1, config, userUUID);

      job.stage = 'done';
      job.finishedAt = Date.now();
      logger.info(`${catalogId} ready for ${userUUID}: ${job.picks} picks in ${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s`);
    } catch (error: any) {
      job.stage = 'error';
      job.error = error.message;
      job.finishedAt = Date.now();
      logger.warn(`${catalogId} failed for ${userUUID}: ${error.message}`);
    }
  })();

  return job;
}

/** Dropped once nobody is plausibly still watching, so the map cannot grow forever. */
export function pruneJobs(maxAgeMs = 30 * 60 * 1000): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(key);
  }
}

module.exports = { startJob, listJobs, isRunning, pruneJobs };
