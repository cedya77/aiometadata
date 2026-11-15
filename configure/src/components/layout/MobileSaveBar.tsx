import { Button } from '@/components/ui/button';
import { Loader2, Save } from 'lucide-react';
import { useSave } from '@/contexts/SaveContext';
import { navigateToSettingsSection } from '@/lib/settingsRoute';

/**
 * The header scrolls away and sections run long on phones, so the header's save
 * button is unreachable exactly when it is needed. This surfaces one while there is
 * something to save; SettingsLayout reserves the space it occupies.
 */
export function MobileSaveBar() {
  const { requestSave, isSaving, isDirty, canSave, missingKeys, saveBlockedBy } = useSave();

  // isDirty is null before a first save, which still warrants the bar: that is the
  // onboarding path, where the header's icon-only button is the least discoverable.
  if (isDirty === false && !isSaving) return null;

  const blocked = !canSave && (missingKeys.length > 0 || saveBlockedBy !== null);
  const neverSaved = isDirty === null;

  return (
    <>
      {/* Keeps the bar from covering the section nav at the end of the page. */}
      <div aria-hidden="true" className="h-20" />
      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-white/[0.08] bg-background/95 backdrop-blur-sm px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">
              {blocked ? 'Cannot save yet' : neverSaved ? 'Not saved yet' : 'Unsaved changes'}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {blocked
                ? missingKeys.length
                  ? `Missing: ${missingKeys.map(k => k.name).join(', ')}`
                  : <button type="button" className="underline underline-offset-2" onClick={() => navigateToSettingsSection('people')}>{saveBlockedBy} Fix in People</button>
                : neverSaved
                  ? 'Save to get your install link.'
                  : 'Save to apply them to your addon.'}
            </div>
          </div>
          <Button onClick={requestSave} disabled={!canSave || isSaving} className="shrink-0 gap-2">
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {isSaving ? 'Saving' : 'Save'}
          </Button>
        </div>
      </div>
    </>
  );
}
