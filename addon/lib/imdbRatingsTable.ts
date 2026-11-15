// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export interface ImdbRating {
  rating: number;
  votes: number;
}

const MAGIC = 'IMDR';
const FORMAT_VERSION = 1;
const HEADER_BYTES = 16;
const ID_PATTERN = /^tt(\d+)$/;

function numericId(imdbId: string): number | null {
  const match = ID_PATTERN.exec(imdbId);
  if (!match) return null;
  const id = Number(match[1]);
  return id <= 0xffffffff ? id : null;
}

const align4 = (n: number): number => (n + 3) & ~3;

/**
 * The ratings dataset as three parallel arrays sorted by numeric id, about 9 bytes
 * a title. Immutable once built, so a refresh swaps in a new table whole.
 */
export class RatingsTable {
  private constructor(
    private readonly ids: Uint32Array,
    private readonly votes: Uint32Array,
    private readonly ratings: Uint8Array,
  ) {}

  get size(): number {
    return this.ids.length;
  }

  get(imdbId: string): ImdbRating | null {
    const id = numericId(imdbId);
    if (id === null) return null;

    let lo = 0;
    let hi = this.ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const value = this.ids[mid];
      if (value === id) return { rating: this.ratings[mid] / 10, votes: this.votes[mid] };
      if (value < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  /** Parses title.ratings.tsv lines, header included. */
  static async fromLines(lines: AsyncIterable<string>, minVotes: number): Promise<{ table: RatingsTable; filtered: number }> {
    let capacity = 1 << 20;
    let ids = new Uint32Array(capacity);
    let votes = new Uint32Array(capacity);
    let ratings = new Uint8Array(capacity);
    let count = 0;
    let filtered = 0;
    let isFirstLine = true;

    for await (const line of lines) {
      if (isFirstLine) {
        isFirstLine = false;
        continue;
      }
      const [idStr, ratingStr, votesStr] = line.split('\t');
      const id = numericId(idStr || '');
      const rating = parseFloat(ratingStr);
      const voteCount = parseInt(votesStr, 10);
      if (id === null || isNaN(rating) || isNaN(voteCount)) continue;

      if (voteCount < minVotes) {
        filtered++;
        continue;
      }

      if (count === capacity) {
        capacity *= 2;
        ids = grow(ids, new Uint32Array(capacity));
        votes = grow(votes, new Uint32Array(capacity));
        ratings = grow(ratings, new Uint8Array(capacity));
      }
      ids[count] = id;
      votes[count] = voteCount;
      ratings[count] = Math.round(rating * 10);
      count++;
    }

    return { table: RatingsTable.sorted(ids.subarray(0, count), votes.subarray(0, count), ratings.subarray(0, count)), filtered };
  }

  toBuffer(etag: string | null): Buffer {
    const etagBytes = Buffer.from(etag || '', 'utf8');
    const idsOffset = align4(HEADER_BYTES + etagBytes.length);
    const votesOffset = idsOffset + this.ids.byteLength;
    const ratingsOffset = votesOffset + this.votes.byteLength;
    const buffer = Buffer.alloc(ratingsOffset + this.ratings.byteLength);

    buffer.write(MAGIC, 0, 'latin1');
    buffer.writeUInt32LE(FORMAT_VERSION, 4);
    buffer.writeUInt32LE(this.size, 8);
    buffer.writeUInt32LE(etagBytes.length, 12);
    etagBytes.copy(buffer, HEADER_BYTES);
    Buffer.from(this.ids.buffer, this.ids.byteOffset, this.ids.byteLength).copy(buffer, idsOffset);
    Buffer.from(this.votes.buffer, this.votes.byteOffset, this.votes.byteLength).copy(buffer, votesOffset);
    Buffer.from(this.ratings.buffer, this.ratings.byteOffset, this.ratings.byteLength).copy(buffer, ratingsOffset);
    return buffer;
  }

  /** Null for anything that is not a complete file of this format version. */
  static fromBuffer(buffer: Buffer): { table: RatingsTable; etag: string | null } | null {
    if (buffer.length < HEADER_BYTES) return null;
    if (buffer.toString('latin1', 0, 4) !== MAGIC) return null;
    if (buffer.readUInt32LE(4) !== FORMAT_VERSION) return null;

    const count = buffer.readUInt32LE(8);
    const etagLength = buffer.readUInt32LE(12);
    const idsOffset = align4(HEADER_BYTES + etagLength);
    const votesOffset = idsOffset + count * 4;
    const ratingsOffset = votesOffset + count * 4;
    if (buffer.length !== ratingsOffset + count) return null;

    // Copied out rather than viewed: a Buffer's byteOffset need not be 4-aligned.
    const ids = new Uint32Array(count);
    const votes = new Uint32Array(count);
    const ratings = new Uint8Array(count);
    new Uint8Array(ids.buffer).set(buffer.subarray(idsOffset, votesOffset));
    new Uint8Array(votes.buffer).set(buffer.subarray(votesOffset, ratingsOffset));
    ratings.set(buffer.subarray(ratingsOffset));

    for (let i = 1; i < count; i++) {
      if (ids[i - 1] > ids[i]) return null;
    }

    const etag = etagLength > 0 ? buffer.toString('utf8', HEADER_BYTES, HEADER_BYTES + etagLength) : null;
    return { table: new RatingsTable(ids, votes, ratings), etag };
  }

  private static sorted(ids: Uint32Array, votes: Uint32Array, ratings: Uint8Array): RatingsTable {
    let sorted = true;
    for (let i = 1; i < ids.length && sorted; i++) {
      if (ids[i - 1] > ids[i]) sorted = false;
    }
    // Copied so the table does not keep the oversized growth buffers alive.
    if (sorted) return new RatingsTable(ids.slice(), votes.slice(), ratings.slice());

    // id * rows + row: one native sort orders all three arrays, exact while that stays under 2^53.
    const n = ids.length;
    const keys = new Float64Array(n);
    for (let i = 0; i < n; i++) keys[i] = ids[i] * n + i;
    keys.sort();

    const sortedIds = new Uint32Array(n);
    const sortedVotes = new Uint32Array(n);
    const sortedRatings = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const row = keys[i] % n;
      sortedIds[i] = ids[row];
      sortedVotes[i] = votes[row];
      sortedRatings[i] = ratings[row];
    }
    return new RatingsTable(sortedIds, sortedVotes, sortedRatings);
  }
}

function grow<T extends Uint32Array | Uint8Array>(from: T, to: T): T {
  to.set(from);
  return to;
}
