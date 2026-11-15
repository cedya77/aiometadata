// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import consola from 'consola';
import {
  LEGACY_NGINX_CACHE_DIRS,
  getCacheDir,
  getNginxImportDir,
  isNginxImportDisabled,
} from './config.js';
import * as store from './store.js';
import { shapePoster } from './shape.js';

const logger = consola.withTag('PosterCacheImport');

const MARKER_NAME = '.nginx-import-completed';
const MARKER_VERSION = 'nginx-import-v1';

 // Imports a cache built by the previous bundled nginx proxy so upgrading users do not lose a warm cache.
 // 
const KEY_MARKER = Buffer.from('\nKEY: ', 'ascii');
const HEADER_END = Buffer.from('\r\n\r\n', 'ascii');

interface ParsedNginxEntry {
  key: string;
  contentType: string;
  body: Buffer;
}

function looksLikeImage(body: Buffer): boolean {
  if (body.length < 12) return false;
  if (body[0] === 0xff && body[1] === 0xd8) return true; // JPEG
  if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return true; // PNG
  if (body.subarray(0, 3).toString('ascii') === 'GIF') return true; // GIF
  if (body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP') return true;
  if (body.subarray(4, 8).toString('ascii') === 'ftyp') return true; // AVIF/HEIC
  return false;
}

function contentTypeFor(headers: string, body: Buffer): string {
  const match = /^content-type:\s*([^\r\n;]+)/im.exec(headers);
  if (match) return match[1].trim();
  if (body[0] === 0x89) return 'image/png';
  if (body.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (body.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

export function parseNginxCacheFile(raw: Buffer): ParsedNginxEntry | null {
  const keyStart = raw.indexOf(KEY_MARKER);
  if (keyStart < 0) return null;

  const keyValueStart = keyStart + KEY_MARKER.length;
  const keyEnd = raw.indexOf(0x0a, keyValueStart); // newline terminating the KEY line
  if (keyEnd < 0) return null;

  const key = raw.subarray(keyValueStart, keyEnd).toString('utf8').trim();
  if (!/^https?:\/\//i.test(key)) return null;

  const headerEnd = raw.indexOf(HEADER_END, keyEnd);
  if (headerEnd < 0) return null;

  const headers = raw.subarray(keyEnd, headerEnd).toString('latin1');
  const body = raw.subarray(headerEnd + HEADER_END.length);
  if (!looksLikeImage(body)) return null;

  return { key, contentType: contentTypeFor(headers, body), body };
}

async function alreadyImported(markerPath: string): Promise<boolean> {
  try {
    const contents = await fsp.readFile(markerPath, 'utf8');
    return JSON.parse(contents)?.version === MARKER_VERSION;
  } catch {
    return false;
  }
}


async function containsAnyFile(dir: string): Promise<boolean> {
  let handle: fs.Dir;
  try {
    handle = await fsp.opendir(dir, { recursive: true } as any);
  } catch {
    return false;
  }
  try {
    // A hashed cache tree yields thousands of dirs before the first file.
    const deadline = Date.now() + 5000;
    let inspected = 0;
    for await (const dirent of handle) {
      if (dirent.isFile()) return true;
      if (++inspected % 1000 === 0 && Date.now() > deadline) return false;
    }
    return false;
  } catch {
    return false;
  }
}


async function resolveImportDir(): Promise<{ dir: string; detected: boolean } | null> {
  if (isNginxImportDisabled()) return null;

  const explicit = getNginxImportDir();
  if (explicit) return { dir: explicit, detected: false };

  for (const candidate of LEGACY_NGINX_CACHE_DIRS) {
    if (await containsAnyFile(candidate)) {
      return { dir: candidate, detected: true };
    }
  }
  return null;
}

export async function runNginxImport(): Promise<void> {
  const markerPath = path.join(getCacheDir(), MARKER_NAME);
  if (await alreadyImported(markerPath)) {
    logger.debug('nginx cache already imported, skipping');
    return;
  }

  const resolved = await resolveImportDir();
  if (!resolved) return;
  const { dir: sourceDir, detected } = resolved;

  if (detected) {
    logger.info(
      `Found a cache from the previous built-in nginx proxy at ${sourceDir} — ` +
      'importing it once so the upgrade does not start cold.'
    );
  }

  let dir: fs.Dir;
  try {
    dir = await fsp.opendir(sourceDir, { recursive: true } as any);
  } catch (error: any) {
    logger.warn(`Cannot read ${sourceDir}: ${error?.message} — skipping import`);
    return;
  }

  const started = Date.now();
  let imported = 0;
  let skipped = 0;

  for await (const dirent of dir) {
    if (!dirent.isFile()) continue;
    const parent = (dirent as any).parentPath || (dirent as any).path || sourceDir;
    const filePath = path.join(parent, dirent.name);
    try {
      const raw = await fsp.readFile(filePath);
      const parsed = parseNginxCacheFile(raw);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      const shaped = await shapePoster(parsed.body, parsed.contentType);
      await store.put('poster', parsed.key, shaped.body, shaped.contentType);
      imported += 1;
    } catch (error: any) {
      logger.debug(`Skipping ${filePath}: ${error?.message}`);
      skipped += 1;
    }
  }

  await fsp.mkdir(getCacheDir(), { recursive: true }).catch(() => { /* created by put() */ });
  await fsp.writeFile(
    markerPath,
    JSON.stringify({
      version: MARKER_VERSION,
      completedAt: new Date().toISOString(),
      source: sourceDir,
      autoDetected: detected,
      imported,
      skipped,
    }, null, 2)
  ).catch((error: any) => {
    logger.warn(`Could not write import marker: ${error?.message} — import may repeat on next start`);
  });

  logger.success(
    `Imported ${imported} images from the old nginx cache (${skipped} skipped) in ${Date.now() - started}ms. ` +
    `You can now remove the ${sourceDir} volume mount.`
  );
}
