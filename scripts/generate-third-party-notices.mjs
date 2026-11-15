#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// Writes THIRD_PARTY_NOTICES.txt: the name, version, license and license text
// of every production dependency in package-lock.json, read from node_modules.
// Runs before every build (npm run prebuild) and in the container build.
//
// Usage: node scripts/generate-third-party-notices.mjs [output]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The container build has no git; the working directory is the project root there.
let ROOT = process.cwd();
try { ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
const out = process.argv[2] || join(ROOT, 'THIRD_PARTY_NOTICES.txt');
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

const seen = new Map();
for (const [path, pkg] of Object.entries(lock.packages || {})) {
  if (!path || pkg.dev) continue;
  const name = path.replace(/^.*node_modules\//, '');
  const key = `${name}@${pkg.version}`;
  if (seen.has(key)) continue;
  const dir = join(ROOT, path);
  let texts = [];
  if (existsSync(dir)) {
    texts = readdirSync(dir)
      .filter((f) => LICENSE_FILE.test(f))
      .sort()
      .map((f) => readFileSync(join(dir, f), 'utf8').trim());
  }
  seen.set(key, { name, version: pkg.version, license: pkg.license || 'UNKNOWN', texts, installed: existsSync(dir) });
}

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const rule = '-'.repeat(79);
const parts = [
  'THIRD-PARTY NOTICES',
  '',
  'AIOMetadata uses the following third-party packages in production. Each is',
  'distributed under its own license, reproduced below as found in the package.',
  `Generated from package-lock.json; ${entries.length} packages.`,
  '',
];
for (const e of entries) {
  parts.push(rule, `${e.name} ${e.version}`, `License: ${e.license}`, '');
  if (e.texts.length) parts.push(...e.texts.flatMap((t) => [t, '']));
  else if (!e.installed) parts.push('(Platform-specific package not installed where this file was generated; see its package for the license text.)', '');
  else parts.push('(The package ships no separate license file; its package.json declares the license above.)', '');
}
writeFileSync(out, parts.join('\n'));
console.log(`wrote ${out}: ${entries.length} packages`);
