#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
//
// Keeps the license split checkable:
//   1. Every source file starts with the SPDX header its path calls for:
//      FSL-1.1-ALv2 for the paths LICENSING.md lists between the fsl-paths
//      markers, the AGPL core expression for everything else.
//   2. Every production dependency in package-lock.json has a license on the
//      allowlist below.
//
// Usage: node scripts/check-licenses.mjs [--fix] [--headers-only] [--deps-only]
//   --fix  writes or corrects the headers instead of only reporting them.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const args = new Set(process.argv.slice(2));
const FIX = args.has('--fix');

const CORE = 'AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking';
const FSL = 'FSL-1.1-ALv2';
const COPYRIGHT = 'Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE';
const COPYRIGHT_FSL = 'Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE';

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh)$/;
// Generated, vendored or third-party files that carry their own terms.
const SKIP = [/^node_modules\//, /^dist\//, /^LICENSES\//, /\.d\.ts$/, /^public\//];

// Licenses a production dependency may carry. A package may also use
// LGPL-3.0-or-later when it is a prebuilt libvips binary loaded by sharp:
// dynamically linked and unmodified, which both licenses allow.
const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense']);
const LGPL_OK = /^@img\/sharp-/;

function readFslPatterns() {
  const text = readFileSync(join(ROOT, 'LICENSING.md'), 'utf8');
  const block = text.split('<!-- fsl-paths:start -->')[1]?.split('<!-- fsl-paths:end -->')[0];
  if (!block) throw new Error('LICENSING.md has no fsl-paths block');
  return [...block.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]);
}

function isFsl(path, patterns) {
  return patterns.some((p) => (p.endsWith('/**') ? path.startsWith(p.slice(0, -2)) : path === p));
}

function headerFor(path, fsl) {
  const c = path.endsWith('.sh') ? '#' : '//';
  return [`${c} SPDX-License-Identifier: ${fsl ? FSL : CORE}`, `${c} ${fsl ? COPYRIGHT_FSL : COPYRIGHT}`];
}

function checkHeaders() {
  const patterns = readFslPatterns();
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => SOURCE.test(f) && !SKIP.some((r) => r.test(f)));
  const problems = [];
  let fixed = 0;
  for (const file of files) {
    const abs = join(ROOT, file);
    const raw = readFileSync(abs, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    const start = lines[0]?.startsWith('#!') ? 1 : 0;
    const want = headerFor(file, isFsl(file, patterns));
    const spdxAt = lines.findIndex((l, i) => i < start + 5 && /SPDX-License-Identifier:/.test(l));
    const ok = spdxAt === start && lines[start] === want[0] && /Copyright/.test(lines[start + 1] || '');
    if (ok) continue;
    if (!FIX) {
      const found = spdxAt >= 0 ? lines[spdxAt].replace(/^\W*SPDX-License-Identifier:\s*/, '') : 'none';
      problems.push(`${file}: header ${found === 'none' ? 'missing' : `is "${found}"`}, expected "${want[0].replace(/^\W*SPDX-License-Identifier:\s*/, '')}"`);
      continue;
    }
    if (spdxAt >= 0) {
      // Replace an existing SPDX line and the copyright line right after it.
      const drop = /Copyright/.test(lines[spdxAt + 1] || '') ? 2 : 1;
      lines.splice(spdxAt, drop);
    }
    lines.splice(start, 0, ...want);
    writeFileSync(abs, lines.join(eol));
    fixed += 1;
  }
  if (FIX) console.log(`headers: ${fixed} file(s) written, ${files.length} checked`);
  return problems;
}

function allowedExpression(expr, name) {
  const clean = String(expr).replace(/[()]/g, ' ').trim();
  const ok = (id) => ALLOWED.has(id) || (id === 'LGPL-3.0-or-later' && LGPL_OK.test(name));
  // Any OR branch passing is enough; within a branch every AND term must pass.
  return clean.split(/\s+OR\s+/).some((branch) => branch.split(/\s+AND\s+/).every((id) => ok(id.trim())));
}

function checkDependencies() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const problems = [];
  for (const [path, pkg] of Object.entries(lock.packages || {})) {
    if (!path || pkg.dev) continue;
    const name = path.replace(/^.*node_modules\//, '');
    const license = typeof pkg.license === 'string' ? pkg.license : null;
    if (!license) problems.push(`${name}@${pkg.version}: no license in package-lock.json`);
    else if (!allowedExpression(license, name)) problems.push(`${name}@${pkg.version}: license "${license}" is not on the allowlist`);
  }
  return problems;
}

const problems = [
  ...(args.has('--deps-only') ? [] : checkHeaders()),
  ...(args.has('--headers-only') ? [] : checkDependencies()),
];
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} license problem(s). Run "node scripts/check-licenses.mjs --fix" for headers.`);
  process.exit(1);
}
console.log('licenses: ok');
