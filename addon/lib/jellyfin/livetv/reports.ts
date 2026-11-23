// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { normaliseJellyfinId } from '../idsCodec';

export function isLiveItemId(id: unknown): boolean {
  if (typeof id !== 'string') return false;
  const hex = normaliseJellyfinId(id);
  if (!/^[0-9a-f]{32}$/.test(hex)) return false;
  return hex.startsWith('c4') || (hex.startsWith('b2') && hex.endsWith('00000000'));
}

export function reportItemId(req: any): string | undefined {
  const raw = req?.body?.ItemId ?? req?.body?.itemId ?? req?.params?.itemId;
  return raw ? String(raw) : undefined;
}

export function liveReportGuard(kind: 'report' | 'state', emptyUserData: Record<string, unknown>) {
  return (req: any, res: any, next: any): void => {
    const raw = reportItemId(req);
    if (!isLiveItemId(raw)) {
      next();
      return;
    }
    if (kind === 'report') {
      res.status(204).end();
      return;
    }
    const id = normaliseJellyfinId(raw!);
    res.status(200).json({ ...emptyUserData, Key: id, ItemId: id });
  };
}
