// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
/**
 * Providers reject a redirect URI without a scheme, and the deployments that
 * configure one by bare host are the ones that trip over it. Assume https,
 * since every provider we talk to refuses plain http anyway.
 */
export function normalizeRedirectUri(uri: string): string {
  if (!uri) return uri;
  const trimmed = uri.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return `https://${trimmed.replace(/^\/+/, '')}`;
}
