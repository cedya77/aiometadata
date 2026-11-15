import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Pause, X } from "lucide-react";
import { YEAR_STORY } from "./yearStory";
import type { YearModel } from "./yearModel";

const SLIDE_MS = 7000;
const HOLD_MS = 180;
const SWIPE_PX = 50;
const CLOSE_DRAG_PX = 110;
const BACK_SHARE = 0.3;
const ROUND_BUTTON = "flex size-10 items-center justify-center rounded-full bg-white/[0.08] text-[#f4f5f7] backdrop-blur-xl transition-colors hover:bg-white/[0.16]";

interface Press {
  x: number;
  y: number;
  timer: number;
}

/** The year as tap-through slides, full screen on phones and a phone-shaped frame on wider screens. */
export default function YearStory({ model, owner, onClose, onShare }: { model: YearModel; owner: string; onClose: () => void; onShare: () => void }) {
  const slides = useMemo(() => YEAR_STORY.filter((slide) => !slide.shows || slide.shows(model)), [model]);
  const [index, setIndex] = useState(0);
  const [round, setRound] = useState(0);
  const [held, setHeld] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [drag, setDrag] = useState(0);
  const press = useRef<Press | null>(null);
  const heldNow = useRef(false);
  const frame = useRef<HTMLDivElement>(null);
  const last = slides.length - 1;
  const paused = held || stopped || hidden;

  const next = useCallback(() => (index >= last ? onClose() : setIndex(index + 1)), [index, last, onClose]);
  const back = useCallback(() => setIndex((at) => Math.max(0, at - 1)), []);
  const replay = useCallback(() => {
    setIndex(0);
    setRound((n) => n + 1);
  }, []);

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    for (const src of slides[index + 1]?.art?.(model) ?? []) {
      if (!src) continue;
      const image = new Image();
      image.decoding = "async";
      image.src = src;
    }
  }, [index, slides, model]);

  const release = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    heldNow.current = false;
    setHeld(false);
    setDrag(0);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button, a")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = {
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        heldNow.current = true;
        setHeld(true);
      }, HOLD_MS),
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!press.current || event.pointerType === "mouse") return;
    setDrag(Math.max(0, event.clientY - press.current.y));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = press.current;
    const wasHeld = heldNow.current;
    release();
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (dy > CLOSE_DRAG_PX && dy > Math.abs(dx)) return onClose();
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) return dx < 0 ? next() : back();
    if (wasHeld || Math.abs(dx) > SWIPE_PX || Math.abs(dy) > SWIPE_PX) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX - box.left < box.width * BACK_SHARE) back();
    else next();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const onButton = (event.target as Element).closest("button, a");
    if (event.key === "ArrowRight" || event.key === "PageDown" || (event.key === "Enter" && !onButton)) next();
    else if (event.key === "ArrowLeft" || event.key === "PageUp") back();
    else if (event.key === " " && !onButton) setStopped((now) => !now);
    else if (event.key === "Backspace" || event.key === "BrowserBack" || event.key === "GoBack") onClose();
    else return;
    event.preventDefault();
  };

  const { Slide, key, label } = slides[index];
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xl animate-in fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => { event.preventDefault(); frame.current?.focus(); }}
          onKeyDown={onKeyDown}
          className="fixed inset-0 z-50 flex items-center justify-center outline-none animate-in fade-in-0 zoom-in-95 duration-300"
        >
          <DialogPrimitive.Title className="sr-only">{owner}'s {model.year} year in review</DialogPrimitive.Title>
          <button type="button" onClick={back} disabled={index === 0} aria-label="Previous" className={`${ROUND_BUTTON} mr-6 hidden disabled:opacity-0 sm:flex`}><ChevronLeft className="size-5" /></button>
          <div
            ref={frame}
            tabIndex={-1}
            aria-roledescription="story"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={release}
            onContextMenu={(event) => event.preventDefault()}
            className="relative isolate h-[100dvh] w-full touch-none select-none overflow-hidden [container-type:size] bg-[#0c0d0f] text-[#f4f5f7] outline-none sm:aspect-[390/844] sm:h-[min(92dvh,900px)] sm:w-auto sm:rounded-[40px] sm:shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.08)]"
            style={{ transform: drag ? `translateY(${drag}px) scale(${1 - Math.min(drag, 400) / 2000})` : undefined, transition: drag ? "none" : "transform 300ms ease", borderRadius: drag ? 32 : undefined }}
          >
            <div key={`${round}-${key}`} className="absolute inset-0 isolate">
              <Slide model={model} owner={owner} onShare={onShare} onReplay={replay} />
            </div>
            <div className={`absolute inset-x-0 top-0 z-10 transition-opacity duration-200 ${held ? "opacity-0" : ""}`}>
              <div className="flex gap-1 px-4 pt-[max(14px,env(safe-area-inset-top))]">
                {slides.map((slide, i) => (
                  <span key={slide.key} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/25">
                    {i < index && <span className="block h-full rounded-full bg-white/95" />}
                    {i === index && (
                      <span
                        key={`${round}-${i}`}
                        className="block h-full origin-left animate-story-fill rounded-full bg-white/95"
                        style={{ animationDuration: `${SLIDE_MS}ms`, animationPlayState: paused ? "paused" : "running" }}
                        onAnimationEnd={() => { if (index < last) setIndex(index + 1); }}
                      />
                    )}
                  </span>
                ))}
              </div>
              <div className="flex items-center justify-end gap-2 px-3 pt-2.5">
                {stopped && <span className={`${ROUND_BUTTON} pointer-events-none`} aria-hidden="true"><Pause className="size-4" /></span>}
                <button type="button" onClick={onClose} aria-label="Close" className={ROUND_BUTTON}><X className="size-5" /></button>
              </div>
            </div>
            <p className="sr-only" aria-live="polite">{`${label}, ${index + 1} of ${slides.length}`}</p>
          </div>
          <button type="button" onClick={next} aria-label={index === last ? "Close" : "Next"} className={`${ROUND_BUTTON} ml-6 hidden sm:flex`}><ChevronRight className="size-5" /></button>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
