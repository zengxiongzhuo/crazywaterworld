// Authenticated MMTLS-over-HTTP, limited to one application login-code request.
import { randomBytes, createHash } from 'node:crypto';
import { buildPSKClientHello, buildRecord, parseRecords, parseShortlink, ctPSKHandshake, ctHandshake, ctAppData, ctAlert } from './mmtls-wire.mjs';
import { derivePSKOneWayKeys, labelEarlyKeys, labelHandshakeKeys, encryptRecordPayload, decryptRecordPayload } from './mmtls-crypto.mjs';
import { decodeWpkgHead, sessionDecrypt, CMD_TRANSFER } from './ilink.mjs';
import { requestWechatHTTP, SHORT_HOST } from './newdns.mjs';
const join = (...parts) => Buffer.concat(parts);
const hash = (...parts) => createHash('sha256').update(join(...parts)).digest();

export class ShortlinkRejectedError extends Error {
  constructor(code, transport = false) { super('微信取码' + (transport ? '传输' : '业务') + '拒绝（' + code + '）'); this.name = 'ShortlinkRejectedError'; this.code = code; this.transport = transport; }
}
export function shortlinkHeaderRejection(raw) {
  let header;
  try { header = decodeWpkgHead(raw); } catch { return null; }
  if (header.length !== raw.length) return null;
  for (const [field, transport] of [[4, true], [23, false]]) {
    const code = BigInt.asIntN(64, header.ints.get(field) ?? 0n);
    if (code) return new ShortlinkRejectedError(code, transport);
  }
  return null;
}
export function build0RTTRequest(entry, envelope, { now = Date.now, random = randomBytes } = {}) {
  if (!/^[a-f0-9]{64}$/i.test(entry.preSharedKey) || !/^(?:[a-f0-9]{2})+$/i.test(entry.ticketEntry)) throw Error('微信取码票据格式无效');
  const psk = Buffer.from(entry.preSharedKey, 'hex'), ticket = Buffer.from(entry.ticketEntry, 'hex'), timestamp = Math.floor(now() / 1000);
  if (ticket.length > 65500 || entry.expiredAt && entry.expiredAt <= timestamp) throw Error('微信取码票据已过期');
  const hello = buildPSKClientHello(random(32), timestamp, ticket);
  const keys = derivePSKOneWayKeys(psk, labelEarlyKeys, hash(hello));
  const time = Buffer.alloc(4); time.writeUInt32BE(timestamp);
  const type8 = join(Buffer.from('00000010080000000b01000000060012', 'hex'), time);
  const body = join(buildRecord(ctPSKHandshake, hello),
    buildRecord(ctPSKHandshake, encryptRecordPayload(keys.key, keys.iv, 1n, ctPSKHandshake, type8)),
    buildRecord(ctAppData, encryptRecordPayload(keys.key, keys.iv, 2n, ctAppData, envelope)),
    buildRecord(ctAlert, encryptRecordPayload(keys.key, keys.iv, 3n, ctAlert, Buffer.from('00000003000101', 'hex'))));
  keys.key.fill(0); keys.iv.fill(0);
  return { body, psk, hello, type8, timestamp };
}

export function parse0RTTResponse(raw, { psk, hello, type8 }, recvKey) {
  let parsed;
  try { parsed = parseRecords(raw); } catch { throw Error('微信短连接记录无效'); }
  if (parsed.consumed !== raw.length) throw Error('微信短连接记录被截断');
  const serverHello = parsed.records.find(record => record.contentType === ctHandshake)?.payload;
  const application = parsed.records.find(record => record.contentType === ctAppData)?.payload;
  if (!serverHello || !application) throw Error('微信短连接缺少响应记录');
  for (const transcript of [join(hello, serverHello), join(hello, type8, serverHello), join(hello, serverHello, type8)]) {
    const keys = derivePSKOneWayKeys(psk, labelHandshakeKeys, hash(transcript));
    try {
      for (const seq of [2n, 1n, 3n]) {
        let plaintext;
        try { plaintext = decryptRecordPayload(keys.key, keys.iv, seq, ctAppData, application); } catch { continue; }
        let body = plaintext;
        try {
          const packet = parseShortlink(plaintext);
          if (packet.totalLen !== plaintext.length || packet.cmd !== CMD_TRANSFER) throw Error('微信小游戏响应命令无效');
          body = packet.body;
        } catch (error) { if (error.message === '微信小游戏响应命令无效') throw error; }
        const rejected = shortlinkHeaderRejection(body);
        if (rejected) throw rejected;
        return sessionDecrypt(body, recvKey);
      }
    } finally { keys.key.fill(0); keys.iv.fill(0); }
  }
  throw Error('微信短连接认证失败');
}

export async function send0RTT(targets, entry, recvKey, envelope, { signal, timeoutMs = 10000, fetcher = requestWechatHTTP, now = Date.now } = {}) {
  let last;
  for (const target of targets.slice(0, 6)) {
    signal?.throwIfAborted();
    const prepared = build0RTTRequest(entry, envelope, { now });
    try {
      const hostname = target.ip.includes(':') ? '[' + target.ip + ']' : target.ip;
      const response = await fetcher(`http://${hostname}:${target.port}/mmtls/${prepared.timestamp.toString(16).padStart(8, '0')}`, {
        method: 'POST', body: prepared.body, signal, timeoutMs, maxBytes: 4 * 1024 * 1024, redirect: 'error',
        headers: { host: SHORT_HOST, 'x-online-host': SHORT_HOST, upgrade: 'mmtls', 'content-type': 'application/octet-stream', 'content-length': String(prepared.body.length), 'user-agent': 'MicroMessenger Client', connection: 'close', 'cache-control': 'no-cache', accept: '*/*' },
      });
      if (!response.ok) throw Error('微信短连接 HTTP 请求失败');
      // A response is never replayed: a code may already have been consumed.
      return parse0RTTResponse(Buffer.from(await response.arrayBuffer()), prepared, recvKey);
    } catch (error) {
      signal?.throwIfAborted(); last = error;
      // Only a connection-establishment failure known not to have sent bytes
      // can safely try another target. Generic fetch errors do not prove this.
      if (error.code !== 'WECHAT_DIAL_FAILED') throw error;
    } finally { prepared.psk.fill(0); }
  }
  throw last ?? Error('没有微信短连接地址');
}
