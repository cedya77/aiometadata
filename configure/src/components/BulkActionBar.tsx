import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { X, MoreHorizontal, Power, PowerOff, Home, HomeIcon, Trash2, Loader2, Star, Shuffle } from 'lucide-react';
import { CatalogConfig } from '@/contexts/config';
import { cn } from '@/lib/utils';

type BulkActionType =
  | 'enable'
  | 'disable'
  | 'addToHome'
  | 'removeFromHome'
  | 'delete'
  | 'invert'
  | 'enableRPDB'
  | 'disableRPDB'
  | 'enableRandomize'
  | 'disableRandomize'
  | null;

interface BulkActionBarProps {
  selectedCatalogs: CatalogConfig[];
  onEnableSelected: () => void;
  onDisableSelected: () => void;
  onAddToHome: () => void;
  onRemoveFromHome: () => void;
  onDeleteSelected: () => void;
  onInvertSelection: () => void;
  onClearSelection: () => void;
  onEnableRPDB?: () => void;
  onDisableRPDB?: () => void;
  onEnableRandomize?: () => void;
  onDisableRandomize?: () => void;
  hasRPDBKey?: boolean;
  isLoading?: boolean;
  loadingAction?: BulkActionType;
}

export function BulkActionBar({
  selectedCatalogs,
  onEnableSelected,
  onDisableSelected,
  onAddToHome,
  onRemoveFromHome,
  onDeleteSelected,
  onInvertSelection,
  onClearSelection,
  onEnableRPDB,
  onDisableRPDB,
  onEnableRandomize,
  onDisableRandomize,
  hasRPDBKey = false,
  isLoading = false,
  loadingAction = null,
}: BulkActionBarProps) {
  const selectionCount = selectedCatalogs.length;

  // Determine which actions are applicable
  const hasDisabledCatalogs = selectedCatalogs.some(c => !c.enabled);
  const hasEnabledCatalogs = selectedCatalogs.some(c => c.enabled);
  const hasNotInHome = selectedCatalogs.some(c => !c.showInHome);
  const hasInHome = selectedCatalogs.some(c => c.showInHome);
  const hasRemovableCatalogs = selectedCatalogs.some(c => 
    ['mdblist', 'streaming', 'stremthru', 'custom'].includes(c.source)
  );
  const hasRPDBDisabled = selectedCatalogs.some(c => c.enableRPDB === false);
  const hasRPDBEnabled = selectedCatalogs.some(c => c.enableRPDB !== false);
  const hasRandomizeDisabled = selectedCatalogs.some(c => !c.randomizePerPage);
  const hasRandomizeEnabled = selectedCatalogs.some(c => c.randomizePerPage);
  
  // Count non-removable catalogs for tooltip
  const nonRemovableCount = selectedCatalogs.filter(c => 
    !['mdblist', 'streaming', 'stremthru', 'custom'].includes(c.source)
  ).length;

  // Don't render if no items selected
  if (selectionCount === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        // Desktop: sticky at top
        "md:sticky md:top-0 z-10 bg-background border-b shadow-md",
        // Mobile: fixed at bottom (bottom sheet pattern)
        "fixed bottom-0 left-0 right-0 md:relative",
        // Slide-down animation with 200ms ease-out
        "animate-slide-down",
        "px-4 py-3 md:py-3",
        // Ensure proper spacing on mobile
        "pb-safe"
      )}
      role="region"
      aria-label="Bulk actions"
      aria-live="polite"
      aria-busy={isLoading}
    >
      <div className="flex flex-col gap-3">
        {/* Selection counter and clear button */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium animate-fade-in">
            {selectionCount} {selectionCount === 1 ? 'item' : 'items'} selected
          </span>
          {/* Clear Selection - always visible on mobile */}
          <Button
            size="sm"
            variant="ghost"
            onClick={onClearSelection}
            disabled={isLoading}
            aria-label="Clear selection"
            className="md:hidden"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Action buttons */}
        <TooltipProvider>
          <div className="flex flex-col md:flex-row md:flex-wrap items-stretch md:items-center gap-2">
            {/* Enable Selected */}
            {hasDisabledCatalogs && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onEnableSelected}
                    disabled={isLoading}
                    aria-label="Enable selected catalogs"
                    className="w-full md:w-auto justify-start md:justify-center min-h-[44px] md:min-h-0"
                  >
                    {loadingAction === 'enable' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Power className="h-4 w-4" />
                    )}
                    <span className="ml-2">Enable Selected</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Enable all selected disabled catalogs</p>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Disable Selected */}
            {hasEnabledCatalogs && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onDisableSelected}
                    disabled={isLoading}
                    aria-label="Disable selected catalogs"
                    className="w-full md:w-auto justify-start md:justify-center min-h-[44px] md:min-h-0"
                  >
                    {loadingAction === 'disable' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PowerOff className="h-4 w-4" />
                    )}
                    <span className="ml-2">Disable Selected</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Disable all selected enabled catalogs</p>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Add to Home */}
            {hasNotInHome && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onAddToHome}
                    disabled={isLoading}
                    aria-label="Add selected catalogs to home"
                    className="w-full md:w-auto justify-start md:justify-center min-h-[44px] md:min-h-0"
                  >
                    {loadingAction === 'addToHome' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Home className="h-4 w-4" />
                    )}
                    <span className="ml-2">Add to Home</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Add selected enabled catalogs to home board</p>
                  {selectedCatalogs.some(c => !c.enabled) && (
                    <p className="text-xs text-muted-foreground mt-1">
                      (Disabled catalogs will be skipped)
                    </p>
                  )}
                </TooltipContent>
              </Tooltip>
            )}

            {/* Remove from Home */}
            {hasInHome && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onRemoveFromHome}
                    disabled={isLoading}
                    aria-label="Remove selected catalogs from home"
                    className="w-full md:w-auto justify-start md:justify-center min-h-[44px] md:min-h-0"
                  >
                    {loadingAction === 'removeFromHome' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <HomeIcon className="h-4 w-4" />
                    )}
                    <span className="ml-2">Remove from Home</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Remove selected catalogs from home board</p>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Enable RPDB for Selected */}
            {hasRPDBKey && hasRPDBDisabled && onEnableRPDB && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onEnableRPDB}
                    disabled={isLoading}
                    aria-label="Enable RPDB for selected catalogs"
                    className="w-full md:w-auto justify-start md:justify-center min-h-[44px] md:min-h-0"
                  >
                    {loadingAction === 'enableRPDB' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Star className="h-4 w-4 text-yellow-500" />
                    )}
                    <span className="ml-2">Enable RPDB</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Enable RPDB for selected catalogs</p>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Enable Randomize */}
            {hasRandomizeDisabled && onEnableRandomize && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onEnableRandomize}
                    disabled={isLoading}
                    aria-label="Enable random order for selected catalogs"
                    className="w-full md:w-auto justify-start md:justify-center min-h-[44px] md:min-h-0"
                  >
                    {loadingAction === 'enableRandomize' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Shuffle className="h-4 w-4 text-purple-500" />
                    )}
                    <span className="ml-2">Enable Randomize</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Randomize items within each page for selected catalogs</p>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Disable Randomize */}
            {hasRandomizeEnabled && onDisableRandomize && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onDisableRandomize}
                    disabled={isLoading}
                    aria-label="Disable random order for selected catalogs"
                    className="w-full md:w-auto justify-start md:justify-center min-h-[44px] md:min-h-0"
                  >
                    {loadingAction === 'disableRandomize' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Shuffle className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="ml-2">Disable Randomize</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Restore original ordering for selected catalogs</p>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Disable RPDB for Selected */}
            {hasRPDBKey && hasRPDBEnabled && onDisableRPDB && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onDisableRPDB}
                    disabled={isLoading}
                    aria-label="Disable RPDB for selected catalogs"
                    className="w-full md:w-auto justify-start md:justify-center min-h-[44px] md:min-h-0"
                  >
                    {loadingAction === 'disableRPDB' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Star className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="ml-2">Disable RPDB</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Disable RPDB for selected catalogs</p>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Delete Selected */}
            {hasRemovableCatalogs && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={onDeleteSelected}
                    disabled={isLoading}
                    aria-label="Delete selected catalogs"
                    className="w-full md:w-auto justify-start md:justify-center min-h-[44px] md:min-h-0"
                  >
                    {loadingAction === 'delete' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    <span className="ml-2">Delete Selected</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Delete selected removable catalogs</p>
                  {nonRemovableCount > 0 && (
                    <p className="text-xs text-muted-foreground mt-1">
                      ({nonRemovableCount} non-removable catalog{nonRemovableCount === 1 ? '' : 's'} will be skipped)
                    </p>
                  )}
                </TooltipContent>
              </Tooltip>
            )}

            {/* More dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isLoading}
                  aria-label="More actions"
                  className="w-full md:w-auto justify-start md:justify-center min-h-[44px] md:min-h-0"
                >
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="ml-2">More</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onInvertSelection} disabled={isLoading}>
                  {loadingAction === 'invert' && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Invert Selection
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Clear Selection - desktop only */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onClearSelection}
                  disabled={isLoading}
                  aria-label="Clear selection"
                  className="hidden md:inline-flex"
                >
                  <X className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Clear selection</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>
    </div>
  );
}
