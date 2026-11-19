import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consoleHost, consoleUrl, normalizeConsoleHost } from '../src/console-address.mjs';

const temporary = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(temporary, 'cw-console-address-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
process.env.CW_CA_DIR = path.join(directory, 'certificates');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { startConsole } = await import('./start-console.mjs');
const { createConsole } = await import('../src/server.mjs');
const { GameClient } = await import('../src/client.mjs');
let connections = 0, passed = 0;
GameClient.prototype.connect = async () => { connections++; throw Error('监听测试禁止连接游戏'); };
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const close = async app => { app.server.closeAllConnections(); await app.close(); };

try {
  await test('默认仅监听本机，显式主机名和 IPv4/IPv6 地址规范化', () => {
    assert.equal(consoleHost({}), '127.0.0.1');
    assert.equal(consoleHost({ CW_HOST: '  ' }), '127.0.0.1');
    assert.equal(consoleHost({ CW_HOST: ' 192.168.1.8 ' }), '192.168.1.8');
    assert.equal(normalizeConsoleHost('localhost'), 'localhost');
    assert.equal(normalizeConsoleHost('[::1]'), '::1');
    for (const value of ['http://localhost', '127.0.0.1:17321', 'user@host', '../host', 'bad host', 'a\u0007b', '::1%zone', 'host/path']) {
      assert.throws(() => normalizeConsoleHost(value), /CW_HOST/);
    }
  });
  await test('通配监听输出可访问的本机地址，IPv6 URL 加方括号', () => {
    assert.equal(consoleUrl('0.0.0.0', 17321), 'http://127.0.0.1:17321');
    assert.equal(consoleUrl('::', 17321), 'http://[::1]:17321');
    assert.equal(consoleUrl('0:0:0:0:0:0:0:0', 17321), 'http://[::1]:17321');
    assert.equal(consoleUrl('::1', 17322), 'http://[::1]:17322');
    assert.equal(consoleUrl('192.168.1.8', 17324), 'http://192.168.1.8:17324');
    assert.equal(consoleUrl('localhost', 17323), 'http://localhost:17323');
    for (const port of [-1, 65536, 1.5, 'invalid']) assert.throws(() => consoleUrl('localhost', port), /端口/);
  });
  await test('原启动工具的地址模式读取 CW_HOST，正常启动保留配置', async () => {
    const env = { CW_HOST: 'localhost', CW_PORT: '18000' }, printed = [];
    let held = 0, launches = 0;
    const dependencies = { env, print: value => printed.push(value), prepare: async () => {}, hold: async () => { held++; }, launch: async () => { launches++; } };
    await startConsole(['url'], dependencies);
    assert.equal(printed.at(-1), 'http://localhost:18000/');
    env.CW_HOST = '::'; await startConsole(['address'], dependencies);
    assert.equal(printed.at(-1), 'http://[::1]:18000/');
    env.CW_HOST = '0.0.0.0'; await startConsole(['url'], dependencies);
    assert.equal(printed.at(-1), 'http://127.0.0.1:18000/');
    await startConsole([], dependencies);
    assert.equal(held, 3); assert.equal(launches, 1); assert.equal(env.CW_HOST, '0.0.0.0');
  });
  await test('控制台实际绑定指定 IPv4 回环地址，返回 URL 可请求且没有游戏连接', async () => {
    const app = createConsole({ host: consoleHost({ CW_HOST: '127.0.0.1' }), port: 0, protocol: {} });
    try {
      const address = await app.listen();
      assert.equal(app.server.address().address, '127.0.0.1');
      assert.equal(address, 'http://127.0.0.1:' + app.server.address().port);
      assert.equal((await fetch(address + '/api/accounts')).status, 200);
    } finally { await close(app); }
  });
  await test('IPv6 回环监听返回有效浏览器 URL', async () => {
    const app = createConsole({ host: '[::1]', port: 0, protocol: {} });
    try {
      let address;
      try { address = await app.listen(); }
      catch (error) {
        if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) { console.log('当前主机未启用 IPv6，已验证 URL 格式，跳过 IPv6 网络请求'); return; }
        throw error;
      }
      assert.equal(app.server.address().address, '::1');
      assert.equal(address, 'http://[::1]:' + app.server.address().port);
      assert.equal((await fetch(address + '/api/accounts')).status, 200);
    } finally { await close(app); }
  });
  await test('端口被占用时 listen 明确失败，不悬挂或抛未处理事件', async () => {
    const first = createConsole({ port: 0, protocol: {} }); let second;
    try {
      await first.listen();
      second = createConsole({ port: first.server.address().port, protocol: {} });
      await assert.rejects(second.listen(), error => error.code === 'EADDRINUSE');
    } finally { if (second) await close(second); await close(first); }
  });
  assert.equal(connections, 0);
  console.log(`控制台监听地址专项 ${passed}/${passed} 通过（临时数据、零游戏连接）`);
} finally {
  assert.equal(path.dirname(directory), temporary); fs.rmSync(directory, { recursive: true, force: true });
}
