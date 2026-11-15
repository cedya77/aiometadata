// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useState, useEffect } from 'react';

// Define the breakpoint directly in your application code.
// The default Tailwind `md` breakpoint is 768px.
// If you've customized this in your tailwind.config.ts, make sure this value matches.
const MOBILE_BREAKPOINT = 768;

/**
 * A custom hook that returns true if the current screen width is below
 * the mobile breakpoint (768px).
 */
export function useBreakpoint() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < MOBILE_BREAKPOINT);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };

    window.addEventListener('resize', handleResize);
    // Cleanup the event listener when the component unmounts
    return () => window.removeEventListener('resize', handleResize);
  }, []); // Empty dependency array ensures this effect runs only on mount and unmount

  return { isMobile };
}
