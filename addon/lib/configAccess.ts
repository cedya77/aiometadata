// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
const database: any = require('./database');

export interface ConfigAccess {
  config: any;
  passwordHash: string | null;
}

/**
 * Resolves a request's claim on a configuration, by the account that owns it or
 * by its password.
 *
 * Signing in through an identity provider never asks for the configuration's own
 * password, so a route that accepts nothing else shuts those users out of a
 * configuration that is theirs. The stored hash comes back with the config
 * because a caller writing the config has to keep it as it was; rehashing on an
 * ordinary save would rotate it for everyone loading the configuration the usual
 * way.
 */
export async function resolveConfigAccess(
  req: any,
  userUUID: string,
  password?: string | null
): Promise<ConfigAccess | null> {
  if (!userUUID) return null;

  const accountId = req?.session?.accountId;
  if (accountId && await database.ownsConfig(accountId, userUUID)) {
    const config = await database.getUserConfig(userUUID);
    if (config) return { config, passwordHash: await storedHash(userUUID) };
  }

  if (!password) return null;

  const config = await database.verifyUserAndGetConfig(userUUID, password);
  if (!config) return null;
  return { config, passwordHash: await storedHash(userUUID) };
}

async function storedHash(userUUID: string): Promise<string | null> {
  const user = await database.getUser(userUUID);
  return user?.password_hash ?? null;
}
