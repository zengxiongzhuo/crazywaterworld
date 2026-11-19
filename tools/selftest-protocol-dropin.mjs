// Copy only the source locator and its Node-only dependencies into a temporary
// app root. Never create packages in the real checkout or read client caches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = path.resolve(import.meta.dirname, '..');
const temporary = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporary, 'cw-protocol-dropin-'));
const APPID = 'wx2ea52a972ea18e5e';
let passed = 0;

function archive(text) {
  const name = Buffer.from('/src/chunks/game.js'), body = Buffer.from(text);
  const indexLength = 4 + 12 + name.length, offset = 14 + indexLength;
  const data = Buffer.alloc(offset + body.length);
  data[0] = 0xbe; data[13] = 0xed;
  data.writeUInt32BE(indexLength, 5); data.writeUInt32BE(body.length, 9);
  data.writeUInt32BE(1, 14); data.writeUInt32BE(name.length, 18);
  name.copy(data, 22); data.writeUInt32BE(offset, 22 + name.length);
  data.writeUInt32BE(body.length, 26 + name.length); body.copy(data, offset);
  return data;
}
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}
async function test(name, work) {
  const root = path.join(directory, String(passed));
  for (const relative of ['src/protocol-source.mjs', 'src/platform/client-paths.mjs', 'tools/wxapkg.mjs']) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repository, relative), target);
  }
  const original = { APPDATA: process.env.APPDATA, CW_PROTO_BUNDLE: process.env.CW_PROTO_BUNDLE };
  process.env.APPDATA = path.join(root, 'client-data');
  delete process.env.CW_PROTO_BUNDLE;
  const cacheUsers = path.join(process.env.APPDATA, 'Tencent/xwechat/radium/users');
  const cacheRoot = path.join(cacheUsers, 'fixture/applet/packages', APPID);
  try {
    const module = await import(pathToFileURL(path.join(root, 'src/protocol-source.mjs')));
    await work({ ...module, root, cacheUsers, cacheRoot,
      dropIn: path.join(root, '_src_chunks_.wxapkg'), nested: path.join(root, 'protocol/_src_chunks_.wxapkg'),
      cache: (version, text) => write(path.join(cacheRoot, String(version), '_src_chunks_.wxapkg'), archive(text)),
    });
    passed++; console.log('通过：' + name);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

try {
  await test('缺少协议时两个入口都列出程序目录、提取目录及显式配置方法', f => {
    for (const read of [f.protocolSourceInfo, f.readProtocolSource]) assert.throws(() => read(), error => {
      assert.match(error.message, /缺少协议文件/);
      for (const location of [f.dropIn, f.nested, f.PROTO_BUNDLE, f.cacheUsers]) assert(error.message.includes(location));
      assert.match(error.message, /CW_PROTO_BUNDLE/); return true;
    });
  });
  await test('程序根目录协议自动识别并解包，切换工作目录不改变选择', f => {
    write(f.dropIn, archive('root protocol fixture'));
    const other = path.join(f.root, 'other-cwd'); fs.mkdirSync(other);
    write(path.join(other, '_src_chunks_.wxapkg'), archive('wrong working-directory fixture'));
    const cwd = process.cwd();
    try {
      process.chdir(other);
      const info = f.protocolSourceInfo();
      assert.equal(info.kind, 'drop-in'); assert.equal(info.file, f.dropIn); assert.equal(info.packageVersion, null);
      assert(Object.isFrozen(info)); assert.equal(info.size, fs.statSync(f.dropIn).size);
      assert.equal(f.readProtocolSource(), 'root protocol fixture');
      assert.equal(f.readProtocolSource(info.file), f.readProtocolSource());
    } finally { process.chdir(cwd); }
  });
  await test('protocol 子目录可独立使用，两处都有文件时根目录优先', f => {
    write(f.nested, archive('nested fixture'));
    assert.equal(f.protocolSourceInfo().file, f.nested); assert.equal(f.readProtocolSource(), 'nested fixture');
    write(f.dropIn, archive('root fixture'));
    assert.equal(f.protocolSourceInfo().file, f.dropIn); assert.equal(f.readProtocolSource(), 'root fixture');
  });
  await test('既有 extracted 文件仍可作为后备来源，自备包优先于提取副本', f => {
    write(f.PROTO_BUNDLE, 'extracted fixture');
    assert.equal(f.protocolSourceInfo().kind, 'extracted'); assert.equal(f.readProtocolSource(), 'extracted fixture');
    write(f.nested, archive('nested fixture'));
    assert.equal(f.protocolSourceInfo().kind, 'drop-in'); assert.equal(f.readProtocolSource(), 'nested fixture');
  });
  await test('显式参数、环境变量、最新微信缓存与自备包的优先级一致', f => {
    write(f.dropIn, archive('root fixture')); write(f.PROTO_BUNDLE, 'extracted fixture');
    f.cache(71, 'cache 71'); const latest = f.cache(76, 'cache 76');
    assert.equal(f.protocolSourceInfo().file, latest); assert.equal(f.readProtocolSource(), 'cache 76');
    process.env.CW_PROTO_BUNDLE = f.PROTO_BUNDLE;
    assert.equal(f.protocolSourceInfo().kind, 'explicit'); assert.equal(f.readProtocolSource(), 'extracted fixture');
    assert.equal(f.protocolSourceInfo(f.dropIn).file, f.dropIn); assert.equal(f.readProtocolSource(f.dropIn), 'root fixture');
    const missing = path.join(f.root, 'missing.js');
    for (const read of [f.protocolSourceInfo, f.readProtocolSource]) assert.throws(() => read(missing), error => error.code === 'ENOENT');
    process.env.CW_PROTO_BUNDLE = missing;
    for (const read of [f.protocolSourceInfo, f.readProtocolSource]) assert.throws(() => read(), error => error.code === 'ENOENT');
  });
  await test('缓存损坏或最新主包缺分包时不偷换旧缓存、自备包或 extracted', f => {
    write(f.dropIn, archive('root fixture')); write(f.PROTO_BUNDLE, 'extracted fixture');
    f.cache(71, 'cache 71'); const latest = f.cache(76, 'cache 76');
    fs.writeFileSync(latest, 'corrupt fixture');
    assert.equal(f.protocolSourceInfo().file, latest);
    assert.throws(() => f.readProtocolSource(), /wxapkg/);
    write(path.join(f.cacheRoot, '77/__APP__.wxapkg'), 'installed main package');
    for (const read of [f.protocolSourceInfo, f.readProtocolSource]) assert.throws(() => read(), /77.*协议分包尚未下载/);
    assert.equal(f.readProtocolSource(f.dropIn), 'root fixture', '用户显式选择仍可覆盖');
  });
  await test('自动发现的非文件或损坏自备包明确报错，不跳到较低优先级', f => {
    write(f.nested, archive('nested fixture')); write(f.PROTO_BUNDLE, 'extracted fixture');
    fs.mkdirSync(f.dropIn);
    for (const read of [f.protocolSourceInfo, f.readProtocolSource]) assert.throws(() => read(), /协议来源不是文件/);
    fs.rmdirSync(f.dropIn); fs.writeFileSync(f.dropIn, 'broken package');
    assert.equal(f.protocolSourceInfo().file, f.dropIn);
    assert.throws(() => f.readProtocolSource(), /wxapkg/);
  });
  await test('Mac 缓存权限不足时可使用自备包或 extracted，无后备时保留授权指引', f => {
    const original = fs.readdirSync, descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const denied = Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
    fs.readdirSync = function (file, ...args) {
      if (String(file) === f.cacheUsers) throw denied;
      return original.call(this, file, ...args);
    };
    try {
      write(f.dropIn, archive('root fixture'));
      assert.equal(f.protocolSourceInfo().file, f.dropIn); assert.equal(f.readProtocolSource(), 'root fixture');
      fs.unlinkSync(f.dropIn); write(f.PROTO_BUNDLE, 'extracted fixture');
      assert.equal(f.protocolSourceInfo().file, f.PROTO_BUNDLE); assert.equal(f.readProtocolSource(), 'extracted fixture');
      fs.unlinkSync(f.PROTO_BUNDLE);
      for (const read of [f.protocolSourceInfo, f.readProtocolSource]) assert.throws(() => read(), error => {
        assert.match(error.message, /完全磁盘访问/); assert(error.message.includes(f.dropIn));
        assert.equal(error.cause?.cause, denied); return true;
      });
    } finally { fs.readdirSync = original; Object.defineProperty(process, 'platform', descriptor); }
  });
  await test('缓存文件读取权限不足允许自备后备，非权限扫描错误仍向上传递', f => {
    const cached = f.cache(76, 'cache 76'); write(f.dropIn, archive('root fixture'));
    const access = fs.accessSync, readdir = fs.readdirSync;
    fs.accessSync = function (file, ...args) {
      if (String(file) === cached) throw Object.assign(Error('fixture denied'), { code: 'EPERM' });
      return access.call(this, file, ...args);
    };
    try { assert.equal(f.protocolSourceInfo().file, f.dropIn); assert.equal(f.readProtocolSource(), 'root fixture'); }
    finally { fs.accessSync = access; }
    const ioError = Object.assign(Error('fixture IO failure'), { code: 'EIO' });
    fs.readdirSync = function (file, ...args) {
      if (String(file) === f.cacheUsers) throw ioError;
      return readdir.call(this, file, ...args);
    };
    try {
      for (const read of [f.protocolSourceInfo, f.readProtocolSource]) assert.throws(() => read(), error => error === ioError);
    } finally { fs.readdirSync = readdir; }
  });
  console.log(`协议包自动识别专项 ${passed}/${passed} 通过（临时应用根目录、合成协议包，零游戏连接）`);
} finally {
  assert.equal(path.dirname(fs.realpathSync(directory)), temporary);
  fs.rmSync(directory, { recursive: true, force: true });
}
