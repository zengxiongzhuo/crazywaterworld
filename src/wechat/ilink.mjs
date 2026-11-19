// Application-bearer wire format, based on YYB-Go-Enhanced v0.3.10 (9d5e2bd).
// Only the application-store ManualAuth and this game's wx.login are exposed.
import { createHash, randomBytes, createHmac } from 'node:crypto';
import { varint, readVarint, pbLen, pbVar, pbParse, lz4AllLiteral, lz4Decompress } from './bytes.mjs';
import { generateECDH, hkdfExtract, hkdfExpand, aesGCMEncryptLayout, aesGCMDecryptLayout } from './mmtls-crypto.mjs';
import { buildShortlink, defaultVer } from './mmtls-wire.mjs';

const concat = (...parts) => Buffer.concat(parts);
const text = value => Buffer.from(value);
const hash = (...parts) => createHash('sha256').update(concat(...parts)).digest();
const bytes = (map, field, required = true) => {
  const value = map.get(field);
  if (!Buffer.isBuffer(value) || required && !value.length) {
    if (!required && value === undefined) return Buffer.alloc(0);
    throw Error('微信协议字段格式无效');
  }
  return value;
};
const number = (map, field, fallback = 0n) => {
  const value = map.get(field);
  if (value === undefined) return fallback;
  if (typeof value !== 'bigint') throw Error('微信协议数字字段格式无效');
  return value;
};
export const HOST_APP_ID = 'wxd44977328b36e647';
export const CLIENT_VERSION = 524545;
export const CMD_MANUAL_AUTH = 0x0d7d;
export const CMD_TRANSFER = 0x0b41;
export const ILINK_SERVER_PUBLIC_KEY = Buffer.from('04ef87876d6478b15f1796eab12068610541173b7176b67f1dcc86683e901acd44d18b4ac36938251d0812dd0cf842aa2d6cbb8115712d1c0087dcefc14a44cd58', 'hex');
const ilinkDevice = text('ilinkapp_060000b7b93f6c');
const hybridSalt = text('security hdkf expand');

export class ManualAuthRejectedError extends Error {
  constructor(code) { super('微信授权票据被拒绝（' + code + '），请重新扫码'); this.name = 'ManualAuthRejectedError'; this.code = code; }
}
export class LoginCodeRejectedError extends Error {
  constructor(stage, code) { super('微信小游戏取码被拒绝（' + stage + ':' + code + '）'); this.name = 'LoginCodeRejectedError'; this.stage = stage; this.code = code; }
}

export function parseLoginBuffer(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 65536 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw Error('微信授权票据格式无效');
  const raw = Buffer.from(encoded, 'base64'), fields = pbParse(raw);
  const hostAppId = bytes(fields, 3, false);
  if (hostAppId.length && hostAppId.toString() !== HOST_APP_ID) throw Error('此微信授权渠道尚未支持');
  return { ticket: bytes(fields, 1), deviceId: bytes(fields, 2), hostAppId, raw };
}

export function deriveWechatDevice(seed, account) {
  if (!Buffer.isBuffer(seed) || seed.length < 32 || !account) throw Error('微信设备标识参数无效');
  const derive = label => createHmac('sha256', seed).update(label).update(Buffer.from([0])).update(String(account)).digest();
  const mac = derive('yyb-go/sess-device/v1').subarray(0, 6);
  mac[0] = (mac[0] | 2) & 0xfe;
  return { appDeviceId: derive('yyb-go/app-device/v1'), sessDevice: text([...mac].map(value => value.toString(16).padStart(2, '0').toUpperCase()).join('-')) };
}

export function buildManualAuthRequest(loginBuffer, appDeviceId) {
  const meta = parseLoginBuffer(loginBuffer);
  if (!Buffer.isBuffer(appDeviceId) || !appDeviceId.length || appDeviceId.length > 128) throw Error('微信设备标识无效');
  return concat(pbLen(1, pbLen(1, appDeviceId)), pbVar(2, 1901), pbLen(3, pbLen(1, meta.ticket)), pbVar(4, 4), pbVar(7, 0), pbVar(8, 6));
}

export function wpkgHead(ints = {}, fields = {}) {
  const chunks = [varint(1)];
  for (const key of Object.keys(ints).map(Number).sort((a, b) => a - b)) chunks.push(varint(key), varint(BigInt.asUintN(64, BigInt(ints[key]))));
  chunks.push(varint(0));
  for (const key of Object.keys(fields).map(Number).sort((a, b) => a - b)) chunks.push(varint(key), varint(fields[key].length), fields[key]);
  const prefix = concat(...chunks);
  return concat(prefix, Buffer.from([0]), varint(prefix.length + 1));
}

export function decodeWpkgHead(raw) {
  let offset = 0;
  const read = () => { const result = readVarint(raw, offset); offset = result.offset; return result.value; };
  if (read() !== 1n) throw Error('微信 WPKG 版本无效');
  const ints = new Map(), fields = new Map();
  for (let count = 0; ; count++) {
    if (count > 128) throw Error('微信 WPKG 字段过多');
    const key = read(); if (key === 0n) break;
    if (key > 65535n || ints.has(Number(key))) throw Error('微信 WPKG 字段无效');
    ints.set(Number(key), read());
  }
  for (let count = 0; ; count++) {
    if (count > 128) throw Error('微信 WPKG 字段过多');
    const key = read(); if (key === 0n) break;
    if (key > 65535n || fields.has(Number(key))) throw Error('微信 WPKG 字段无效');
    const size = read();
    if (size > BigInt(raw.length - offset)) throw Error('微信 WPKG 字段被截断');
    fields.set(Number(key), raw.subarray(offset, offset + Number(size))); offset += Number(size);
  }
  const prefixSize = offset;
  if (read() !== BigInt(prefixSize)) throw Error('微信 WPKG 头部长度无效');
  return { ints, fields, length: offset };
}

function baseHeader(uin = 0n, session = false) {
  return { 1:1, 2:uin, 3:0, 4:0, 5:CLIENT_VERSION, 6:11, 7:0, 8:0, 9:0, 10:1, 11:0, 12:0, 13:0, 17:0, 18:1, 20:1504, 21:0, 22:uin, 23:0, 25:session ? 16 : 17, 26:4, 28:1, 29:1, 30:0 };
}

export function hybridECDHEncrypt(plaintext, serverPublicKey = ILINK_SERVER_PUBLIC_KEY, options = {}) {
  const { privateKey, publicKey } = options.ephemeral ?? generateECDH();
  const secret = hash(privateKey.computeSecret(serverPublicKey));
  const hash1 = hash(text('1'), text('415'), publicKey);
  const cek = options.cek ?? randomBytes(32);
  if (cek.length !== 32) throw Error('微信临时密钥长度无效');
  const encryptedKey = aesGCMEncryptLayout(secret.subarray(0, 24), hash1, cek, options.keyCipherOptions);
  const okm = hkdfExpand(hkdfExtract(hybridSalt, cek), hash1, 56);
  const hash2 = hash(text('1'), text('415'), publicKey, encryptedKey);
  const compressed = lz4AllLiteral(plaintext);
  const encryptedBody = aesGCMEncryptLayout(okm.subarray(0, 24), hash2, compressed, options.bodyCipherOptions);
  secret.fill(0);
  const body = concat(pbVar(1, 1), pbLen(2, concat(pbVar(1, 415), pbLen(2, publicKey))), pbLen(3, encryptedKey), pbLen(4, Buffer.alloc(0)), pbLen(5, encryptedBody));
  return { body, temp: { privateKey, okm, compressed } };
}

export function buildLoginBody(loginBuffer, appDeviceId, options) {
  const meta = parseLoginBuffer(loginBuffer);
  const result = hybridECDHEncrypt(buildManualAuthRequest(loginBuffer, appDeviceId), ILINK_SERVER_PUBLIC_KEY, options);
  return { body: concat(wpkgHead(baseHeader(), { 14:Buffer.alloc(0), 24:meta.deviceId, 27:Buffer.alloc(0) }), result.body), temp: result.temp };
}

export function parseLoginResponse(raw, temp) {
  if (!temp?.privateKey || temp.okm?.length !== 56) throw Error('缺少微信临时授权状态');
  let hybrid;
  try { const { length } = decodeWpkgHead(raw); if (raw[length] === 0x0a) hybrid = raw.subarray(length); } catch {}
  // Legacy endpoints prepend a small native envelope without the WPKG header.
  if (!hybrid) { const index = raw.indexOf(Buffer.from('089f03124104', 'hex')); if (index < 2 || index > 220) throw Error('微信授权响应格式无效'); hybrid = raw.subarray(index - 2); }
  const fields = pbParse(hybrid), keyFields = pbParse(bytes(fields, 1));
  if (number(keyFields, 1) !== 415n) throw Error('微信授权响应密钥类型无效');
  const serverPublicKey = bytes(keyFields, 2), credentialType = number(fields, 2, 1n);
  const secret = hash(temp.privateKey.computeSecret(serverPublicKey));
  const aad = hash(temp.okm.subarray(24, 56), temp.compressed, text('415'), serverPublicKey, text(credentialType.toString()));
  try { return lz4Decompress(aesGCMDecryptLayout(secret.subarray(0, 24), aad, bytes(fields, 3))); }
  finally { secret.fill(0); }
}

export function extractSession(raw) {
  const fields = pbParse(raw);
  if (fields.has(1)) { const code = BigInt.asIntN(64, number(pbParse(bytes(fields, 1, false)), 1)); if (code) throw new ManualAuthRejectedError(code); }
  const body = pbParse(bytes(fields, 3)), session = pbParse(bytes(body, 2)), identity = pbParse(bytes(body, 3));
  const result = { sendKey:Buffer.from(bytes(session, 1)), recvKey:Buffer.from(bytes(session, 2)), f9:Buffer.from(bytes(session, 9, false)), uin:number(identity, 1), ticket:Buffer.from(bytes(session, 12, false)), deviceId:Buffer.from(ilinkDevice) };
  if (![16, 24, 32].includes(result.sendKey.length) || ![16, 24, 32].includes(result.recvKey.length) || result.uin === 0n) throw Error('微信授权会话字段不完整');
  return result;
}

function sessionInfo(uin, platform, device) {
  return concat(pbLen(1, text('sessionkey')), pbVar(2, BigInt.asUintN(32, uin)), pbLen(3, device), pbVar(4, 1661404927), pbLen(5, text(platform)), pbVar(6, 0));
}
export function buildJSLoginPlaintext(session, appId, sessDevice) {
  if (!/^wx[0-9a-f]{16}$/.test(appId) || !Buffer.isBuffer(sessDevice) || !sessDevice.length) throw Error('小游戏取码参数无效');
  const app = text(appId);
  const request = concat(pbLen(1, sessionInfo(session.uin, 'UnifiedPCWindows', sessDevice)), pbLen(2, app), pbVar(4, 1), pbLen(5, Buffer.alloc(0)), pbLen(6, Buffer.alloc(0)), pbVar(7, 1));
  return concat(pbLen(1, sessionInfo(session.uin, 'Windows', sessDevice)), pbLen(2, text('/cgi-bin/mmbiz-bin/js-login')), pbLen(3, session.hostAppId?.length ? session.hostAppId : text(HOST_APP_ID)), pbVar(4, 5), pbLen(5, request), pbLen(6, app), pbVar(7, 1029), pbVar(8, 1610627409), pbLen(9, text('WindowsxWebPlugin')), pbVar(10, 573651281));
}

export function buildTransferPacket(session, plaintext) {
  const encrypted = aesGCMEncryptLayout(session.sendKey, Buffer.alloc(0), lz4AllLiteral(plaintext));
  const header = wpkgHead(baseHeader(session.uin, true), { 14:Buffer.alloc(0), 24:session.deviceId, 27:session.f9 });
  const inner = buildShortlink(CMD_TRANSFER, 0, concat(header, encrypted), defaultVer);
  const url = text('/ilink/ilinkapp/mp/wxaruntime_transfer'), host = text('shortcloud.weixin.com');
  const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const envelope = concat(u16(url.length), url, u16(host.length), host, u32(inner.length), inner);
  return concat(u32(envelope.length), envelope);
}

export function sessionDecrypt(body, recvKey) {
  const offsets = [];
  try { offsets.push(decodeWpkgHead(body).length); } catch {}
  for (let i = 0; i < Math.min(body.length, 220); i++) offsets.push(i);
  for (const offset of new Set(offsets)) {
    if (offset < 0 || body.length - offset < 28) continue;
    try { return lz4Decompress(aesGCMDecryptLayout(recvKey, Buffer.alloc(0), body.subarray(offset))); } catch {}
  }
  throw Error('微信小游戏响应解密失败');
}

function loginFields(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > 4 * 1024 * 1024) throw Error('微信小游戏响应格式无效');
  const fields = new Map(); let offset = 0;
  while (offset < raw.length) {
    const tag = readVarint(raw, offset); offset = tag.offset;
    const field = Number(tag.value >> 3n), wire = Number(tag.value & 7n);
    if (field < 1 || field > 0x1fffffff || field <= 3 && fields.has(field)) throw Error('微信小游戏响应字段无效');
    let value;
    if (wire === 0) { const item = readVarint(raw, offset); value = item.value; offset = item.offset; }
    else if (wire === 2) {
      const length = readVarint(raw, offset); offset = length.offset;
      if (length.value > BigInt(raw.length - offset)) throw Error('微信小游戏响应被截断');
      value = raw.subarray(offset, offset + Number(length.value)); offset += Number(length.value);
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (offset + size > raw.length) throw Error('微信小游戏响应被截断');
      offset += size;
    } else throw Error('微信小游戏响应 wire 类型无效');
    if (field <= 3) fields.set(field, { wire, value });
  }
  return fields;
}
const loginBytes = (fields, field) => {
  const item = fields.get(field);
  if (!item || item.wire !== 2) throw Error('微信小游戏响应字段格式无效');
  return item.value;
};
export function parseLoginCodeResponse(raw) {
  const outer = loginFields(raw);
  if (!outer.has(2)) throw Error('微信未返回小游戏登录 code');
  const inner = loginFields(loginBytes(outer, 2));
  for (const [field, stage] of [[1, 'business'], [2, 'result']]) {
    if (!inner.has(field)) continue;
    const status = loginFields(loginBytes(inner, field));
    const item = status.get(1);
    if (item && item.wire !== 0) throw Error('微信小游戏响应状态格式无效');
    const code = BigInt.asIntN(32, item?.value ?? 0n);
    if (code) throw new LoginCodeRejectedError(stage, code);
  }
  const code = inner.has(3) ? loginBytes(inner, 3) : Buffer.alloc(0);
  if (!code.length) throw Error('微信未返回小游戏登录 code');
  if (code.length > 2048 || !/^[\x21-\x7e]+$/.test(code.toString('utf8'))) throw Error('微信小游戏登录 code 格式无效');
  return code.toString('utf8');
}
