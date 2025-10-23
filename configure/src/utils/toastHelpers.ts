import { toast } from 'sonner';

/**
 * Toast helper functions for bulk catalog actions
 * Provides consistent messaging and duration for user feedback
 */

interface BulkActionResult {
  affectedCount: number;
  skippedCount?: number;
  skippedReason?: string;
}

/**
 * Show success toast for bulk enable action
 */
export function showBulkEnableSuccess(result: BulkActionResult) {
  const { affectedCount, skippedCount, skippedReason } = result;
  
  // Show success message if any catalogs were affected
  if (affectedCount > 0) {
    const message = `${affectedCount} catalog${affectedCount === 1 ? '' : 's'} enabled`;
    
    // If some were skipped, show combined message
    if (skippedCount && skippedCount > 0 && skippedReason) {
      toast.success(message, {
        description: `${skippedCount} catalog${skippedCount === 1 ? '' : 's'} skipped: ${skippedReason}`,
        duration: 4000
      });
    } else {
      toast.success(message, { duration: 3000 });
    }
  } else if (skippedCount && skippedCount > 0 && skippedReason) {
    // Only skipped items, no success
    toast.warning(
      `No catalogs enabled`,
      {
        description: `${skippedCount} catalog${skippedCount === 1 ? '' : 's'} skipped: ${skippedReason}`,
        duration: 4000
      }
    );
  } else {
    // All already enabled
    toast.info('All selected catalogs are already enabled', { duration: 3000 });
  }
}

/**
 * Show success toast for bulk disable action
 */
export function showBulkDisableSuccess(result: BulkActionResult) {
  const { affectedCount } = result;
  
  if (affectedCount > 0) {
    toast.success(
      `${affectedCount} catalog${affectedCount === 1 ? '' : 's'} disabled`,
      { duration: 3000 }
    );
  } else {
    toast.info('All selected catalogs are already disabled', { duration: 3000 });
  }
}

/**
 * Show success toast for bulk add to home action
 */
export function showBulkAddToHomeSuccess(result: BulkActionResult) {
  const { affectedCount, skippedCount } = result;
  
  // Show success message if any catalogs were affected
  if (affectedCount > 0) {
    const message = `${affectedCount} catalog${affectedCount === 1 ? '' : 's'} added to home`;
    
    // If some were skipped, show combined message
    if (skippedCount && skippedCount > 0) {
      toast.success(message, {
        description: `${skippedCount} disabled catalog${skippedCount === 1 ? '' : 's'} skipped (must be enabled first)`,
        duration: 4000
      });
    } else {
      toast.success(message, { duration: 3000 });
    }
  } else if (skippedCount && skippedCount > 0) {
    // Only skipped items, no success
    toast.warning(
      `No catalogs added to home`,
      {
        description: `${skippedCount} disabled catalog${skippedCount === 1 ? '' : 's'} skipped (must be enabled first)`,
        duration: 4000
      }
    );
  } else {
    // All already on home
    toast.info('All selected enabled catalogs are already on home', { duration: 3000 });
  }
}

/**
 * Show success toast for bulk remove from home action
 */
export function showBulkRemoveFromHomeSuccess(result: BulkActionResult) {
  const { affectedCount } = result;
  
  if (affectedCount > 0) {
    toast.success(
      `${affectedCount} catalog${affectedCount === 1 ? '' : 's'} removed from home`,
      { duration: 3000 }
    );
  } else {
    toast.info('All selected catalogs are already not on home', { duration: 3000 });
  }
}

/**
 * Show success toast for bulk delete action
 */
export function showBulkDeleteSuccess(result: BulkActionResult) {
  const { affectedCount, skippedCount } = result;
  
  // Show success message if any catalogs were deleted
  if (affectedCount > 0) {
    const message = `${affectedCount} catalog${affectedCount === 1 ? '' : 's'} deleted`;
    
    // If some were skipped, show combined message
    if (skippedCount && skippedCount > 0) {
      toast.success(message, {
        description: `${skippedCount} non-removable catalog${skippedCount === 1 ? '' : 's'} skipped (TMDB, TVDB, MAL cannot be deleted)`,
        duration: 4000
      });
    } else {
      toast.success(message, { duration: 3000 });
    }
  } else if (skippedCount && skippedCount > 0) {
    // Only skipped items, no success
    toast.warning(
      `No catalogs deleted`,
      {
        description: `${skippedCount} non-removable catalog${skippedCount === 1 ? '' : 's'} skipped (TMDB, TVDB, MAL cannot be deleted)`,
        duration: 4000
      }
    );
  }
}

/**
 * Show error toast for bulk action failures
 */
export function showBulkActionError(action: string, error?: Error) {
  toast.error(
    `Failed to ${action}`,
    {
      description: error?.message || 'An unexpected error occurred',
      duration: 5000
    }
  );
}

/**
 * Show warning toast for missing API keys
 */
export function showMissingApiKeyWarning(source: string, count: number) {
  toast.warning(
    `${count} ${source.toUpperCase()} catalog${count === 1 ? '' : 's'} skipped (missing ${source.toUpperCase()} API key)`,
    { duration: 4000 }
  );
}
