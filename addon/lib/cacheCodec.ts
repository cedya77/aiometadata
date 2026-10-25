import { compress, uncompress } from 'lz4-napi';

const HEADER = Buffer.from('AIOMC1:LZ4:', 'ascii');
const DEFAULT_MIN_BYTES = 2 * 1024;

function parseMinBytes(): number {
  const raw = process.env.CACHE_COMPRESSION_MIN_BYTES;
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MIN_BYTES;
  }
  return parsed;
}

function isCompressionEnabled(): boolean {
  return process.env.CACHE_COMPRESSION_ENABLED !== 'false';
}

function hasCompressionHeader(value: Buffer | string | null | undefined): boolean {
  return Buffer.isBuffer(value)
    && value.length > HEADER.length
    && value.subarray(0, HEADER.length).equals(HEADER);
}

type EncodeCachePayloadOptions = {
  compressionEnabled?: boolean;
};

async function encodeCachePayload(
  value: unknown,
  options?: EncodeCachePayloadOptions,
): Promise<string | Buffer> {
  const json = JSON.stringify(value);
  const jsonBytes = Buffer.byteLength(json);
  const compressionEnabled = options?.compressionEnabled ?? isCompressionEnabled();

  if (!compressionEnabled || jsonBytes < parseMinBytes()) {
    return json;
  }

  const compressed = await compress(Buffer.from(json));
  return Buffer.concat([HEADER, compressed]);
}

async function decodeCacheText(payload: Buffer | string | null | undefined): Promise<string | null> {
  if (payload === null || payload === undefined) return null;

  const buffer = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(String(payload), 'utf8');

  if (!hasCompressionHeader(buffer)) {
    return buffer.toString('utf8');
  }

  const decompressed = await uncompress(buffer.subarray(HEADER.length));
  return decompressed.toString('utf8');
}

async function decodeCachePayload(payload: Buffer | string | null | undefined): Promise<any> {
  const text = await decodeCacheText(payload);
  return text === null ? null : JSON.parse(text);
}

export {
  DEFAULT_MIN_BYTES,
  HEADER,
  decodeCachePayload,
  decodeCacheText,
  encodeCachePayload,
  hasCompressionHeader,
};
