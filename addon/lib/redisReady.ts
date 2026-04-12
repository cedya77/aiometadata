import redis from './redisClient';

const DEFAULT_REDIS_READY_TIMEOUT_MS = parseInt(process.env.REDIS_READY_TIMEOUT_MS || '15000', 10);

function removeListeners(target, listeners) {
  for (const [eventName, listener] of listeners) {
    target.off(eventName, listener);
  }
}

export async function waitForRedisReady(timeoutMs = DEFAULT_REDIS_READY_TIMEOUT_MS): Promise<boolean> {
  if (!redis) {
    return false;
  }

  if (String(redis.status) === 'ready') {
    return true;
  }

  if (redis.status === 'wait' || redis.status === 'end' || redis.status === 'close') {
    try {
      await redis.connect();
    } catch (error: any) {
      const message = error?.message || '';
      const isAlreadyConnecting =
        message.includes('Redis is already connecting') ||
        message.includes('Redis is already connected');

      if (!isAlreadyConnecting && String(redis.status) !== 'ready') {
        throw error;
      }
    }
  }

  if (String(redis.status) === 'ready') {
    return true;
  }

  await new Promise<void>((resolve, reject) => {
    const listeners: Array<[string, (...args: any[]) => void]> = [];
    let timeoutHandle: NodeJS.Timeout | undefined;

    const finish = (callback: () => void) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      removeListeners(redis, listeners);
      callback();
    };

    const onReady = () => finish(resolve);
    const onEnd = () => finish(() => reject(new Error('Redis connection ended before becoming ready')));
    const onClose = () => {
      if (String(redis.status) === 'ready') {
        finish(resolve);
      }
    };

    listeners.push(['ready', onReady], ['end', onEnd], ['close', onClose]);

    for (const [eventName, listener] of listeners) {
      redis.on(eventName, listener);
    }

    timeoutHandle = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for Redis to become ready after ${timeoutMs}ms (last status: ${redis.status})`)));
    }, timeoutMs);
  });

  return true;
}
