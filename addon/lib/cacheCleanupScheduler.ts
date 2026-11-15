// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
// Cache Cleanup Scheduler
// Handles automatic scheduling of expired cache cleanup

import consola from 'consola';
import { insideWindow, msUntilWindow, runWindow } from './runWindow';

const logger = consola.create({
  defaults: {
    tag: 'Cache-Cleanup-Scheduler'
  }
});

interface DashboardAPI {
  runScheduledCacheCleanup(): Promise<{ success: boolean; skipped?: boolean; message?: string }>;
}

interface SchedulerStatus {
  isRunning: boolean;
  lastRun: string | null;
  nextRun: string | null;
  intervalHours: number;
  window: string | null;
}

class CacheCleanupScheduler {
  private dashboardApi: DashboardAPI;
  private isRunning: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private intervalHours: number = 6; // Run every 6 hours
  private lastRun: Date | null = null;
  private nextRun: Date | null = null;

  constructor(dashboardApi: DashboardAPI) {
    this.dashboardApi = dashboardApi;
  }

  private log(level: string, message: string): void {
    (logger as any)[level](message);
  }

  private schedule(delayMs: number): void {
    this.nextRun = new Date(Date.now() + delayMs);
    this.timer = setTimeout(() => {
      this.tick().catch((error) => this.log('error', `Scheduled cache cleanup failed: ${(error as Error).message}`));
    }, delayMs);
  }

  private async tick(): Promise<void> {
    const window = runWindow('CACHE_CLEANUP');
    if (!insideWindow(window)) {
      const wait = msUntilWindow(window);
      this.log('info', `Outside cleanup hours (${window?.text}); next cleanup in ${Math.round(wait / 60000)} minutes`);
      this.schedule(wait);
      return;
    }
    await this.runCleanup();
    this.schedule(this.intervalHours * 60 * 60 * 1000);
    this.log('info', `Next scheduled cleanup: ${this.nextRun?.toISOString()}`);
  }

  private async runCleanup(): Promise<void> {
    if (this.isRunning) {
      this.log('warn', 'Cache cleanup already running, skipping');
      return;
    }

    this.isRunning = true;
    this.lastRun = new Date();

    try {
      this.log('info', 'Starting scheduled cache cleanup...');
      
      const result = await this.dashboardApi.runScheduledCacheCleanup();

      if (result?.success) {
        this.log(result.skipped ? 'info' : 'success', result.message || 'Scheduled cache cleanup completed');
      } else {
        this.log('error', result?.message || 'Scheduled cache cleanup failed');
      }
      
    } catch (error) {
      this.log('error', `Scheduled cache cleanup failed: ${(error as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }

  public start(): void {
    if (this.timer) {
      this.log('warn', 'Cache cleanup scheduler already started');
      return;
    }

    this.log('success', `Starting cache cleanup scheduler (every ${this.intervalHours} hours)`);
    this.schedule(30000);
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.nextRun = null;
      this.log('info', 'Cache cleanup scheduler stopped');
    }
  }

  public getStatus(): SchedulerStatus {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun ? this.lastRun.toISOString() : null,
      nextRun: this.nextRun ? this.nextRun.toISOString() : null,
      intervalHours: this.intervalHours,
      window: runWindow('CACHE_CLEANUP')?.text ?? null
    };
  }
}

// Singleton instance
let schedulerInstance: CacheCleanupScheduler | null = null;

export function getCacheCleanupScheduler(dashboardApi?: DashboardAPI): CacheCleanupScheduler | null {
  if (!schedulerInstance && dashboardApi) {
    schedulerInstance = new CacheCleanupScheduler(dashboardApi);
  }
  return schedulerInstance;
}

export function startCacheCleanupScheduler(dashboardApi: DashboardAPI): CacheCleanupScheduler | null {
  const scheduler = getCacheCleanupScheduler(dashboardApi);
  if (scheduler) {
    if (process.env.CACHE_CLEANUP_AUTO_ENABLED === 'false') {
      logger.info('Automatic cache cleanup scheduler disabled via CACHE_CLEANUP_AUTO_ENABLED=false');
      return scheduler;
    }

    scheduler.start();
    return scheduler;
  }
  return null;
}

export { CacheCleanupScheduler };
export type { DashboardAPI, SchedulerStatus };
