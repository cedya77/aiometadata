// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
function isMetricsDisabled(): boolean {
  return process.env.DISABLE_METRICS === 'true';
}

export { isMetricsDisabled };
module.exports = { isMetricsDisabled };
