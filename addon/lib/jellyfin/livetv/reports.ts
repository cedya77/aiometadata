// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { isLiveJellyfinId, normaliseJellyfinId } from '../idsCodec';

export function reportItemId(req: any): string | undefined {
  const raw = req?.body?.ItemId ?? req?.body?.itemId ?? req?.params?.itemId;
  return raw ? String(raw) : undefined;
}

export function liveReportGuard(kind: 'report' | 'state', emptyUserData: Record<string, unknown>) {
  return (req: any, res: any, next: any): void => {
    const raw = reportItemId(req);
    if (!isLiveJellyfinId(raw)) {
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
