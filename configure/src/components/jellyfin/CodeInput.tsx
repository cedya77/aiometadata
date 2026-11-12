import { Fragment, useImperativeHandle, useRef, type ClipboardEvent, type KeyboardEvent, type Ref } from 'react';
import { CODE_LENGTH } from '@/lib/jellyfinClient';
import { cn } from '@/lib/utils';

export interface CodeInputHandle {
  focus: (index?: number) => void;
}

export function CodeInput({ ref, id, value, onChange, onComplete, disabled, busy, invalid, label = 'Quick Connect code' }: {
  ref?: Ref<CodeInputHandle>;
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  onComplete?: (code: string) => void;
  disabled?: boolean;
  busy?: boolean;
  invalid?: boolean;
  label?: string;
}) {
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const focusBox = (index: number) => {
    const box = boxes.current[Math.max(0, Math.min(CODE_LENGTH - 1, index))];
    box?.focus();
    box?.select();
  };
  useImperativeHandle(ref, () => ({ focus: (index = 0) => focusBox(index) }), []);

  const commit = (next: string[], whole: boolean) => {
    onChange(next);
    if (next.every(Boolean) && (whole || !value.every(Boolean))) onComplete?.(next.join(''));
  };

  const spread = (from: number, digits: string) => {
    if (!digits) return;
    const start = digits.length >= CODE_LENGTH ? 0 : from;
    const next = [...value];
    let at = start;
    for (const digit of digits.slice(0, CODE_LENGTH - start)) next[at++] = digit;
    commit(next, digits.length >= CODE_LENGTH);
    focusBox(Math.min(at, CODE_LENGTH - 1));
  };

  const onInput = (index: number, raw: string) => {
    if (busy) return;
    const digits = raw.replace(/\D/g, '');
    if (!digits) {
      const next = [...value];
      next[index] = '';
      onChange(next);
      return;
    }
    const typed = value[index] && digits.length === 2 ? (digits.startsWith(value[index]) ? digits[1] : digits[0]) : digits;
    spread(index, typed);
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (busy && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Tab') {
      event.preventDefault();
      return;
    }
    if (event.key === 'Backspace' && !value[index] && index > 0) {
      event.preventDefault();
      const next = [...value];
      next[index - 1] = '';
      onChange(next);
      focusBox(index - 1);
    } else if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      focusBox(index - 1);
    } else if (event.key === 'ArrowRight' && index < CODE_LENGTH - 1) {
      event.preventDefault();
      focusBox(index + 1);
    } else if (event.key === 'Enter' && value.every(Boolean)) {
      event.preventDefault();
      onComplete?.(value.join(''));
    }
  };

  const onPaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    if (busy) return;
    spread(index, event.clipboardData.getData('text').replace(/\D/g, ''));
  };

  return (
    <div role="group" aria-label={label} aria-busy={busy || undefined} className="flex items-center gap-1 sm:gap-1.5">
      {value.map((digit, index) => (
        <Fragment key={index}>
          {index === CODE_LENGTH / 2 ? <span className="w-2 shrink-0 text-center text-muted-foreground" aria-hidden="true">-</span> : null}
          <input
            ref={(el) => { boxes.current[index] = el; }}
            id={index === 0 ? id : undefined}
            value={digit}
            inputMode="numeric"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            disabled={disabled}
            readOnly={busy}
            aria-label={`Digit ${index + 1} of ${CODE_LENGTH}`}
            aria-invalid={invalid || undefined}
            onChange={(e) => onInput(index, e.target.value)}
            onKeyDown={(e) => onKeyDown(index, e)}
            onPaste={(e) => onPaste(index, e)}
            onFocus={(e) => e.target.select()}
            className={cn(
              'h-10 w-8 shrink-0 rounded-md border bg-background text-center font-mono text-base tabular-nums outline-none transition-colors sm:h-11 sm:w-10',
              'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
              invalid && 'border-destructive/70',
              busy && 'opacity-60',
            )}
          />
        </Fragment>
      ))}
    </div>
  );
}
