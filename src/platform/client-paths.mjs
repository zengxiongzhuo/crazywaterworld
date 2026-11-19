import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function directoryEntries(root, platform = process.platform) {
  try {
    return fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    if (platform === 'darwin' && ['EPERM', 'EACCES'].includes(error.code)) {
      throw new Error([
        `无权读取微信缓存目录：${root}`,
        'macOS 可能限制了当前终端的文件访问。请在系统设置 → 隐私与安全性 → 完全磁盘访问中添加当前终端，然后完全退出并重新打开终端。',
        '也可使用自备协议包启动：CW_PROTO_BUNDLE="/绝对路径/_src_chunks_.wxapkg" npm start',
        '离线配置表可通过 CW_CONFIG_PACK 指定。',
      ].join('\n'), { cause: error });
    }
    throw error;
  }
}

function directories(root, platform) {
  return directoryEntries(root, platform).filter(entry => entry.isDirectory()).map(entry => entry.name);
}

export function wechatUsersDirectory({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (platform === 'darwin' && !env.APPDATA) {
    const containers = ['com.tencent.xinWeChat', 'com.tencent.WeChat'];
    const roots = containers.map(name => path.join(home, 'Library', 'Containers', name, 'Data', 'Documents', 'app_data', 'radium', 'users'));
    return roots.find(root => fs.existsSync(root)) || roots[0];
  }
  return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Tencent', 'xwechat', 'radium', 'users');
}

export function wechatPackageCandidates(appId, options) {
  const users = wechatUsersDirectory(options);
  const candidates = [];
  for (const user of directories(users, options?.platform)) {
    const root = path.join(users, user, 'applet', 'packages', appId);
    for (const version of directories(root, options?.platform).filter(name => /^\d+$/.test(name))) {
      const file = path.join(root, version, '_src_chunks_.wxapkg');
      const complete = fs.existsSync(file);
      // Strict consumers must notice a newer installed main package even if
      // WeChat has not downloaded its protocol subpackage yet. Empty version
      // directories alone are not evidence of an installed release.
      let mainPresent = false;
      if (options?.includeIncomplete) {
        try { mainPresent = fs.statSync(path.join(root, version, '__APP__.wxapkg')).isFile(); }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      }
      if (complete || mainPresent) candidates.push({ version: Number(version), file, complete });
    }
  }
  return candidates.sort((left, right) => right.version - left.version || Number(right.complete) - Number(left.complete)).map(entry => entry.file);
}

export function wechatCacheDirectories(appId, options) {
  const users = wechatUsersDirectory(options);
  return directories(users, options?.platform).map(user => path.join(users, user, 'applet', 'local', appId, 'usr', 'gamecaches'));
}

export function wechatConfigCandidates(appId, options) {
  const found = [];
  for (const cache of wechatCacheDirectories(appId, options)) {
    const directory = path.join(cache, 'config_cn');
    for (const entry of directoryEntries(directory, options?.platform)) {
      if (entry.isFile() && entry.name.endsWith('.json')) found.push(path.join(directory, entry.name));
    }
  }
  return found;
}
