// Synthetic packages and temporary directories only; never contact a game
// server or evaluate an installed client's code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProtocol, getProtocolSource, loadProtocol } from '../src/proto.mjs';
import { protocolSourceInfo, readProtocolSource } from '../src/protocol-source.mjs';

function source(version, omit = '', requiredDefaults = false) {
  return `define('src/chunks/bundle.fixture.js', function () {
    System.register([], function () { return { execute() {
      System.register('chunks:///_virtual/proto-bundle.js', ['helpers', 'minimal'], function (_export) {
        let minimal;
        return { setters: [function () {}, function (module) { minimal = module.default; }], execute() {
          const protocol = {};
          for (const name of ['LoginRequest','LoginResponse','PingRequest','PingResponse','Ack','Nack']) {
            if (name === ${JSON.stringify(omit)}) continue;
            function Message() {}
            ${requiredDefaults ? 'Message.prototype.sequence = 0;' : ''}
            Message.encode = function (body, writer) {
              const result = (writer || minimal.Writer.create()).uint32(8).int32(body.version || ${version});
              return ${requiredDefaults ? 'result.uint32(16).int64(body.sequence)' : 'result'};
            };
            Message.decode = function (bytes) {
              const reader = minimal.Reader.create(bytes); reader.uint32(); const result = { version: reader.int32() };
              ${requiredDefaults ? 'reader.uint32(); result.sequence = reader.int64();' : ''}
              return result;
            };
            protocol[name] = Message;
          }
          _export('protocol', protocol);
        }};
      });
    }}; });
  });`;
}

function archive(code) {
  const name = Buffer.from('/src/chunks/game.js'), body = Buffer.from(code);
  const indexLength = 4 + 12 + name.length, offset = 14 + indexLength;
  const bytes = Buffer.alloc(offset + body.length);
  bytes[0] = 0xbe; bytes[13] = 0xed;
  bytes.writeUInt32BE(indexLength, 5); bytes.writeUInt32BE(body.length, 9);
  bytes.writeUInt32BE(1, 14); bytes.writeUInt32BE(name.length, 18);
  name.copy(bytes, 22); bytes.writeUInt32BE(offset, 22 + name.length);
  bytes.writeUInt32BE(body.length, 26 + name.length); body.copy(bytes, offset);
  return bytes;
}

const root = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(root, 'cw-protocol-updates-'));
const previous = { APPDATA: process.env.APPDATA, CW_PROTO_BUNDLE: process.env.CW_PROTO_BUNDLE };
process.env.APPDATA = directory;
delete process.env.CW_PROTO_BUNDLE;
const packageRoot = path.join(directory, 'Tencent/xwechat/radium/users/fixture/applet/packages/wx2ea52a972ea18e5e');
let passed = 0;
const test = (name, run) => { run(); passed++; console.log('通过：' + name); };
const version = protocol => protocol.PingResponse.decode(protocol.PingResponse.encode({}).finish()).version;
const writePackage = (number, code = source(number)) => {
  const file = path.join(packageRoot, String(number), '_src_chunks_.wxapkg');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, archive(code));
  return file;
};
try {
  writePackage(71);
  const firstFile = writePackage(74);
  let first, second;
  test('默认选择最新微信包，同一文件身份复用已验证协议', () => {
    const info = protocolSourceInfo();
    assert.equal(info.kind, 'wechat'); assert.equal(info.packageVersion, '74');
    assert.equal(info.file, firstFile); assert(Object.isFrozen(info));
    first = getProtocol();
    assert.equal(version(first), 74); assert.equal(getProtocol(), first);
    assert.deepEqual(getProtocolSource(first), info);
  });
  test('新包出现后新连接取得新版，旧协议对象仍保持原编解码', () => {
    writePackage(75);
    second = getProtocol();
    assert.notEqual(second, first); assert.equal(version(second), 75); assert.equal(version(first), 74);
    assert.equal(getProtocolSource(first).packageVersion, '74');
    assert.equal(getProtocolSource(second).packageVersion, '75');
  });
  test('原路径同大小内容更新由修改时间识别，缓存随之替换', () => {
    const file = writePackage(75, source(76));
    const stamp = new Date(Date.now() + 2000); fs.utimesSync(file, stamp, stamp);
    const updated = getProtocol();
    assert.notEqual(updated, second); assert.equal(version(updated), 76); assert.equal(version(second), 75);
  });
  test('显式环境变量保持选定文件，函数参数优先于环境变量', () => {
    process.env.CW_PROTO_BUNDLE = firstFile;
    assert.equal(protocolSourceInfo().kind, 'explicit');
    assert.equal(version(getProtocol()), 74);
    assert.equal(version(getProtocol(path.join(packageRoot, '71', '_src_chunks_.wxapkg'))), 71);
    delete process.env.CW_PROTO_BUNDLE;
  });
  test('最新版包损坏时拒绝新连接，不能悄悄使用旧版', () => {
    const file = writePackage(77);
    fs.writeFileSync(file, 'broken');
    assert.throws(() => getProtocol(), error => error.code === 'PROTOCOL_UPDATE_FAILED' && error.source.packageVersion === '77');
    assert.equal(version(first), 74); assert.equal(version(second), 75);
  });
  test('新协议缺少基础编解码时拒绝采用，修复后可重新加载', () => {
    const file = writePackage(77, source(77, 'LoginResponse'));
    assert.throws(() => getProtocol(), /缺少基础消息编解码：LoginResponse/);
    writePackage(77);
    const stamp = new Date(Date.now() + 4000); fs.utimesSync(file, stamp, stamp);
    assert.equal(version(getProtocol()), 77);
  });
  test('带必填int64字段的合法协议使用构造器默认值进行自检', () => {
    const file = writePackage(78, source(78, '', true));
    const uncached = loadProtocol(file);
    assert.throws(() => uncached.Ack.encode({}).finish());
    const protocol = getProtocol();
    const decoded = protocol.Ack.decode(protocol.Ack.encode(new protocol.Ack()).finish());
    assert.equal(decoded.version, 78);
    assert.equal(String(decoded.sequence), '0');
    assert.equal(getProtocolSource(protocol).packageVersion, '78');
  });
  test('空版本目录不遮蔽现有协议，两个读取入口均拒绝缺分包后的旧版回退', () => {
    const next = path.join(packageRoot, '79');
    fs.mkdirSync(next);
    assert.equal(protocolSourceInfo().packageVersion, '78');
    fs.writeFileSync(path.join(next, '__APP__.wxapkg'), 'synthetic installed main package');
    assert.throws(() => getProtocol(), error => error.code === 'PROTOCOL_UPDATE_FAILED' && /79.*协议分包尚未下载/.test(error.message));
    assert.throws(() => readProtocolSource(), /79.*协议分包尚未下载/, '直接读取与连接入口使用同一协议选择规则');
    assert.equal(version(getProtocol(firstFile)), 74, '显式选择仍优先');
    writePackage(79);
    assert.equal(version(getProtocol()), 79);
  });
  test('同版本另一用户已有完整协议时优先完整包', () => {
    const secondRoot = path.join(directory, 'Tencent/xwechat/radium/users/second/applet/packages/wx2ea52a972ea18e5e/80');
    const incomplete = path.join(packageRoot, '80');
    fs.mkdirSync(incomplete);
    fs.writeFileSync(path.join(incomplete, '__APP__.wxapkg'), 'synthetic installed main package');
    fs.mkdirSync(secondRoot, { recursive: true });
    fs.writeFileSync(path.join(secondRoot, '_src_chunks_.wxapkg'), archive(source(80)));
    assert.equal(protocolSourceInfo().packageVersion, '80');
    assert.equal(version(getProtocol()), 80);
  });
  test('显式源不存在时报告失败，原无缓存加载API仍可使用', () => {
    assert.throws(() => getProtocol(path.join(directory, 'missing.js')), error => error.name === 'ProtocolUpdateError');
    assert.equal(version(loadProtocol(firstFile)), 74);
    assert.equal(getProtocolSource({}), null);
  });
  console.log('协议更新验证通过 ' + passed + ' 项。');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const target = fs.realpathSync(directory);
  assert.equal(path.dirname(target), root); assert(path.basename(target).startsWith('cw-protocol-updates-'));
  fs.rmSync(target, { recursive: true, force: true });
}
