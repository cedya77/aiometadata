import type { KeyboardEvent } from 'react';

const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Arrow keys move the choice between the radios inside a radiogroup, as a native radio group does. */
export function moveRadio(event: KeyboardEvent<HTMLElement>): void {
  const step = STEPS[event.key];
  if (!step) return;
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])'));
  const at = radios.indexOf(document.activeElement as HTMLElement);
  if (at === -1) return;
  event.preventDefault();
  const next = radios[(at + step + radios.length) % radios.length];
  next.focus();
  next.click();
}

/** Only the checked radio, or the first when none is, takes a Tab stop. */
export function radioTabIndex(checked: boolean, index: number, anyChecked: boolean): number {
  return checked || (!anyChecked && index === 0) ? 0 : -1;
}
