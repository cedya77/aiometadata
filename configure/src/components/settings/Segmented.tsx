import { moveRadio, radioTabIndex } from '@/lib/radioKeys';
import { cn } from '@/lib/utils';

export function Segmented<T extends string | boolean>({ id, label, value, options, onChange, disabled, className }: {
  id?: string;
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div id={id} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} onKeyDown={moveRadio} className={cn('flex gap-1 rounded-lg border bg-card p-1 sm:inline-flex', disabled && 'opacity-60', className)}>
      {options.map(([option, text], index) => (
        <button
          key={text}
          type="button"
          role="radio"
          aria-checked={value === option}
          tabIndex={radioTabIndex(value === option, index, options.some(([o]) => o === value))}
          disabled={disabled}
          onClick={() => onChange(option)}
          className={cn(
            'flex-1 whitespace-nowrap rounded-md px-2 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed sm:flex-none sm:px-4',
            value === option ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
