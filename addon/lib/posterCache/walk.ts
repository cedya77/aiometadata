// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export interface WalkedFile {
  name: string;
  dir: string;
}

export interface WalkOptions {
  concurrency?: number;
  onError?: (error: any, dir: string) => void;
  readdir?: (dir: string, options: any) => Promise<any[]>;
}

const DEFAULT_CONCURRENCY = 16;

export async function* walkFiles(root: string, options: WalkOptions = {}): AsyncGenerator<WalkedFile> {
  const readdir = options.readdir ?? ((dir: string, opts: any) => fsp.readdir(dir, opts));
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  let frontier: string[] = [root];

  while (frontier.length > 0) {
    const batch = frontier.splice(0, concurrency);

    const listings = await Promise.all(batch.map(async (dir) => {
      try {
        return { dir, entries: await readdir(dir, { withFileTypes: true }) };
      } catch (error: any) {
        // A directory removed underneath us is normal for a live cache.
        if (error?.code !== 'ENOENT') {
          options.onError?.(error, dir);
        }
        return { dir, entries: [] as any[] };
      }
    }));

    for (const { dir, entries } of listings) {
      for (const entry of entries) {
        if (entry.isDirectory()) {
          frontier.push(path.join(dir, entry.name));
        } else if (entry.isFile()) {
          yield { name: entry.name, dir };
        }
        // Symlinks and other types are skipped: descending them risks cycles.
      }
    }
  }
}

export async function pruneEmptyDirs(startDir: string, stopAt: string): Promise<void> {
  const stop = path.resolve(stopAt);
  let current = path.resolve(startDir);

  // Only ever prune strictly inside the stop directory.
  while (current !== stop && current.startsWith(stop + path.sep)) {
    try {
      await fsp.rmdir(current);
    } catch {
      // ENOTEMPTY (something else is stored here), ENOENT (already gone), or a perms problem
      return;
    }
    current = path.dirname(current);
  }
}
