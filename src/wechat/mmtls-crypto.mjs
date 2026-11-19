// Protocol-specific key derivation and authenticated record layouts.
// Reference: YYB-Go-Enhanced v0.3.10, internal/protocol/mmtls_crypto.go.
import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, randomBytes } from 'node:crypto';
import { uint64 } from './bytes.mjs';
export const sha256 = bytes => createHash('sha256').update(bytes).digest();
export const labelExpandedSecret = Buffer.from('expanded secret');
export const labelHandshakeKeys = Buffer.from('handshake key expansion');
export const labelAppDataKeys = Buffer.from('application data key expansion');
export const labelEarlyKeys = Buffer.from('early data key expansion');
export const ilinkHKDFSalt = Buffer.from('security hdkf expand');
export function hkdfExtract(salt, ikm) { return createHmac('sha256', salt).update(ikm).digest(); }
export function hkdfExpand(prk, info, length) {
  if (!Number.isInteger(length) || length < 0 || length > 255 * 32) throw Error('HKDF 长度无效');
  let previous = Buffer.alloc(0), written = 0;
  const chunks = [];
  for (let counter = 1; written < length; counter++) {
    previous = createHmac('sha256', prk).update(previous).update(info).update(Buffer.from([counter])).digest();
    chunks.push(previous); written += previous.length;
  }
  return Buffer.concat(chunks).subarray(0, length);
}
export const expandLabel = (secret, label, context, length) => hkdfExpand(secret, Buffer.concat([Buffer.from(label), context ? Buffer.from(context) : Buffer.alloc(0)]), length);
export function generateECDH({ privateKey } = {}) {
  const key = createECDH('prime256v1');
  if (privateKey) key.setPrivateKey(privateKey); else key.generateKeys();
  return { privateKey: key, publicKey: key.getPublicKey(undefined, 'uncompressed') };
}
export function mmtlsSecret(privateKey, peerPub) {
  if (peerPub.length !== 65 || peerPub[0] !== 4) throw Error('MMTLS 公钥格式无效');
  return sha256(privateKey.computeSecret(peerPub));
}
export function nonce(iv, sequence) {
  if (iv.length !== 12) throw Error('GCM IV 长度无效');
  const result = Buffer.from(iv), counter = Buffer.alloc(8); counter.writeBigUInt64BE(uint64(sequence));
  for (let i = 0; i < 8; i++) result[i + 4] ^= counter[i];
  return result;
}
function cipherName(key) {
  if (![16, 24, 32].includes(key.length)) throw Error('AES 密钥长度无效');
  return `aes-${key.length * 8}-gcm`;
}
export function gcmEncrypt(key, iv, sequence, plaintext, aad) {
  const cipher = createCipheriv(cipherName(key), key, nonce(iv, sequence), { authTagLength: 16 });
  cipher.setAAD(aad); return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
export function gcmDecrypt(key, iv, sequence, ciphertext, aad) {
  if (ciphertext.length < 16) throw Error('GCM 认证标签被截断');
  const decipher = createDecipheriv(cipherName(key), key, nonce(iv, sequence), { authTagLength: 16 });
  decipher.setAAD(aad); decipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
}
export function buildRecordAAD(sequence, contentType, cipherLen) {
  if (!Number.isInteger(cipherLen) || cipherLen < 16 || cipherLen > 65535) throw Error('MMTLS 记录长度无效');
  const aad = Buffer.alloc(13); aad.writeBigUInt64BE(uint64(sequence)); aad[8] = contentType;
  aad.writeUInt16BE(0xf103, 9); aad.writeUInt16BE(cipherLen, 11); return aad;
}
export const encryptRecordPayload = (key, iv, seq, type, plain) => gcmEncrypt(key, iv, seq, plain, buildRecordAAD(seq, type, plain.length + 16));
export const decryptRecordPayload = (key, iv, seq, type, ciphertext) => gcmDecrypt(key, iv, seq, ciphertext, buildRecordAAD(seq, type, ciphertext.length));
export function splitBiKeys(bytes) {
  if (bytes.length !== 56) throw Error('MMTLS 双向密钥长度无效');
  return { clientKey: Buffer.from(bytes.subarray(0, 16)), serverKey: Buffer.from(bytes.subarray(16, 32)), clientIV: Buffer.from(bytes.subarray(32, 44)), serverIV: Buffer.from(bytes.subarray(44, 56)) };
}
export const deriveMaster = (secret, hash) => expandLabel(secret, labelExpandedSecret, hash, 32);
export const deriveHandshakeKeys = (secret, hash) => splitBiKeys(expandLabel(secret, labelHandshakeKeys, hash, 56));
export const deriveAppKeys = (master, hash) => splitBiKeys(expandLabel(master, labelAppDataKeys, hash, 56));
export function finishedVerifyData(secret, client, hash) {
  const key = expandLabel(secret, Buffer.from(client ? 'client finished' : 'server finished'), null, 32);
  return createHmac('sha256', key).update(hash).digest();
}
export const derivePSK = (secret, hash, type) => expandLabel(secret, Buffer.from(type === 1 ? 'PSK_ACCESS' : 'PSK_REFRESH'), hash, 32);
export function derivePSKOneWayKeys(psk, label, hash) {
  const bytes = expandLabel(psk, label, hash, 28); return { key: Buffer.from(bytes.subarray(0, 16)), iv: Buffer.from(bytes.subarray(16)) };
}
export function aesGCMEncryptLayout(key, aad, plaintext, { iv = randomBytes(12) } = {}) {
  const sealed = gcmEncrypt(key, iv, 0n, plaintext, aad);
  return Buffer.concat([sealed.subarray(0, -16), iv, sealed.subarray(-16)]);
}
export function aesGCMDecryptLayout(key, aad, blob) {
  if (blob.length < 28) throw Error('GCM 消息被截断');
  return gcmDecrypt(key, blob.subarray(-28, -16), 0n, Buffer.concat([blob.subarray(0, -28), blob.subarray(-16)]), aad);
}
