// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { hashFor, parseRoute, type SettingsSectionId } from '@/lib/settingsRoute';

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener('hashchange', onStoreChange);
  return () => window.removeEventListener('hashchange', onStoreChange);
}

function getSnapshot(): string {
  return window.location.hash;
}

function getServerSnapshot(): string {
  return '';
}

export function useSettingsRoute(): {
  section: SettingsSectionId;
  anchor: string | null;
  navigate: (id: SettingsSectionId, anchor?: string | null) => void;
  focusNonce: number;
  refocus: () => void;
} {
  const hash = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { section, anchor } = parseRoute(hash);
  const [focusNonce, setFocusNonce] = useState(0);
  const bump = useRef(() => setFocusNonce((n) => n + 1));

  const navigate = useCallback((id: SettingsSectionId, target?: string | null) => {
    const next = hashFor(id, target);
    if (window.location.hash === next) return;
    window.location.hash = next;
  }, []);

  return { section, anchor, navigate, focusNonce, refocus: bump.current };
}
