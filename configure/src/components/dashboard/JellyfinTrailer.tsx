import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Maximize, Minimize } from "lucide-react";
import { cx } from "./titleHelpers";
import { youtubeEmbedUrl, type RemoteTrailer } from "./trailers";

/** A title's trailer over the whole screen: in the page for a direct link, in YouTube's own player for YouTube. It leaves when it ends. */
export function TrailerPlayer({ title, trailer, onClose }: { title: string; trailer: RemoteTrailer; onClose: () => void }) {
  // Back closes the trailer before it leaves the title page.
  const leave = useRef(onClose);
  leave.current = onClose;
  useEffect(() => {
    window.history.pushState({ ...window.history.state, trailer: true }, "");
    const onPop = () => leave.current();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const back = useCallback(() => window.history.back(), []);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`${title} trailer`} className="fixed inset-0 z-[125]">
      {trailer.kind === "youtube" && trailer.youtubeId ? (
        <Shell onBack={back} autoHide="frame">
          <YouTubeTrailer id={trailer.youtubeId} title={title} onEnded={back} />
        </Shell>
      ) : (
        <Shell onBack={back} autoHide="page">
          <video src={trailer.url} autoPlay controls controlsList="nofullscreen" playsInline onEnded={back} className="absolute inset-0 size-full bg-black object-contain" />
        </Shell>
      )}
    </div>,
    document.body,
  );
}

/** A YouTube trailer that leaves when it ends, before YouTube's end screen of other videos. */
function YouTubeTrailer({ id, title, onEnded }: { id: string; title: string; onEnded: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ended = useRef(onEnded);
  ended.current = onEnded;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || typeof event.data !== "string") return;
      let data: { event?: string; info?: { playerState?: number } | number };
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      const state = data.event === "infoDelivery" && typeof data.info === "object"
        ? data.info?.playerState
        : data.event === "onStateChange" && typeof data.info === "number"
          ? data.info
          : undefined;
      if (state === 0) ended.current();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      ref={frame}
      src={youtubeEmbedUrl(id)}
      title={title}
      allow="autoplay; encrypted-media; picture-in-picture"
      referrerPolicy="strict-origin-when-cross-origin"
      onLoad={() => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: "listening", id, channel: "widget" }), "*")}
      className="absolute inset-0 size-full border-0"
    />
  );
}

/** How long the pointer rests before Back, full screen and the cursor step aside. */
const IDLE_MS = 3000;

/**
 * The page around a trailer: black, with Back and full screen at the top centre, clear of the corners a trailer's own
 * player puts its logo and buttons in. Esc leaves full screen, then the trailer. While a trailer plays they hide with
 * the cursor when the pointer rests. A page sees no pointer over YouTube's frame, so for `frame` a clear layer covers it
 * while they are hidden: it hides the cursor there and takes the movement or tap that brings them back.
 */
function Shell({ onBack, children, autoHide }: { onBack: () => void; children: React.ReactNode; autoHide?: "page" | "frame" }) {
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef(0);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    if (autoHide) idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  }, [autoHide]);

  useEffect(() => {
    if (!autoHide) return;
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
    window.addEventListener("pointermove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("keydown", wake);
      window.clearTimeout(idleTimer.current);
    };
  }, [autoHide, wake]);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    // Captured, so Esc never reaches the title page beneath.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else onBack();
    };
    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      window.removeEventListener("keydown", onKey, true);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [onBack]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  };
  const button = "inline-flex items-center justify-center gap-2 rounded-full bg-black/70 text-sm font-medium text-white shadow-lg ring-1 ring-white/25 backdrop-blur transition-colors hover:bg-black/85";

  return (
    <div className={cx("relative flex h-dvh w-full items-center justify-center overflow-hidden bg-black text-white", idle && "cursor-none")}>
      {children}
      {autoHide === "frame" && idle && <div aria-hidden className="absolute inset-0 z-[5] cursor-none" onClick={wake} />}
      <div className={cx("absolute left-1/2 top-[calc(1rem+env(safe-area-inset-top))] z-10 flex -translate-x-1/2 items-center gap-2 transition-opacity duration-300", idle && "pointer-events-none opacity-0")}>
        <button type="button" onClick={onBack} className={cx(button, "h-10 px-5")}>
          <ArrowLeft className="size-4" />
          Back
        </button>
        {/* An iPhone has no page full screen; turning it sideways fills the screen already. */}
        {document.fullscreenEnabled && (
          <button type="button" aria-label={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen} className={cx(button, "size-10")}>
            {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
          </button>
        )}
      </div>
    </div>
  );
}
