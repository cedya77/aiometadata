import fs from 'fs';
import path from 'path';
import { SETTINGS_REGISTRY } from '../addon/lib/settingsRegistry';

const ADDON_DIR = path.resolve(__dirname, '../addon');

// Internal or runtime-injected vars, exempt from the drift check.
const INTERNAL_ALLOWLIST = new Set<string>([
  'NODE_ENV',
  'NODE_OPTIONS',
  'TZ',
  'PWD',
  'HOME',
  'CACHE_WARMUP_UUID',
  'POSTER_CACHE_LOG_PIPE',
]);

const ENV_RE = /process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g;
const GET_SETTING_RE = /getSetting\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g;

// Top-level const/let/var whose initializer reads process.env, inline or via an IIFE: frozen until restart.
const MODULE_INLINE_RE = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=(?![^\n;]*=>)(?![^\n;]*\bfunction\b)[^\n;]*?process\.env\.([A-Z_][A-Z0-9_]*)/gm;
const MODULE_IIFE_RE = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*\(\s*(?:async\s+)?\(\)\s*=>\s*\{([\s\S]*?)\}\s*\)\s*\(\s*\)/gm;

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|js)$/.test(entry.name)) out.push(full);
  }
}

const known = new Set<string>(INTERNAL_ALLOWLIST);
for (const def of SETTINGS_REGISTRY) {
  known.add(def.key);
  known.add(def.envVar);
  if (def.legacyEnvVar) known.add(def.legacyEnvVar);
}

const files: string[] = [];
walk(ADDON_DIR, files);

const used = new Map<string, string>();
const settingKeysUsed = new Set<string>();
const moduleLoad = new Map<string, string>();

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === '\n') line++;
  return line;
}

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const rel = path.relative(process.cwd(), file);

  content.split('\n').forEach((line, i) => {
    let m: RegExpExecArray | null;
    ENV_RE.lastIndex = 0;
    while ((m = ENV_RE.exec(line)) !== null) {
      const name = m[1] || m[2];
      if (!used.has(name)) used.set(name, `${rel}:${i + 1}`);
    }
    GET_SETTING_RE.lastIndex = 0;
    while ((m = GET_SETTING_RE.exec(line)) !== null) settingKeysUsed.add(m[1]);
  });

  let mm: RegExpExecArray | null;
  MODULE_INLINE_RE.lastIndex = 0;
  while ((mm = MODULE_INLINE_RE.exec(content)) !== null) {
    if (!moduleLoad.has(mm[1])) moduleLoad.set(mm[1], `${rel}:${lineAt(content, mm.index)}`);
  }
  MODULE_IIFE_RE.lastIndex = 0;
  while ((mm = MODULE_IIFE_RE.exec(content)) !== null) {
    const body = mm[1];
    let inner: RegExpExecArray | null;
    const innerRe = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
    while ((inner = innerRe.exec(body)) !== null) {
      if (!moduleLoad.has(inner[1])) moduleLoad.set(inner[1], `${rel}:${lineAt(content, mm.index)}`);
    }
  }
}

const defByEnvVar = new Map<string, typeof SETTINGS_REGISTRY[number]>();
for (const def of SETTINGS_REGISTRY) {
  defByEnvVar.set(def.envVar, def);
  if (def.legacyEnvVar) defByEnvVar.set(def.legacyEnvVar, def);
}

const restartViolations: string[] = [];
for (const [envVar, loc] of moduleLoad) {
  const def = defByEnvVar.get(envVar);
  if (def && !def.requiresRestart && !def.envOnly) {
    restartViolations.push(`   ${envVar}\t(read at module load ${loc}) — registry entry '${def.key}' is missing requiresRestart`);
  }
}

const missing = [...used.keys()].filter((v) => !known.has(v)).sort();

const unused = [...SETTINGS_REGISTRY]
  .filter((def) => !used.has(def.envVar) && !(def.legacyEnvVar && used.has(def.legacyEnvVar)) && !settingKeysUsed.has(def.key))
  .map((def) => def.envVar)
  .sort();

if (unused.length) {
  console.log(`\n⚠  ${unused.length} registered env var(s) not referenced in addon/ (harmless, possibly renamed/removed):`);
  for (const v of unused) console.log(`   - ${v}`);
}

let failed = false;

if (missing.length) {
  failed = true;
  console.error(`\n❌ ${missing.length} env var(s) used in code but missing from settingsRegistry.ts:\n`);
  for (const v of missing) console.error(`   ${v}\t(first seen ${used.get(v)})`);
  console.error(`\nAdd each to SETTINGS_REGISTRY (with type/default/description) so it appears in the dashboard,`);
  console.error(`or add it to INTERNAL_ALLOWLIST in scripts/check-env-registry.ts if it is internal plumbing.`);
}

if (restartViolations.length) {
  failed = true;
  console.error(`\n❌ ${restartViolations.length} setting(s) read at module load but not marked requiresRestart:\n`);
  for (const v of restartViolations) console.error(v);
  console.error(`\nEither add 'requiresRestart: true' to the registry entry, or change the code to read`);
  console.error(`process.env lazily (inside a function/getter) so live dashboard edits take effect.`);
}

if (failed) {
  console.error('');
  process.exit(1);
}

console.log(`\n✅ env registry in sync: all ${used.size} referenced env vars are registered or allowlisted.`);
