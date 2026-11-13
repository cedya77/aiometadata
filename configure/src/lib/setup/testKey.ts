// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { RequiredKeyId } from './types';

export type KeyTestResult =
  | { status: 'valid' }
  | { status: 'invalid'; message: string }
  | { status: 'timeout'; message: string }
  | { status: 'error'; message: string };

interface TestKeysDetail {
  status?: string;
  reason?: string;
  message?: string;
}

export async function testApiKey(key: RequiredKeyId, value: string): Promise<KeyTestResult> {
  const apiKeyValue = value.trim();
  if (!apiKeyValue) return { status: 'invalid', message: 'Enter a key first.' };

  try {
    const response = await fetch('/api/test-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKeys: { [key]: apiKeyValue } }),
    });

    const payload = await response
      .json()
      .catch(() => ({} as { error?: string; details?: Record<string, TestKeysDetail> }));

    if (!response.ok) {
      return { status: 'error', message: payload.error || 'Could not reach the validator.' };
    }

    const detail = payload.details?.[key];
    if (detail?.status === 'valid') return { status: 'valid' };

    if (detail?.status === 'invalid') {
      return {
        status: 'invalid',
        message: detail.reason === 'quota_exhausted'
          ? 'That key is valid but its quota is used up.'
          : (detail.message || 'That key was rejected.'),
      };
    }

    if (detail?.status === 'timeout') {
      return { status: 'timeout', message: detail.message || 'Validation timed out. Try again.' };
    }

    return { status: 'error', message: detail?.message || 'Unexpected response from the validator.' };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error while testing the key.',
    };
  }
}
