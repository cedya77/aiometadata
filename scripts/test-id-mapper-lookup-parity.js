#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO_ROOT = path.resolve(__dirname, '..');
const ADDON_DIR = path.join(REPO_ROOT, 'addon');
const ID_MAPPER_PATH = path.join(ADDON_DIR, 'lib', 'id-mapper.js');
const SERIES_LIKE_TYPES = new Set(['tv', 'ova', 'ona', 'special']);

function toRelativePath(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function walkFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
      continue;
    }
    if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

function findCallSites(regex) {
  const files = walkFiles(ADDON_DIR);
  const paths = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (regex.test(content)) {
      paths.push(toRelativePath(file));
    }
    regex.lastIndex = 0;
  }
  return paths.sort();
}

function discoverCallPaths() {
  return {
    getMappingByTmdbId: findCallSites(/\bidMapper\.getMappingByTmdbId\s*\(/g),
    getAnimeTypeFromAnilistId: findCallSites(/\bidMapper\.getAnimeTypeFromAnilistId\s*\(/g),
    getAnimeTypeFromKitsuId: findCallSites(/\bidMapper\.getAnimeTypeFromKitsuId\s*\(/g),
    getAnimeTypeFromMalId: findCallSites(/\bidMapper\.getAnimeTypeFromMalId\s*\(/g),
    getAnimeTypeFromAnidbId: findCallSites(/\bidMapper\.getAnimeTypeFromAnidbId\s*\(/g)
  };
}

function parseAnimeListRaw(raw, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse JSON in ${filePath}: ${error.message}`, { cause: error });
  }

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new Error(`Failed to parse double-encoded JSON in ${filePath}: ${error.message}`, { cause: error });
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Anime list in ${filePath} is not an array (got ${typeof parsed}).`);
  }

  return parsed;
}

function loadAnimeDatasetsFromFiles() {
  const candidatePaths = [
    path.join(REPO_ROOT, 'addon', 'data', 'anime-list-full.json.cache'),
    path.join(REPO_ROOT, 'data', 'anime-list-full.json.cache')
  ];

  const existingPaths = candidatePaths.filter((p) => fs.existsSync(p));
  if (existingPaths.length === 0) {
    throw new Error(
      'No anime list cache file found. Expected one of: ' +
      candidatePaths.map((p) => toRelativePath(p)).join(', ')
    );
  }

  const datasets = [];
  for (const filePath of existingPaths) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const entries = parseAnimeListRaw(raw, filePath);
    datasets.push({
      filePath,
      relativePath: toRelativePath(filePath),
      byteSize: Buffer.byteLength(raw, 'utf8'),
      entries
    });
  }

  return datasets;
}

function createHttpClientStub(animeEntries) {
  return {
    async httpGet(url) {
      if (url.includes('anime-list-full.json')) {
        return { data: animeEntries, headers: { etag: 'test-etag' } };
      }
      if (url.includes('imdb_mapping.json')) {
        return { data: {}, headers: { etag: 'test-etag' } };
      }
      if (url.includes('movies_ex.json')) {
        return { data: [], headers: { etag: 'test-etag' } };
      }
      throw new Error(`Unexpected httpGet URL in test: ${url}`);
    },
    async httpHead() {
      return { data: null, headers: { etag: 'test-etag' } };
    }
  };
}

function loadIdMapperWithStubs(animeEntries) {
  const originalLoad = Module._load;
  const httpClientStub = createHttpClientStub(animeEntries);
  const fsPromisesStub = {
    async readFile() {
      throw new Error('readFile should not be called in this test path');
    },
    async writeFile() {
      return;
    },
    async mkdir() {
      return;
    }
  };
  const consolaStub = {
    withTag() {
      return {
        debug() {},
        info() {},
        warn() {},
        error() {},
        success() {}
      };
    }
  };
  const idMapperSuffix = path.join('addon', 'lib', 'id-mapper.js');

  Module._load = function patchedLoad(request, parent, isMain) {
    const parentFile = parent && parent.filename ? parent.filename : '';
    const fromIdMapper = parentFile.endsWith(idMapperSuffix);

    if (fromIdMapper && request === '../utils/httpClient') {
      return httpClientStub;
    }
    if (fromIdMapper && request === 'fs') {
      return { promises: fsPromisesStub };
    }
    if (fromIdMapper && request === './redisClient') {
      return null;
    }
    if (fromIdMapper && request === './kitsu') {
      return {};
    }
    if (request === 'consola') {
      return consolaStub;
    }
    if (request === 'framer-motion') {
      return { numberValueTypes: {} };
    }

    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(ID_MAPPER_PATH)];
    return require(ID_MAPPER_PATH);
  } finally {
    Module._load = originalLoad;
  }
}

function normalizeNumericId(value) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function uniqueNumericIds(entries, fieldName) {
  const ids = new Set();
  for (const item of entries) {
    const normalized = normalizeNumericId(item[fieldName]);
    if (normalized !== null) {
      ids.add(normalized);
    }
  }
  return Array.from(ids).sort((a, b) => a - b);
}

function serializeMapping(mapping) {
  if (!mapping) return 'null';
  return [
    mapping.mal_id ?? '',
    mapping.kitsu_id ?? '',
    mapping.anidb_id ?? '',
    mapping.anilist_id ?? '',
    mapping.imdb_id ?? '',
    mapping.themoviedb_id ?? '',
    mapping.tvdb_id ?? '',
    mapping.type ?? ''
  ].join('|');
}

function serializeStringOrNull(value) {
  return value == null ? 'null' : String(value);
}

function mapTypeToStremioType(mapping) {
  if (!mapping || !mapping.type) return null;
  return SERIES_LIKE_TYPES.has(String(mapping.type).toLowerCase()) ? 'series' : 'movie';
}

function buildProposedLookups(tmdbSourceEntries, animeMapEntries, initialized = true) {
  const tmdbIdToCandidatesMap = new Map();
  for (const item of tmdbSourceEntries) {
    const tmdbId = normalizeNumericId(item.themoviedb_id);
    if (tmdbId === null) continue;
    if (!tmdbIdToCandidatesMap.has(tmdbId)) {
      tmdbIdToCandidatesMap.set(tmdbId, []);
    }
    tmdbIdToCandidatesMap.get(tmdbId).push(item);
  }

  const firstByAnilist = new Map();
  const firstByKitsu = new Map();
  const firstByMal = new Map();
  const firstByAnidb = new Map();

  for (const item of animeMapEntries) {
    const anilistId = normalizeNumericId(item.anilist_id);
    const kitsuId = normalizeNumericId(item.kitsu_id);
    const malId = normalizeNumericId(item.mal_id);
    const anidbId = normalizeNumericId(item.anidb_id);

    if (anilistId !== null && !firstByAnilist.has(anilistId)) firstByAnilist.set(anilistId, item);
    if (kitsuId !== null && !firstByKitsu.has(kitsuId)) firstByKitsu.set(kitsuId, item);
    if (malId !== null && !firstByMal.has(malId)) firstByMal.set(malId, item);
    if (anidbId !== null && !firstByAnidb.has(anidbId)) firstByAnidb.set(anidbId, item);
  }

  function getMappingByTmdbId(tmdbId, type) {
    if (!initialized) return null;
    const numericTmdbId = normalizeNumericId(tmdbId);
    if (numericTmdbId === null) return null;

    const allMatches = tmdbIdToCandidatesMap.get(numericTmdbId) || [];
    if (allMatches.length === 0) return null;
    if (allMatches.length === 1) return allMatches[0];

    if (type === 'movie') {
      const movieMatch = allMatches.find((item) => item.type && String(item.type).toLowerCase() === 'movie');
      if (movieMatch) return movieMatch;
    }

    if (type === 'series') {
      const seriesMatch = allMatches.find((item) => item.type && SERIES_LIKE_TYPES.has(String(item.type).toLowerCase()));
      if (seriesMatch) return seriesMatch;
    }

    return allMatches[0];
  }

  function getAnimeTypeFromAnilistId(anilistId) {
    if (!initialized) return null;
    return mapTypeToStremioType(firstByAnilist.get(normalizeNumericId(anilistId)));
  }

  function getAnimeTypeFromKitsuId(kitsuId) {
    if (!initialized) return null;
    return mapTypeToStremioType(firstByKitsu.get(normalizeNumericId(kitsuId)));
  }

  function getAnimeTypeFromMalId(malId) {
    if (!initialized) return null;
    return mapTypeToStremioType(firstByMal.get(normalizeNumericId(malId)));
  }

  function getAnimeTypeFromAnidbId(anidbId) {
    if (!initialized) return null;
    return mapTypeToStremioType(firstByAnidb.get(normalizeNumericId(anidbId)));
  }

  return {
    getMappingByTmdbId,
    getAnimeTypeFromAnilistId,
    getAnimeTypeFromKitsuId,
    getAnimeTypeFromMalId,
    getAnimeTypeFromAnidbId
  };
}

function assertNotInitializedBehavior(idMapper) {
  assert.strictEqual(idMapper.getMappingByTmdbId(12345, 'movie'), null, 'Expected null TMDB mapping before initialization');
  assert.strictEqual(idMapper.getAnimeTypeFromAnilistId(12345), null, 'Expected null AniList type before initialization');
  assert.strictEqual(idMapper.getAnimeTypeFromKitsuId(12345), null, 'Expected null Kitsu type before initialization');
  assert.strictEqual(idMapper.getAnimeTypeFromMalId(12345), null, 'Expected null MAL type before initialization');
  assert.strictEqual(idMapper.getAnimeTypeFromAnidbId(12345), null, 'Expected null AniDB type before initialization');
}

function createTmdbInputs(tmdbSourceEntries) {
  const ids = uniqueNumericIds(tmdbSourceEntries, 'themoviedb_id');
  const typeCases = [undefined, 'movie', 'series', 'unexpected'];
  const inputs = [];

  for (const id of ids) {
    for (const type of typeCases) {
      inputs.push([id, type]);
    }
  }

  const maxId = ids.length > 0 ? ids[ids.length - 1] : 0;
  const missingId = maxId + 1;
  inputs.push([missingId, 'movie']);
  inputs.push([String(missingId), 'series']);
  inputs.push(['not-a-number', 'movie']);

  return { inputs, idCount: ids.length, typeCases };
}

function createSingleArgInputs(animeMapEntries, fieldName) {
  const ids = uniqueNumericIds(animeMapEntries, fieldName);
  const inputs = ids.map((id) => [id]);
  const maxId = ids.length > 0 ? ids[ids.length - 1] : 0;
  const missingId = maxId + 1;

  inputs.push([missingId]);
  inputs.push([String(missingId)]);
  inputs.push(['not-a-number']);
  inputs.push([undefined]);

  return { inputs, idCount: ids.length };
}

function formatMsFromNs(ns) {
  return (Number(ns) / 1e6).toFixed(2);
}

function runParityAndBenchmark({ label, inputs, oldFn, newFn, serializer }) {
  const oldOutputs = new Array(inputs.length);

  const oldStart = process.hrtime.bigint();
  for (let i = 0; i < inputs.length; i++) {
    oldOutputs[i] = serializer(oldFn(...inputs[i]));
  }
  const oldNs = process.hrtime.bigint() - oldStart;

  const newStart = process.hrtime.bigint();
  for (let i = 0; i < inputs.length; i++) {
    const newOutput = serializer(newFn(...inputs[i]));
    if (newOutput !== oldOutputs[i]) {
      const args = JSON.stringify(inputs[i]);
      throw new Error(`${label} parity mismatch at index=${i}, args=${args}, old=${oldOutputs[i]}, new=${newOutput}`);
    }
  }
  const newNs = process.hrtime.bigint() - newStart;

  const calls = inputs.length;
  const oldMs = Number(oldNs) / 1e6;
  const newMs = Number(newNs) / 1e6;
  const oldOps = calls / (oldMs / 1000);
  const newOps = calls / (newMs / 1000);
  const speedup = oldMs / newMs;

  return {
    label,
    calls,
    oldNs,
    newNs,
    oldMs,
    newMs,
    oldOps,
    newOps,
    speedup
  };
}

function printCallPathReport(callPaths) {
  console.log('Discovered current call paths:');
  for (const [fnName, paths] of Object.entries(callPaths)) {
    const printable = paths.length > 0 ? paths.join(', ') : '(no internal call sites found)';
    console.log(`  - ${fnName}: ${printable}`);
  }
}

function printMetricsReport(datasetLabel, metrics) {
  console.log(`\nPerformance report for ${datasetLabel}`);
  for (const metric of metrics) {
    console.log(
      `  - ${metric.label}: calls=${metric.calls}, ` +
      `old=${metric.oldMs.toFixed(2)}ms (${Math.round(metric.oldOps).toLocaleString()} ops/s), ` +
      `new=${metric.newMs.toFixed(2)}ms (${Math.round(metric.newOps).toLocaleString()} ops/s), ` +
      `speedup=${metric.speedup.toFixed(2)}x`
    );
  }

  const totalOldNs = metrics.reduce((sum, m) => sum + m.oldNs, 0n);
  const totalNewNs = metrics.reduce((sum, m) => sum + m.newNs, 0n);
  const totalCalls = metrics.reduce((sum, m) => sum + m.calls, 0);
  const totalOldMs = Number(totalOldNs) / 1e6;
  const totalNewMs = Number(totalNewNs) / 1e6;
  const totalSpeedup = totalOldMs / totalNewMs;

  console.log(
    `  - TOTAL: calls=${totalCalls}, old=${formatMsFromNs(totalOldNs)}ms, ` +
    `new=${formatMsFromNs(totalNewNs)}ms, speedup=${totalSpeedup.toFixed(2)}x`
  );
}

function assertFunctionCoverageByPath(callPaths, executedFunctions) {
  for (const [fnName, paths] of Object.entries(callPaths)) {
    if (paths.length > 0) {
      assert(
        executedFunctions.has(fnName),
        `Function ${fnName} has call paths (${paths.join(', ')}) but was not executed by this test.`
      );
    }
  }
}

async function runDataset(dataset, callPaths) {
  const idMapper = loadIdMapperWithStubs(dataset.entries);
  try {
    assertNotInitializedBehavior(idMapper);

    const updateResult = await idMapper.forceUpdateIdMapper();
    assert.strictEqual(updateResult.success, true, `forceUpdateIdMapper failed: ${JSON.stringify(updateResult)}`);

    const mappings = idMapper.getAllMappings();
    assert(mappings && mappings.animeIdMap instanceof Map, 'Expected initialized animeIdMap after forceUpdateIdMapper');

    const animeMapEntries = Array.from(mappings.animeIdMap.values());
    const tmdbSourceEntries = dataset.entries;
    const proposedLookups = buildProposedLookups(tmdbSourceEntries, animeMapEntries, true);

    const executedFunctions = new Set();
    const metrics = [];

    const tmdbInputInfo = createTmdbInputs(tmdbSourceEntries);
    assert(tmdbInputInfo.typeCases.includes('movie') && tmdbInputInfo.typeCases.includes('series'), 'TMDB test must cover movie and series types.');
    executedFunctions.add('getMappingByTmdbId');
    metrics.push(runParityAndBenchmark({
      label: 'getMappingByTmdbId (all TMDB IDs x all type cases)',
      inputs: tmdbInputInfo.inputs,
      oldFn: idMapper.getMappingByTmdbId,
      newFn: proposedLookups.getMappingByTmdbId,
      serializer: serializeMapping
    }));

    const anilistInputInfo = createSingleArgInputs(tmdbSourceEntries, 'anilist_id');
    executedFunctions.add('getAnimeTypeFromAnilistId');
    metrics.push(runParityAndBenchmark({
      label: 'getAnimeTypeFromAnilistId (all AniList IDs)',
      inputs: anilistInputInfo.inputs,
      oldFn: idMapper.getAnimeTypeFromAnilistId,
      newFn: proposedLookups.getAnimeTypeFromAnilistId,
      serializer: serializeStringOrNull
    }));

    const kitsuInputInfo = createSingleArgInputs(tmdbSourceEntries, 'kitsu_id');
    executedFunctions.add('getAnimeTypeFromKitsuId');
    metrics.push(runParityAndBenchmark({
      label: 'getAnimeTypeFromKitsuId (all Kitsu IDs)',
      inputs: kitsuInputInfo.inputs,
      oldFn: idMapper.getAnimeTypeFromKitsuId,
      newFn: proposedLookups.getAnimeTypeFromKitsuId,
      serializer: serializeStringOrNull
    }));

    const malInputInfo = createSingleArgInputs(tmdbSourceEntries, 'mal_id');
    executedFunctions.add('getAnimeTypeFromMalId');
    metrics.push(runParityAndBenchmark({
      label: 'getAnimeTypeFromMalId (all MAL IDs)',
      inputs: malInputInfo.inputs,
      oldFn: idMapper.getAnimeTypeFromMalId,
      newFn: proposedLookups.getAnimeTypeFromMalId,
      serializer: serializeStringOrNull
    }));

    const anidbInputInfo = createSingleArgInputs(tmdbSourceEntries, 'anidb_id');
    executedFunctions.add('getAnimeTypeFromAnidbId');
    metrics.push(runParityAndBenchmark({
      label: 'getAnimeTypeFromAnidbId (all AniDB IDs)',
      inputs: anidbInputInfo.inputs,
      oldFn: idMapper.getAnimeTypeFromAnidbId,
      newFn: proposedLookups.getAnimeTypeFromAnidbId,
      serializer: serializeStringOrNull
    }));

    assertFunctionCoverageByPath(callPaths, executedFunctions);

    console.log(`\nDataset: ${dataset.relativePath}`);
    console.log(`  - bytes: ${dataset.byteSize.toLocaleString()}`);
    console.log(`  - source entries: ${dataset.entries.length.toLocaleString()}`);
    console.log(`  - animeIdMap entries (MAL-keyed): ${animeMapEntries.length.toLocaleString()}`);
    console.log(`  - TMDB unique IDs tested: ${tmdbInputInfo.idCount.toLocaleString()} x ${tmdbInputInfo.typeCases.length} type cases`);
    console.log(`  - AniList IDs tested: ${anilistInputInfo.idCount.toLocaleString()}`);
    console.log(`  - Kitsu IDs tested: ${kitsuInputInfo.idCount.toLocaleString()}`);
    console.log(`  - MAL IDs tested: ${malInputInfo.idCount.toLocaleString()}`);
    console.log(`  - AniDB IDs tested: ${anidbInputInfo.idCount.toLocaleString()}`);

    printMetricsReport(dataset.relativePath, metrics);
  } finally {
    idMapper.cleanup();
  }
}

async function main() {
  const callPaths = discoverCallPaths();
  printCallPathReport(callPaths);

  const datasets = loadAnimeDatasetsFromFiles();
  console.log('\nLoaded anime list datasets:');
  for (const dataset of datasets) {
    console.log(`  - ${dataset.relativePath} (${dataset.entries.length.toLocaleString()} entries)`);
  }

  for (const dataset of datasets) {
    await runDataset(dataset, callPaths);
  }

  console.log('\nPASS: parity and performance checks completed for all discovered cache files.');
}

main().catch((error) => {
  console.error('\nFAIL: id-mapper lookup parity/performance test failed.');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
