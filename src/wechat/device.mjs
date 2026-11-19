import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from '../accounts.mjs';
import { atomicJson, readJson, withFileLock } from '../json-store.mjs';
import { deriveWechatDevice } from './ilink.mjs';

// A local random installation seed, not a WeChat credential. Account identity
// is used transiently for derivation and is never written into this file.
export function createWechatDevice(identityKey, { directory = DATA_DIR } = {}) {
  if (typeof identityKey !== 'string' || !/^[a-f0-9]{64}$/.test(identityKey)) throw Error('微信授权身份无效，请重新扫码');
  const file = path.join(directory, 'wechat-device.json');
  const seed = withFileLock(file, () => {
    let data = readJson(file, null);
    if (data === null) { data = { version: 1, seed: randomBytes(32).toString('hex') }; atomicJson(file, data); }
    if (data.version !== 1 || typeof data.seed !== 'string' || !/^[a-f0-9]{64}$/.test(data.seed)) throw Error('微信设备种子文件无效，请先检查数据文件');
    return Buffer.from(data.seed, 'hex');
  });
  try { return deriveWechatDevice(seed, identityKey); } finally { seed.fill(0); }
}
