// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
'use strict';

function baseUrlFrom(hostEnv, requestHost) {
  if (hostEnv) {
    return hostEnv.startsWith('http') ? hostEnv : `https://${hostEnv}`;
  }
  return `https://${requestHost}`;
}

function buildInstallUrl(hostEnv, requestHost, identifier) {
  return `${baseUrlFrom(hostEnv, requestHost)}/stremio/${identifier}/manifest.json`;
}

module.exports = { baseUrlFrom, buildInstallUrl };
