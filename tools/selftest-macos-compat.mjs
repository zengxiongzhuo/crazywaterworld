// Offline platform fixtures: never launch a browser or read real WeChat accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { wechatUsersDirectory, wechatPackageCandidates, wechatConfigCandidates } from '../src/platform/client-paths.mjs';
import { openBrowser } from '../src/platform/browser.mjs';

const temporary = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporary, 'cw-macos-compat-'));
const appId = 'fixture-app';
const home = path.join(directory, 'mac home');
const options = { env: {}, home, platform: 'darwin' };
const containers = ['com.tencent.xinWeChat', 'com.tencent.WeChat'].map(name =>
  path.join(home, 'Library', 'Containers', name, 'Data', 'Documents', 'app_data', 'radium', 'users'));
const write = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}'); return file; };
let passed = 0;
const test = (name, run) => { run(); passed++; console.log('通过：' + name); };
const withDeniedDirectory = (target, code, run) => {
  const original = fs.readdirSync;
  const denied = Object.assign(new Error('fixture permission denied'), { code });
  fs.readdirSync = function (file, ...args) {
    if (String(file) === target) throw denied;
    return original.call(this, file, ...args);
  };
  try { run(denied); } finally { fs.readdirSync = original; }
};
const permissionHint = error => {
  assert.match(error.message, /完全磁盘访问/);
  assert.match(error.message, /CW_PROTO_BUNDLE/);
  assert.doesNotMatch(error.message, /start\.command/);
  return true;
};

try {
  test('Mac 未安装微信时返回默认容器路径，扫描空缓存不报错', () => {
    assert.equal(wechatUsersDirectory(options), containers[0]);
    assert.deepEqual(wechatPackageCandidates(appId, options), []);
    assert.deepEqual(wechatConfigCandidates(appId, options), []);
  });

  test('识别另一种 Mac 微信容器，按版本扫描协议并保留未下载分包检查', () => {
    const root = path.join(containers[1], 'fixture-user', 'applet', 'packages', appId);
    const older = write(path.join(root, '2', '_src_chunks_.wxapkg'));
    const newer = write(path.join(root, '9', '_src_chunks_.wxapkg'));
    write(path.join(root, '11', '__APP__.wxapkg'));
    write(path.join(root, 'not-a-version', '_src_chunks_.wxapkg'));
    assert.equal(wechatUsersDirectory(options), containers[1]);
    assert.deepEqual(wechatPackageCandidates(appId, options), [newer, older]);
    assert.deepEqual(wechatPackageCandidates(appId, { ...options, includeIncomplete: true }),
      [path.join(root, '11', '_src_chunks_.wxapkg'), newer, older]);
  });

  test('Mac 配置缓存沿用同一容器，只返回实际 JSON 文件', () => {
    const root = path.join(containers[1], 'fixture-user', 'applet', 'local', appId, 'usr', 'gamecaches', 'config_cn');
    const config = write(path.join(root, 'config.json'));
    write(path.join(root, 'ignored.txt'));
    fs.mkdirSync(path.join(root, 'folder.json'));
    assert.deepEqual(wechatConfigCandidates(appId, options), [config]);
  });

  test('Mac 根目录与配置子目录的权限错误都给出可用的授权指引', () => {
    const configRoot = path.join(containers[1], 'fixture-user', 'applet', 'local', appId, 'usr', 'gamecaches', 'config_cn');
    for (const code of ['EPERM', 'EACCES']) {
      withDeniedDirectory(containers[1], code, () => {
        assert.throws(() => wechatPackageCandidates(appId, options), permissionHint);
      });
      withDeniedDirectory(configRoot, code, () => {
        assert.throws(() => wechatConfigCandidates(appId, options), permissionHint);
      });
    }
  });

  test('Windows 缓存路径及权限错误不变，显式 APPDATA 覆盖继续生效', () => {
    const env = { APPDATA: path.join(directory, 'custom-appdata') };
    const windows = { env, home, platform: 'win32' };
    const users = path.join(env.APPDATA, 'Tencent', 'xwechat', 'radium', 'users');
    const bundle = write(path.join(users, 'fixture-user', 'applet', 'packages', appId, '5', '_src_chunks_.wxapkg'));
    assert.equal(wechatUsersDirectory(windows), users);
    assert.equal(wechatUsersDirectory({ ...options, env }), users);
    assert.deepEqual(wechatPackageCandidates(appId, windows), [bundle]);
    assert.equal(wechatUsersDirectory({ env: {}, home, platform: 'win32' }),
      path.join(home, 'AppData', 'Roaming', 'Tencent', 'xwechat', 'radium', 'users'));
    withDeniedDirectory(users, 'EACCES', denied => {
      assert.throws(() => wechatPackageCandidates(appId, windows), error => error === denied);
    });
  });

  test('两个 Mac 容器同时存在时优先选择 xinWeChat', () => {
    const bundle = write(path.join(containers[0], 'fixture-user', 'applet', 'packages', appId, '6', '_src_chunks_.wxapkg'));
    assert.equal(wechatUsersDirectory(options), containers[0]);
    assert.deepEqual(wechatPackageCandidates(appId, options), [bundle]);
  });

  // Mock the native boundary only; exercise the actual platform dispatch logic.
  const originalSpawn = childProcess.spawn;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const envKeys = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'];
  const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  const calls = [];
  childProcess.spawn = (command, args, spawnOptions) => {
    const child = new EventEmitter();
    child.unrefs = 0;
    child.unref = () => { child.unrefs++; };
    calls.push({ command, args, spawnOptions, child });
    return child;
  };
  syncBuiltinESMExports();
  try {
    const url = 'http://127.0.0.1:17321/?fixture=hello%20world';
    test('Mac 使用 open 打开原始地址，启动失败不会落到 Windows 命令', () => {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
      assert.equal(openBrowser(url), 'open');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, 'open');
      assert.deepEqual(calls[0].args, [url]);
      assert.equal(calls[0].spawnOptions.detached, true);
      assert.equal(calls[0].spawnOptions.stdio, 'ignore');
      assert.equal(calls[0].child.unrefs, 1);
      calls[0].child.emit('error', new Error('fixture open unavailable'));
      assert.equal(calls.length, 1);
    });

    test('Windows 未安装应用浏览器时仍走 cmd start', () => {
      calls.length = 0;
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
      for (const key of envKeys) delete process.env[key];
      assert.equal(openBrowser(url), 'cmd');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, 'cmd');
      assert.deepEqual(calls[0].args, ['/c', 'start', '', url]);
    });

    test('Windows 仍优先 Edge 应用模式，启动失败保留系统浏览器回退', () => {
      calls.length = 0;
      const programs = path.join(directory, 'program files');
      const edge = write(path.join(programs, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      write(path.join(programs, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      process.env.ProgramFiles = programs;
      assert.equal(openBrowser(url), 'msedge');
      assert.equal(calls[0].command, edge);
      assert.deepEqual(calls[0].args, ['--app=' + url]);
      calls[0].child.emit('error', new Error('fixture Edge unavailable'));
      assert.equal(calls[1].command, 'cmd');
      assert.deepEqual(calls[1].args, ['/c', 'start', '', url]);
    });
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platformDescriptor);
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  console.log(`macOS 基础兼容专项 ${passed}/${passed} 通过（离线模拟，未启动浏览器或连接游戏）`);
} finally {
  assert.equal(path.dirname(path.resolve(directory)), temporary);
  fs.rmSync(directory, { recursive: true, force: true });
}
