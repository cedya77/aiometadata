// Cache Cleanup Scheduler
// Handles automatic scheduling of expired cache cleanup

import consola from 'consola';

const logger = consola.create({
  defaults: {
    tag: 'Cache-Cleanup-Scheduler'
  }
});

interface DashboardAPI {
  checkExpiredKeysCount(): Promise<{ count: number; totalKeys: number; error?: string }>;
  runScheduledCacheCleanup(): Promise<any>;
}

interface SchedulerStatus {
  isRunning: boolean;
  lastRun: string | null;
  nextRun: string | null;
  intervalHours: number;
  quietHoursEnabled: boolean;
  quietHoursRange: string;
}

class CacheCleanupScheduler {
  private dashboardApi: DashboardAPI;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private intervalHours: number = 6; // Run every 6 hours
  private quietHoursEnabled: boolean;
  private quietHoursRange: string;
  private lastRun: Date | null = null;
  private nextRun: Date | null = null;

  constructor(dashboardApi: DashboardAPI) {
    this.dashboardApi = dashboardApi;
    this.quietHoursEnabled = process.env.CACHE_CLEANUP_QUIET_HOURS_ENABLED === 'true';
    this.quietHoursRange = process.env.CACHE_CLEANUP_QUIET_HOURS || '02:00-06:00';
  }

  private log(level: string, message: string): void {
    (logger as any)[level](message);
  }

  private isQuietHours(): boolean {
    if (!this.quietHoursEnabled) return false;

    const [startHour, endHour] = this.quietHoursRange.split('-').map(t => {
      const [h, m] = t.split(':').map(Number);
      return h + m / 60;
    });

    const now = new Date();
    const currentHour = now.getHours() + now.getMinutes() / 60;

    if (startHour < endHour) {
      return currentHour >= startHour && currentHour < endHour;
    } else {
      return currentHour >= startHour || currentHour < endHour;
    }
  }

  private async shouldRunCleanup(): Promise<boolean> {
    try {
      // Check if we're in quiet hours
      if (this.isQuietHours()) {
        this.log('info', 'Skipping cache cleanup during quiet hours');
        return false;
      }

      // Check if cleanup is needed (has expired keys)
      const checkResult = await this.dashboardApi.checkExpiredKeysCount();
      
      if (checkResult.error) {
        this.log('error', `Failed to check expired keys: ${checkResult.error}`);
        return false;
      }

      if (checkResult.count === 0) {
        this.log('info', `No expired keys found (${checkResult.totalKeys} total keys), skipping cleanup`);
        return false;
      }

      this.log('info', `Found ${checkResult.count} expired keys out of ${checkResult.totalKeys} total keys - cleanup needed`);
      return true;
    } catch (error) {
      this.log('error', `Error checking if cleanup should run: ${(error as Error).message}`);
      return false;
    }
  }

  private async runCleanup(): Promise<void> {
    if (this.isRunning) {
      this.log('warn', 'Cache cleanup already running, skipping');
      return;
    }

    // Check if cleanup should run (quiet hours, expired keys check)
    const shouldRun = await this.shouldRunCleanup();
    if (!shouldRun) {
      return;
    }

    this.isRunning = true;
    this.lastRun = new Date();

    try {
      this.log('info', 'Starting scheduled cache cleanup...');
      
      const result = await this.dashboardApi.runScheduledCacheCleanup();
      
      if (result) {
        this.log('success', 'Scheduled cache cleanup completed successfully');
      } else {
        this.log('info', 'Scheduled cache cleanup completed (no action needed)');
      }
      
    } catch (error) {
      this.log('error', `Scheduled cache cleanup failed: ${(error as Error).message}`);
    } finally {
      this.isRunning = false;
      this.updateNextRunTime();
    }
  }

  private updateNextRunTime(): void {
    const now = Date.now();
    this.nextRun = new Date(now + (this.intervalHours * 60 * 60 * 1000));
    this.log('info', `Next scheduled cleanup: ${this.nextRun.toISOString()}`);
  }

  public start(): void {
    if (this.intervalId) {
      this.log('warn', 'Cache cleanup scheduler already started');
      return;
    }

    this.log('success', `Starting cache cleanup scheduler (every ${this.intervalHours} hours)`);
    
    // Run immediately on startup (after a short delay)
    setTimeout(async () => {
      await this.runCleanup();
    }, 30000); // 30 second delay

    // Schedule recurring runs
    this.intervalId = setInterval(async () => {
      await this.runCleanup();
    }, this.intervalHours * 60 * 60 * 1000);

    this.updateNextRunTime();
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.log('info', 'Cache cleanup scheduler stopped');
    }
  }

  public getStatus(): SchedulerStatus {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun ? this.lastRun.toISOString() : null,
      nextRun: this.nextRun ? this.nextRun.toISOString() : null,
      intervalHours: this.intervalHours,
      quietHoursEnabled: this.quietHoursEnabled,
      quietHoursRange: this.quietHoursRange
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
    scheduler.start();
    return scheduler;
  }
  return null;
}

export function stopCacheCleanupScheduler(): void {
  if (schedulerInstance) {
    schedulerInstance.stop();
  }
}

export { CacheCleanupScheduler };
export type { DashboardAPI, SchedulerStatus };
