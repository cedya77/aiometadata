import { Button } from '@/components/ui/button';
import { Loader2, Save } from 'lucide-react';
import { useSave } from '@/contexts/SaveContext';
import { navigateToSettingsSection } from '@/lib/settingsRoute';
import { cn } from '@/lib/utils';

/**
 * Lives in the sticky nav rather than the header, which scrolls away: sections are
 * long enough that save has to stay reachable without returning to the top.
 */
export function SidebarSaveButton() {
  const { requestSave, isSaving, isDirty, canSave, missingKeys, saveBlockedBy } = useSave();

  const blocked = !canSave && missingKeys.length > 0;
  const title = blocked
    ? `Missing required API keys: ${missingKeys.map(k => k.name).join(', ')}`
    : saveBlockedBy
      ? saveBlockedBy
      : isDirty
      ? 'Save your unsaved changes'
      : 'Save configuration';

  return (
    <div className="mt-3 border-t border-white/[0.06] pt-3">
      <Button
        onClick={requestSave}
        disabled={!canSave || isSaving}
        title={title}
        aria-label={title}
        className="relative w-full gap-2"
      >
        {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {isSaving ? 'Saving' : 'Save'}
        {isDirty && !isSaving && (
          <span
            className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-background"
            aria-hidden="true"
          />
        )}
      </Button>
      <p
        className={cn(
          'mt-2 text-center text-[11px] leading-tight',
          blocked || saveBlockedBy ? 'text-amber-400/80' : 'text-muted-foreground'
        )}
      >
        {blocked
          ? `Missing ${missingKeys.length} required key${missingKeys.length === 1 ? '' : 's'}`
          : saveBlockedBy
            ? <button type="button" className="underline underline-offset-2 hover:text-amber-300" onClick={() => navigateToSettingsSection('people')}>{saveBlockedBy} Fix in People</button>
          : isDirty
            ? 'You have unsaved changes'
            : isDirty === null
              ? 'Not saved yet'
              : 'All changes saved'}
      </p>
    </div>
  );
}
