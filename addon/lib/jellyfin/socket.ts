import consola from 'consola';
import { createHash } from 'crypto';
import { envInt } from '../../utils/envNumber';
import { readToken } from './tokens';

const logger = consola.withTag('Jellyfin');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PATH = /^\/jellyfin\/([^/?]+)(?:\/emby)?\/socket(?:\?|$)/i;

function accept(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

function reject(socket: any, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * Text frames only, and every message here is well under the 125 byte cutoff
 * that would need an extended length. A server frame is never masked.
 */
function textFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  if (body.length > 125) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

/** Opcode and unmasked payload of one client frame, or null if it is partial. */
function readFrame(buffer: Buffer): { opcode: number; payload: Buffer; size: number } | null {
  if (buffer.length < 2) return null;

  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }

  return { opcode, payload, size: offset + length };
}

/**
 * The official clients open this straight after signing in and log an error for
 * the lifetime of the session when it is missing. Nothing is pushed over it:
 * every list here is fetched, so the socket exists to be answered, not to carry
 * events.
 */
export function attachJellyfinSocket(server: any): void {
  const perUser = new Map<string, number>();
  const maxPerUser = envInt('JELLYFIN_SOCKETS_PER_USER', 16, 1);

  server.on('upgrade', async (req: any, socket: any, _head: Buffer) => {
    const url = String(req.url ?? '');
    const match = PATH.exec(url);
    if (!match) return;

    const query = new URLSearchParams(url.split('?')[1] ?? '');
    const token = query.get('api_key') ?? query.get('ApiKey') ?? undefined;
    const key = req.headers['sec-websocket-key'];

    if (!key) {
      reject(socket, 400, 'Bad Request');
      return;
    }

    let userUUID: string | null = null;
    try {
      userUUID = await readToken(token ?? undefined);
    } catch {
      userUUID = null;
    }

    if (!userUUID || userUUID !== decodeURIComponent(match[1])) {
      reject(socket, 401, 'Unauthorized');
      return;
    }

    if ((perUser.get(userUUID) ?? 0) >= maxPerUser) {
      reject(socket, 429, 'Too Many Requests');
      return;
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept(String(key))}\r\n\r\n`
    );

    perUser.set(userUUID, (perUser.get(userUUID) ?? 0) + 1);
    socket.setTimeout(0);
    socket.setNoDelay(true);

    const send = (MessageType: string, Data: any = null) => {
      if (!socket.destroyed) socket.write(textFrame(JSON.stringify({ MessageType, Data })));
    };

    send('ForceKeepAlive', 60);
    const timer = setInterval(() => send('KeepAlive'), envInt('JELLYFIN_SOCKET_PING_MS', 30000, 1000));

    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);

      for (;;) {
        const frame = readFrame(pending);
        if (!frame) break;
        pending = pending.subarray(frame.size);

        if (frame.opcode === 0x8) {
          // Echoed so the client sees a clean close rather than a dropped one.
          socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
          socket.end();
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(Buffer.from([0x8a, 0x00]));
          continue;
        }
        if (frame.opcode !== 0x1) continue;

        try {
          if (JSON.parse(frame.payload.toString('utf8'))?.MessageType === 'KeepAlive') send('KeepAlive');
        } catch {
          // A client is free to send anything; nothing here depends on it.
        }
      }
    });

    const release = () => {
      clearInterval(timer);
      const left = (perUser.get(userUUID as string) ?? 1) - 1;
      if (left <= 0) perUser.delete(userUUID as string);
      else perUser.set(userUUID as string, left);
    };

    socket.on('close', release);
    socket.on('error', release);
  });

  logger.debug('Jellyfin websocket attached');
}
