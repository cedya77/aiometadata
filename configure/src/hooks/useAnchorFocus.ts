import { useEffect, type RefObject } from 'react';

const DEADLINE_MS = 3000;
const HIGHLIGHT_MS = 1600;

function resolve(anchor: string): HTMLElement | null {
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(anchor) : anchor;
  let matches: HTMLElement[] = [];
  try {
    matches = Array.from(document.querySelectorAll<HTMLElement>(`[data-setting="${escaped}"]`));
  } catch {
    matches = [];
  }
  if (matches.length === 0) {
    const byId = document.getElementById(anchor);
    if (byId) matches = [byId];
  }
  if (matches.length === 0) return null;
  return matches.find((el) => el.offsetParent !== null) ?? matches[0];
}

export function revealSetting(element: HTMLElement): void {
  if (element.contains(document.activeElement)) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const box = element.getBoundingClientRect();
  if (box.top < 0 || box.bottom > window.innerHeight) element.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });

  element.setAttribute('data-settings-highlight', '');
  window.setTimeout(() => element.removeAttribute('data-settings-highlight'), HIGHLIGHT_MS);

  const focusable = element.matches('input, select, textarea, button, [tabindex]')
    ? element
    : element.querySelector<HTMLElement>('input, select, textarea, button, [tabindex]');
  focusable?.focus({ preventScroll: true });
}

export function useAnchorFocus(
  anchor: string | null,
  nonce: number,
  containerRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!anchor) return;

    const immediate = resolve(anchor);
    if (immediate) { revealSetting(immediate); return; }

    const root = containerRef.current ?? document.body;
    let done = false;
    let timer = 0;

    const observer = new MutationObserver(() => {
      if (done) return;
      const element = resolve(anchor);
      if (!element) return;
      done = true;
      observer.disconnect();
      window.clearTimeout(timer);
      revealSetting(element);
    });
    observer.observe(root, { childList: true, subtree: true });

    timer = window.setTimeout(() => {
      done = true;
      observer.disconnect();
      if (import.meta.env.DEV) {
        console.debug(`[settings-search] anchor "${anchor}" never appeared`);
      }
    }, DEADLINE_MS);

    return () => {
      done = true;
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [anchor, nonce, containerRef]);
}
