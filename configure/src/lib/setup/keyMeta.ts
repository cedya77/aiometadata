// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { RequiredKeyId } from './types';

export const KEY_META: Record<RequiredKeyId, { label: string; short: string; placeholder: string; url: string }> = {
  tmdb: {
    label: 'TMDB key',
    short: 'TMDB',
    placeholder: 'Paste your TMDB API key',
    url: 'https://www.themoviedb.org/settings/api',
  },
  tvdb: {
    label: 'TVDB key',
    short: 'TVDB',
    placeholder: 'Paste your TVDB API key',
    url: 'https://thetvdb.com/api-information',
  },
  mdblist: {
    label: 'MDBList key',
    short: 'MDBList',
    placeholder: 'Paste your MDBList API key',
    url: 'https://mdblist.com/preferences/',
  },
};
