// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// The database every module uses: the core store, with the v4 feature
// modules' tables and queries on top.
import { FeatureDatabase } from './featureDatabase';

export type { WatchPatch } from './databaseCore';

const database = new FeatureDatabase();

export default database;
module.exports = database;
