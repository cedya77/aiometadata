// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import { envInt } from '../../../utils/envNumber';

const MB = 1024 * 1024;

/** Memory for the manifests read, and as much again for those recalled after a restart. Read once, at start. */
export const manifestBytes = (): number => envInt('JELLYFIN_LIVETV_MANIFEST_MB', 64, 1) * MB;
export const manifestTtlMs = (): number => envInt('JELLYFIN_LIVETV_MANIFEST_TTL', 600, 30) * 1000;

/** Memory for every channel list held, of which one addon gets a quarter. Read once, at start. */
export const lineupBytes = (): number => envInt('JELLYFIN_LIVETV_LINEUP_MB', 256, 4) * MB;
export const lineupTtlMs = (): number => envInt('JELLYFIN_LIVETV_LINEUP_TTL', 3600, 60) * 1000;
/** Pages read of one live catalog, of the addon's own page size. */
export const maxPages = (): number => envInt('JELLYFIN_LIVETV_MAX_PAGES', 100, 1);
/** How long a request waits for a channel list still being read. */
export const listWaitMs = (): number => envInt('JELLYFIN_LIVETV_LIST_WAIT', 20, 1) * 1000;

/** Memory for the guide pages held. Read once, at start. */
export const guideBytes = (): number => envInt('JELLYFIN_LIVETV_GUIDE_MB', 128, 1) * MB;
export const guideTtlMs = (): number => envInt('JELLYFIN_LIVETV_GUIDE_TTL', 1800, 60) * 1000;
/** Channels a programme list covers when it names none. */
export const unnamedChannels = (): number => envInt('JELLYFIN_LIVETV_GUIDE_CHANNELS', 100, 1);
