/** Phone widths, below the md breakpoint. */
const PHONE_QUERY = "(max-width: 767px)";

/** Whether a menu that asks to be a sheet comes up from the foot of the screen, which it does on a phone. */
export const sheetOnPhone = (): boolean => window.matchMedia(PHONE_QUERY).matches;

/** For a hand-made menu, placed inside an element marked data-sheet-wrap: the marks that make it a sheet on a phone. */
export const sheetProps = (): { "data-sheet"?: true; "data-state"?: "open" } => (sheetOnPhone() ? { "data-sheet": true, "data-state": "open" } : {});

/** How far a sheet is pulled down before letting go closes it. */
const CLOSE_AFTER = 90;
/** A flick this fast closes it from any distance, in pixels a millisecond. */
const CLOSE_FLICK = 0.6;

let sheet: HTMLElement | null = null;
let startY = 0;
let startAt = 0;
let pulled = 0;

const onStart = (event: TouchEvent) => {
  const target = event.target instanceof Element ? event.target : null;
  const found = target?.closest<HTMLElement>('[data-sheet][data-state="open"]') ?? null;
  if (!found || !sheetOnPhone() || event.touches.length !== 1) return;
  sheet = found;
  startY = event.touches[0].clientY;
  startAt = event.timeStamp;
  pulled = 0;
};

const onMove = (event: TouchEvent) => {
  if (!sheet) return;
  const down = event.touches[0].clientY - startY;
  // Only from the top of its own list, and only downwards; otherwise the list scrolls.
  const scroller = (event.target as Element).closest<HTMLElement>("[data-radix-select-viewport]");
  const atTop = sheet.scrollTop <= 0 && (!scroller || scroller.scrollTop <= 0);
  if (pulled === 0 && (down <= 0 || !atTop)) {
    if (down > 0 && sheet.scrollTop <= 0) event.preventDefault();
    return;
  }
  event.preventDefault();
  pulled = Math.max(0, down);
  sheet.style.transition = "none";
  sheet.style.transform = `translateY(${pulled}px)`;
};

const onRelease = (event: TouchEvent) => {
  const current = sheet;
  sheet = null;
  if (!current || pulled === 0) return;
  const speed = pulled / Math.max(1, event.timeStamp - startAt);
  current.style.transition = "transform 260ms cubic-bezier(0.32, 0.72, 0, 1)";
  if (pulled > CLOSE_AFTER || speed > CLOSE_FLICK) {
    current.style.transform = "translateY(110%)";
    current.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  } else {
    current.style.transform = "";
  }
  pulled = 0;
};

let held = false;

const hold = (on: boolean) => {
  if (on === held) return;
  held = on;
  if (on) {
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onRelease, { passive: true });
    document.addEventListener("touchcancel", onRelease, { passive: true });
  } else {
    document.removeEventListener("touchstart", onStart);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onRelease);
    document.removeEventListener("touchcancel", onRelease);
    sheet = null;
    pulled = 0;
  }
};

let installed = false;

/**
 * A sheet follows a finger pulling it down from its top, and closes when let go far enough or fast enough.
 * The page's touches are held only while a sheet is up, so scrolling never waits on them.
 */
export function installSheetSwipe(): void {
  if (installed) return;
  installed = true;
  new MutationObserver(() => hold(sheetOnPhone() && document.querySelector("[data-sheet]") !== null)).observe(document.body, { childList: true });
}
