const { compress, uncompress } = require('lz4-napi');

const HEADER = Buffer.from('AIOMC1:LZ4:', 'ascii');
const DEFAULT_MIN_BYTES = 2 * 1024;

function parseMinBytes() {
  const raw = process.env.CACHE_COMPRESSION_MIN_BYTES;
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MIN_BYTES;
  }
  return parsed;
}

function isCompressionEnabled() {
  return process.env.CACHE_COMPRESSION_ENABLED !== 'false';
}

function hasCompressionHeader(value) {
  return Buffer.isBuffer(value)
    && value.length > HEADER.length
    && value.subarray(0, HEADER.length).equals(HEADER);
}

async function encodeCachePayload(value) {
  const json = JSON.stringify(value);
  const jsonBytes = Buffer.byteLength(json);

  if (!isCompressionEnabled() || jsonBytes < parseMinBytes()) {
    return json;
  }

  const compressed = await compress(Buffer.from(json));
  return Buffer.concat([HEADER, compressed]);
}

async function decodeCachePayload(payload) {
  if (payload === null || payload === undefined) return null;

  const buffer = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(String(payload), 'utf8');

  if (!hasCompressionHeader(buffer)) {
    return JSON.parse(buffer.toString('utf8'));
  }

  const decompressed = await uncompress(buffer.subarray(HEADER.length));
  return JSON.parse(decompressed.toString('utf8'));
}

module.exports = {
  DEFAULT_MIN_BYTES,
  HEADER,
  decodeCachePayload,
  encodeCachePayload,
  hasCompressionHeader,
};
