import { MERGE_MODES, type MergeMode } from '@shared/mergeModes';

/** The merge modes as a set of choices, wherever several catalogs combine into one. */
export function MergeModePicker({
  value,
  onChange,
  labelledBy,
  className = 'flex gap-2',
}: {
  value: MergeMode;
  onChange: (mode: MergeMode) => void;
  labelledBy?: string;
  className?: string;
}) {
  return (
    <div role="group" aria-labelledby={labelledBy} className={className}>
      {MERGE_MODES.map(mode => (
        <button
          key={mode.id}
          type="button"
          aria-pressed={value === mode.id}
          onClick={() => onChange(mode.id)}
          className={`flex-1 rounded-md border p-2.5 text-left transition-colors ${
            value === mode.id
              ? 'border-primary bg-primary/10'
              : 'border-border hover:border-primary/50'
          }`}
        >
          <p className="text-sm font-medium">{mode.label}</p>
          <p className="text-xs text-muted-foreground">{mode.description}</p>
        </button>
      ))}
    </div>
  );
}
