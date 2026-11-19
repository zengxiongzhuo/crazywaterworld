// MMTLS record and handshake layouts, distinct from standard TLS records.
// Reference: YYB-Go-Enhanced v0.3.10, internal/protocol/mmtls_protocol.go.
import { MAX_WIRE_BYTES } from './bytes.mjs';
export const recordVersion = 0xf103;
export const ctAlert = 0x15, ctHandshake = 0x16, ctAppData = 0x17, ctPSKHandshake = 0x19;
export const hsClientHello = 1, hsServerHello = 2, hsNewSessionTicket = 4, hsCertVerify = 15, hsFinished = 20;
export const cipherECDHE = 0xc02b, cipherPSK = 0x00a8, groupSecP256R1 = 1;
export const shortlinkMagic = 0x1110, defaultVer = 0x076d, cmdManualAuth = 0x0d7d;
export const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; };
export const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const join = (...parts) => Buffer.concat(parts);
export const knownContentType = type => [0x14, ctAlert, ctHandshake, ctAppData, ctPSKHandshake].includes(type);
export function buildRecord(contentType, payload) {
  if (!knownContentType(contentType) || payload.length > 65535) throw Error('MMTLS 记录类型或长度无效');
  return join(Buffer.from([contentType]), u16(recordVersion), u16(payload.length), payload);
}
export function parseRecords(data) {
  if (data.length > MAX_WIRE_BYTES) throw Error('MMTLS 输入过大');
  let offset = 0;
  const records = [];
  while (offset + 5 <= data.length) {
    const contentType = data[offset], version = data.readUInt16BE(offset + 1), length = data.readUInt16BE(offset + 3);
    if (!knownContentType(contentType) || version !== recordVersion) throw Error('MMTLS 记录头无效');
    if (offset + 5 + length > data.length) break;
    records.push({ contentType, payload: Buffer.from(data.subarray(offset + 5, offset + 5 + length)) });
    offset += 5 + length;
  }
  return { records, consumed: offset };
}
export function buildHandshake(type, body) {
  if (body.length + 5 > 65535) throw Error('MMTLS 握手消息过大');
  return join(u32(body.length + 1), Buffer.from([type]), body);
}
export function splitHandshake(payload) {
  if (payload.length < 5) throw Error('MMTLS 握手消息被截断');
  const total = payload.readUInt32BE(0);
  if (total < 1 || total + 4 !== payload.length) throw Error('MMTLS 握手长度不符');
  return { type: payload[4], body: Buffer.from(payload.subarray(5)) };
}
export function buildClientHello(random, timestamp, g1Pub, g2Pub) {
  if (random.length !== 32 || g1Pub.length !== 65 || g2Pub.length !== 65) throw Error('ClientHello 随机数或公钥长度无效');
  const offer = (group, key) => { const entry = join(u32(group), u16(key.length), key); return join(u32(entry.length), entry); };
  const shares = join(Buffer.from([0, 16, 2]), offer(1, g1Pub), offer(2, g2Pub), u32(1));
  const extensions = join(Buffer.from([1]), u32(shares.length), shares);
  return buildHandshake(hsClientHello, join(Buffer.from([3, 0xf1, 1]), u16(cipherECDHE), random, u32(timestamp), u32(extensions.length), extensions));
}
export function buildPSKClientHello(random, timestamp, ticketEntry) {
  if (random.length !== 32 || ticketEntry.length > 60000) throw Error('PSK ClientHello 参数无效');
  const entry = join(Buffer.from([0, 15, 1]), u32(ticketEntry.length), ticketEntry);
  const extensions = join(Buffer.from([1]), u32(entry.length), entry);
  return buildHandshake(hsClientHello, join(Buffer.from([3, 0xf1, 1]), u16(cipherPSK), random, u32(timestamp), u32(extensions.length), extensions));
}
export function extractKeyShares(data) {
  const keys = [];
  for (let i = 0; i + 67 <= data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 65 && data[i + 2] === 4) {
      keys.push(Buffer.from(data.subarray(i + 2, i + 67))); i += 66;
    }
  }
  return keys;
}
export function parseServerHello(body) {
  if (body.length < 40) throw Error('ServerHello 被截断');
  if (body[0] !== 3 || body[1] !== 0xf1) throw Error('ServerHello 版本不符');
  const cipher = body.readUInt16BE(2), random = Buffer.from(body.subarray(4, 36)), length = body.readUInt32BE(36);
  if (40 + length !== body.length) throw Error('ServerHello 扩展长度不符');
  const extensions = body.subarray(40);
  let serverGroup = groupSecP256R1, serverPubKey;
  if (extensions[0] === 1) {
    if (extensions.length < 13 || extensions.readUInt32BE(1) > extensions.length - 5) throw Error('ServerKeyShare 被截断');
    serverGroup = extensions.readUInt32BE(7);
    const keyLen = extensions.readUInt16BE(11);
    if (keyLen !== 65 || 13 + keyLen > extensions.length) throw Error('ServerKeyShare 公钥长度无效');
    serverPubKey = Buffer.from(extensions.subarray(13, 13 + keyLen));
  } else serverPubKey = extractKeyShares(extensions)[0];
  if (!serverPubKey || serverPubKey[0] !== 4) throw Error('ServerHello 缺少有效公钥');
  return { serverRandom: random, cipher, serverGroup, serverPubKey };
}
export function buildFinished(verifyData) {
  if (verifyData.length !== 32) throw Error('Finished 验证值长度无效');
  return buildHandshake(hsFinished, join(u16(32), verifyData));
}
export function parseFinished(body) {
  if (body.length !== 34 || body.readUInt16BE(0) !== 32) throw Error('Finished 被截断或长度无效');
  return Buffer.from(body.subarray(2));
}
export function parseNewSessionTicket(body) {
  if (!body.length) return [];
  const tickets = [];
  let offset = 1;
  for (let i = 0; i < body[0]; i++) {
    if (offset + 4 > body.length) throw Error('SessionTicket 长度被截断');
    const size = body.readUInt32BE(offset); offset += 4;
    if (size < 5 || offset + size > body.length) throw Error('SessionTicket 内容被截断');
    const entry = Buffer.from(body.subarray(offset, offset + size)); offset += size;
    tickets.push({ pskType: entry[0], lifetime: entry.readUInt32BE(1), ticketEntry: entry });
  }
  if (offset !== body.length) throw Error('SessionTicket 尾部长度不符');
  return tickets;
}
export function buildShortlink(cmd, seq, body, ver = defaultVer) {
  if (body.length > MAX_WIRE_BYTES - 16) throw Error('Shortlink 消息过大');
  return join(u32(body.length + 16), u16(shortlinkMagic), u16(ver || defaultVer), u32(cmd), u32(seq), body);
}
export function parseShortlink(packet) {
  if (packet.length < 16 || packet.length > MAX_WIRE_BYTES) throw Error('Shortlink 消息长度无效');
  const totalLen = packet.readUInt32BE(0), magic = packet.readUInt16BE(4);
  if (totalLen !== packet.length || magic !== shortlinkMagic) throw Error('Shortlink 消息被截断或头无效');
  return { totalLen, magic, ver: packet.readUInt16BE(6), cmd: packet.readUInt32BE(8), seq: packet.readUInt32BE(12), body: Buffer.from(packet.subarray(16)) };
}
