import { randomUUID } from 'crypto';
import consola from 'consola';
import { Group, Result, nextDeadline } from './engine';

const logger = consola.withTag('SyncPlay');

export interface GroupStore {
  get(id: string): Promise<Group | null>;
  list(): Promise<Group[]>;
  groupOf(memberKey: string): Promise<string | null>;
  /** Null when the group's lock could not be taken. */
  update(id: string, fn: (g: Group | null) => Result): Promise<Result | null>;
  due(nowMs: number): Promise<string[]>;
  forget(id: string): Promise<void>;
  /** Drops a member's key only while it still names that group. */
  release(memberKey: string, groupId: string): Promise<void>;
}

const GROUP_TTL_S = 86400;
const DELETE_IF =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end return 0";

const copy = <T>(value: T): T => (value == null ? value : JSON.parse(JSON.stringify(value)));
const keysOf = (g: Group | null): string[] => (g ? g.members.map((m) => m.key) : []);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRedisStore(redis: any, prefix = 'jf:sp:', options: { lockMs?: number; waitMs?: number } = {}): GroupStore {
  const lockMs = options.lockMs ?? 2000;
  const waitMs = options.waitMs ?? 2000;
  const groupKey = (id: string) => `${prefix}g:${id}`;
  const memberKey = (key: string) => `${prefix}m:${key}`;
  const lockKey = (id: string) => `${prefix}lock:${id}`;
  const GROUPS = `${prefix}groups`;
  const DUE = `${prefix}due`;

  const parse = (raw: string | null): Group | null => {
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  async function lock(id: string): Promise<string | null> {
    const token = randomUUID();
    const until = Date.now() + waitMs;
    for (;;) {
      if ((await redis.set(lockKey(id), token, 'PX', lockMs, 'NX')) === 'OK') return token;
      if (Date.now() >= until) return null;
      await sleep(25);
    }
  }

  const forget = async (id: string): Promise<void> => {
    await redis.multi().zrem(DUE, id).srem(GROUPS, id).exec();
  };

  return {
    get: async (id) => parse(await redis.get(groupKey(id))),

    async list() {
      const ids: string[] = await redis.smembers(GROUPS);
      if (!ids.length) return [];
      const raw: Array<string | null> = await redis.mget(ids.map(groupKey));
      const groups: Group[] = [];
      for (const [i, value] of raw.entries()) {
        const g = parse(value);
        if (g) groups.push(g);
        else await forget(ids[i]);
      }
      return groups;
    },

    groupOf: async (key) => (await redis.get(memberKey(key))) ?? null,

    async update(id, fn) {
      const token = await lock(id);
      if (!token) {
        logger.warn(`SyncPlay group ${id} is locked; request dropped`);
        return null;
      }
      try {
        const before = parse(await redis.get(groupKey(id)));
        const result = fn(copy(before));
        const after = result.group;
        if (!before && !after) return result;
        const tx = redis.multi();
        if (after) {
          const kept = new Set(keysOf(after));
          tx.set(groupKey(id), JSON.stringify(after), 'EX', GROUP_TTL_S);
          for (const key of kept) tx.set(memberKey(key), id, 'EX', GROUP_TTL_S);
          for (const key of keysOf(before)) if (!kept.has(key)) tx.eval(DELETE_IF, 1, memberKey(key), id);
          tx.sadd(GROUPS, id);
          tx.zadd(DUE, nextDeadline(after), id);
        } else {
          tx.del(groupKey(id));
          for (const key of keysOf(before)) tx.eval(DELETE_IF, 1, memberKey(key), id);
          tx.srem(GROUPS, id);
          tx.zrem(DUE, id);
        }
        await tx.exec();
        return result;
      } finally {
        await redis.eval(DELETE_IF, 1, lockKey(id), token).catch(() => undefined);
      }
    },

    due: async (nowMs) => redis.zrangebyscore(DUE, '-inf', nowMs === Infinity ? '+inf' : nowMs),

    forget,

    async release(key, groupId) {
      await redis.eval(DELETE_IF, 1, memberKey(key), groupId);
    },
  };
}

/** For tests only: the server never starts without Redis. */
export function createMemoryStore(): GroupStore {
  const groups = new Map<string, Group>();
  const members = new Map<string, string>();
  const chains = new Map<string, Promise<unknown>>();

  return {
    get: async (id) => copy(groups.get(id) ?? null),
    list: async () => [...groups.values()].map(copy),
    groupOf: async (key) => members.get(key) ?? null,

    update(id, fn) {
      const run = (chains.get(id) ?? Promise.resolve()).then(() => {
        const before = groups.get(id) ?? null;
        const result = fn(copy(before));
        const after = result.group;
        for (const key of keysOf(before)) if (members.get(key) === id) members.delete(key);
        if (after) {
          groups.set(id, copy(after));
          for (const key of keysOf(after)) members.set(key, id);
        } else {
          groups.delete(id);
        }
        return result;
      });
      const settled = run.catch(() => undefined);
      chains.set(id, settled);
      void settled.then(() => {
        if (chains.get(id) === settled) chains.delete(id);
      });
      return run;
    },

    due: async (nowMs) => [...groups.values()].filter((g) => nextDeadline(g) <= nowMs).map((g) => g.id),
    forget: async () => undefined,
    async release(key, groupId) {
      if (members.get(key) === groupId) members.delete(key);
    },
  };
}
