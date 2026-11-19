// Real local HTTP routes with synthetic protocol modules and fake game clients.
// No installed game code, game server, browser, or remote resource is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-protocol-refresh-http-'));
const keys = ['CW_DATA_DIR', 'CW_CONFIG_PACK', 'CW_PROTO_BUNDLE', 'CW_RESOURCE_DIR'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_PROTO_BUNDLE = path.join(directory, 'protocol.js');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

function source(version) {
  return `define('src/chunks/bundle.fixture.js', function () {
    System.register([], function () { return { execute() {
      System.register('chunks:///_virtual/proto-bundle.js', ['helpers', 'minimal'], function (_export) {
        let minimal;
        return { setters: [function () {}, function (module) { minimal = module.default; }], execute() {
          const protocol = {};
          for (const name of ['LoginRequest','LoginResponse','PingRequest','PingResponse','Ack','Nack']) {
            function Message() {}
            Message.encode = function (body, writer) { return (writer || minimal.Writer.create()).uint32(8).int32(${version}); };
            Message.decode = function (bytes) { const reader = bytes instanceof minimal.Reader ? bytes : minimal.Reader.create(bytes); reader.uint32(); return { version: reader.int32() }; };
            protocol[name] = Message;
          }
          _export('protocol', protocol);
        }};
      });
    }}; });
  });`;
}
let writes = 0;
function publish(contents) {
  fs.writeFileSync(process.env.CW_PROTO_BUNDLE, contents);
  const stamp = new Date(Date.now() + ++writes * 2000);
  fs.utimesSync(process.env.CW_PROTO_BUNDLE, stamp, stamp);
}
publish(source(1));
const { GameClient } = await import('../src/client.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { saveStore } = await import('../src/accounts.mjs');
const { getProtocolSource } = await import('../src/proto.mjs');
const connected = new Set();
let connects = 0;
Object.defineProperty(GameClient.prototype, 'connected', { get() { return connected.has(this); } });
GameClient.prototype.connect = async function (login) {
  connects++; connected.add(this); this.state = 'CONNECTED';
  const playerId = { old: 910001, new: 910002, broken: 910003 }[login.eworldParams.openId];
  return { playerInfo: { playerId, worldId: 9001, level: 1 } };
};
GameClient.prototype.send = () => 1;
GameClient.prototype.request = async () => ({});
GameClient.prototype.sendWatch = async () => ({});
GameClient.prototype.stop = function () { connected.delete(this); this.stopping = true; this.state = 'IDLE'; };
saveStore({ activeId: 'old', accounts: ['old', 'new', 'broken'].map(id => ({
  id, url: 'ws://invalid.invalid', login: { worldId: 9001, eworldParams: { openId: id } }, automation: { enabled: false, autoStart: false },
})) });

const app = createConsole({ port: 0 });
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const wireVersion = client => client.codec.decode(client.codec.encode('PingRequest', 1, {})).body.version;
try {
  const root = await app.listen();
  const api = async (route, account = 'old', body) => {
    const response = await fetch(root + '/api/' + route + '?account=' + account, {
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, data: await response.json() };
  };
  let first, firstProtocol, firstCodec, second;
  await test('控制台从显式本地源加载，资源接口说明协议仅在连接时刷新', async () => {
    const status = await api('resources');
    assert.equal(status.status, 200);
    assert.equal(status.data.protocol.source, 'explicit');
    assert.equal(status.data.protocol.automaticDownload, false);
    assert.equal(status.data.protocol.refreshOnConnect, true);
    const response = await api('connect', 'old', {});
    assert.equal(response.status, 200, JSON.stringify(response.data));
    first = app.sessions.get('old').client;
    firstProtocol = first.protocol; firstCodec = first.codec;
    assert.equal(wireVersion(first), 1);
  });
  await test('源更新后另一账号连接使用新版，已有连接的协议和codec保持不变', async () => {
    publish(source(2));
    const status = await api('resources');
    assert.equal(status.data.protocol.pendingConnections, 1);
    const response = await api('connect', 'new', {});
    assert.equal(response.status, 200, JSON.stringify(response.data));
    second = app.sessions.get('new').client;
    assert.equal(wireVersion(second), 2); assert.notEqual(second.protocol, firstProtocol);
    assert.equal(first.protocol, firstProtocol); assert.equal(first.codec, firstCodec);
    assert.equal(wireVersion(first), 1); assert(first.connected);
    assert.notEqual(getProtocolSource(second.protocol).signature, getProtocolSource(firstProtocol).signature);
    assert.equal((await api('resources')).data.protocol.pendingConnections, 1);
  });
  await test('旧账号重连取得新版，已结束连接的协议对象仍不变', async () => {
    first.stop();
    const response = await api('connect', 'old', {});
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const replacement = app.sessions.get('old').client;
    assert.notEqual(replacement, first); assert.equal(wireVersion(replacement), 2);
    assert.equal(replacement.protocol, second.protocol);
    assert.equal(wireVersion(first), 1); assert.equal(first.protocol, firstProtocol);
    assert.equal((await api('resources')).data.protocol.pendingConnections, 0);
  });
  await test('新协议损坏时拒绝新连接且不回退，已连接账号继续使用原快照', async () => {
    publish('this is not a valid protocol module');
    const before = connects;
    const response = await api('connect', 'broken', {});
    assert.equal(response.status, 400);
    assert.match(response.data.error, /无法加载当前协议/);
    assert.equal(connects, before);
    assert.equal(app.sessions.get('broken').client, null);
    assert.equal(wireVersion(second), 2); assert(second.connected);
    assert.equal(wireVersion(app.sessions.get('old').client), 2);
    assert.equal((await api('resources')).data.protocol.pendingConnections, 2);
  });
  console.log('协议刷新 HTTP 验证通过 ' + passed + ' 项。');
} finally {
  app.server.closeAllConnections();
  await app.close();
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
  const target = fs.realpathSync(directory);
  assert.equal(path.dirname(target), temporaryRoot);
  assert(path.basename(target).startsWith('cw-protocol-refresh-http-'));
  fs.rmSync(target, { recursive: true, force: true });
}
