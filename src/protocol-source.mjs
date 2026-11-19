import fs from 'node:fs';
import path from 'node:path';
import { wechatPackageCandidates, wechatUsersDirectory } from './platform/client-paths.mjs';
import { decrypt, inspectArchive } from '../tools/wxapkg.mjs';

export const PROTO_BUNDLE = path.resolve(import.meta.dirname, '../work/extracted/_src_chunks_/src/chunks/game.js');
const APPID = 'wx2ea52a972ea18e5e';
const DROP_IN_BUNDLES = [
  path.resolve(import.meta.dirname, '../_src_chunks_.wxapkg'),
  path.resolve(import.meta.dirname, '../protocol/_src_chunks_.wxapkg'),
];

function permissionFailure(error) {
  // The macOS path helper wraps the original filesystem error with guidance.
  const seen = new Set();
  for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
    if (cause.code === 'EACCES' || cause.code === 'EPERM') return true;
    seen.add(cause);
  }
  return false;
}

function describeSource(selected, kind) {
  const file = path.resolve(selected);
  let stat;
  try { stat = fs.statSync(file); }
  catch (error) {
    if (kind === 'wechat' && ['ENOENT', 'ENOTDIR'].includes(error.code)) {
      throw new Error('微信游戏包 ' + path.basename(path.dirname(file)) + ' 的协议分包尚未下载，请在电脑版微信打开游戏并进入游戏后重试', { cause: error });
    }
    throw error;
  }
  if (!stat.isFile()) throw new Error('协议来源不是文件：' + file);
  fs.accessSync(file, fs.constants.R_OK);
  return Object.freeze({ file, kind, packageVersion: kind === 'wechat' ? path.basename(path.dirname(file)) : null,
    mtimeMs: stat.mtimeMs, size: stat.size, signature: JSON.stringify([file, stat.mtimeMs, stat.size]) });
}

// Describe the selected source without evaluating game code. A running
// connection keeps its loaded protocol; new connections can compare this
// identity to detect a newly downloaded package or an edited explicit file.
export function protocolSourceInfo(bundlePath) {
  const explicit = bundlePath || process.env.CW_PROTO_BUNDLE;
  if (explicit) return describeSource(explicit, 'explicit');
  let cacheError;
  try {
    const cached = wechatPackageCandidates(APPID, { includeIncomplete: true })[0];
    if (cached) return describeSource(cached, 'wechat');
  } catch (error) {
    // A protected client cache should not prevent use of a user-provided file.
    // Missing newest subpackages, corrupt archives and other errors still fail.
    if (!permissionFailure(error)) throw error;
    cacheError = error;
  }
  for (const file of [...DROP_IN_BUNDLES, PROTO_BUNDLE]) {
    try { return describeSource(file, file === PROTO_BUNDLE ? 'extracted' : 'drop-in'); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  const locations = [wechatUsersDirectory(), ...DROP_IN_BUNDLES, PROTO_BUNDLE];
  throw new Error([
    cacheError?.message || '缺少协议文件。',
    '已搜索：', ...locations.map(file => '  ' + file),
    '请在电脑版微信打开《疯狂水世界》并进入游戏，或把 _src_chunks_.wxapkg 放到程序根目录或 protocol/ 子目录。',
    '也可设置 CW_PROTO_BUNDLE 指向自己的 _src_chunks_.wxapkg 或解包后的 src/chunks/game.js。',
  ].join('\n'), cacheError ? { cause: cacheError } : undefined);
}

function readBundle(file) {
  const input = fs.readFileSync(file);
  if (!/\.wxapkg$/i.test(file)) return input.toString('utf8');
  const { data } = decrypt(APPID, input);
  const entry = inspectArchive(data).files.find(item => item.relativePath === 'src/chunks/game.js');
  if (!entry) throw new Error(file + ' 中缺少 src/chunks/game.js，请使用 _src_chunks_.wxapkg');
  return data.toString('utf8', entry.off, entry.off + entry.size);
}

export function readProtocolSource(bundlePath) {
  return readBundle(protocolSourceInfo(bundlePath).file);
}
