// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Past this the trip is taken in one jump. Animating thousands of pixels over a
 * list that measures rows as they mount is slow, and the shifting cancels the
 * animation anyway, so the smooth version reads as a stall rather than a scroll.
 */
const INSTANT_SCROLL_DISTANCE = 4000;
/** Frames of no upward progress before the remaining distance is taken at once. */
const SCROLL_STALL_FRAMES = 3;

interface ScrollToTopButtonProps {
  /** Pixels scrolled before the button appears. */
  threshold?: number;
  /** Suppresses the button while another floating surface owns the corner. */
  hidden?: boolean;
  className?: string;
  label?: string;
}

export function ScrollToTopButton({
  threshold = 600,
  hidden = false,
  className,
  label = 'Back to top',
}: ScrollToTopButtonProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      setVisible(window.scrollY > threshold);
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(read);
    };

    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [threshold]);

  const scrollToTop = () => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || window.scrollY > INSTANT_SCROLL_DISTANCE) {
      window.scrollTo({ top: 0, behavior: 'auto' });
      return;
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });

    // A list that measures its rows as they mount can shift layout mid-animation,
    // which cancels the scroll partway. Finish the trip the moment it stops
    // climbing, and hand control back as soon as the reader scrolls.
    let handedBack = false;
    let lastY = window.scrollY;
    let stalledFrames = 0;
    const release = () => { handedBack = true; };
    const events = ['wheel', 'touchstart', 'keydown'] as const;

    const cleanup = () => events.forEach(name => window.removeEventListener(name, release));
    events.forEach(name => window.addEventListener(name, release, { passive: true }));

    const step = () => {
      if (handedBack || window.scrollY <= 0) {
        cleanup();
        return;
      }
      stalledFrames = window.scrollY < lastY ? 0 : stalledFrames + 1;
      lastY = window.scrollY;
      if (stalledFrames > SCROLL_STALL_FRAMES) {
        window.scrollTo({ top: 0, behavior: 'auto' });
        cleanup();
        return;
      }
      window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  };

  return (
    <AnimatePresence>
      {visible && !hidden && (
        <motion.button
          type="button"
          onClick={scrollToTop}
          aria-label={label}
          title={label}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ type: 'spring', stiffness: 400, damping: 28 }}
          className={cn(
            'fixed right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full',
            'border border-border bg-primary text-primary-foreground shadow-lg',
            'transition-colors hover:bg-primary/90',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            // Clears the mobile save bar, which is fixed to the bottom on phones only.
            'bottom-[max(6rem,calc(env(safe-area-inset-bottom)+6rem))] md:bottom-6 md:right-6',
            className
          )}
        >
          <ArrowUp className="h-5 w-5" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}
