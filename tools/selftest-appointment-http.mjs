import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-appointment-http-'));
const originalData = process.env.CW_DATA_DIR;
const originalPack = process.env.CW_CONFIG_PACK;
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify([[0, 'AppointPosCfg', { data: [
  { posId: 1, effectId: '生产时间', playerLevel: 13 },
  { posId: 4, effectId: '建造速度', playerLevel: 13 },
] }]]));

const { saveStore, loadStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { defaultSettings, hasExtraWork } = await import('../src/automation-settings.mjs');
saveStore({ activeId: 'appointments-only', accounts: [{
  id: 'appointments-only', label: '离线委任测试', url: 'ws://invalid.invalid', login: {}, automation: { enabled: false },
}] });
const app = createConsole({ port: 0, protocol: {} });
const root = await app.listen();
let session;
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const api = async (route, body) => {
  const response = await fetch(root + '/api/' + route + '?account=appointments-only', {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
};
const waitFor = async (condition, label) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(20);
  }
  assert.fail('等待超时 ' + label);
};

try {
  const view = await api('settings');
  const settings = defaultSettings();
  function disableSwitches(value) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'boolean') value[key] = false;
      else if (entry && typeof entry === 'object') disableSwitches(entry);
    }
  }
  disableSwitches(settings);
  assert.equal(hasExtraWork(settings), false);
  settings.appointments.enabled = true;
  settings.appointments.priorities = ['建造速度', ...settings.appointments.priorities.filter(id => id !== '建造速度')];
  settings.loop.everySeconds = 1;
  await api('settings', { settings, revision: view.revision, baseRevision: view.baseRevision });
  session = app.sessions.get('appointments-only');
  assert.equal(hasExtraWork(session.preferences), true);
  assert(Object.values(session.loop.tasks).every(value => value === false));

  const calls = [];
  let occupied = false;
  const client = new EventEmitter();
  client.setMaxListeners(30);
  client.connected = true;
  client.stop = () => { client.connected = false; };
  client.request = async (name, body) => {
    assert(session.queueTail, '游戏请求应进入账号队列');
    calls.push({ name, body: structuredClone(body) });
    if (name === 'AppointInfoRequest') return { heroes: occupied ? [{ posId: 4, heroId: '测试英雄' }] : [] };
    if (name === 'AutoAppointRequest') { occupied = true; return { heroes: [{ posId: 4, heroId: '测试英雄' }] }; }
    if (name === 'EmailBoxRequest') return { email: [] };
    assert.fail('未启用的游戏请求 ' + name);
  };
  session.client = client;
  session.player = { playerId: 1516002, worldId: 9001, nickname: '离线委任测试', level: 13 };
  const writes = () => calls.filter(call => call.name === 'AutoAppointRequest');

  await test('仅开启英雄委任经真实挂机启动接口正常执行一轮并完成回读', async () => {
    await api('loop/start', { confirm: true, rounds: 1, everySeconds: 1 });
    await session.loop.job;
    assert.equal(session.loop.error, null);
    assert.equal(session.loop.completed, 1);
    assert.equal(writes().length, 1);
    assert.deepEqual(writes()[0].body.posId, [4, 1]);
    assert.deepEqual(calls.map(call => call.name), ['AppointInfoRequest', 'AutoAppointRequest', 'AppointInfoRequest']);
    assert(session.loop.history[0].tasks.results.some(entry => entry.taskKey === 'appointments.enabled' && entry.ok));
  });

  await test('关闭最后一个旧任务后英雄委任保持运行并继续下一轮', async () => {
    await api('loop/task', { confirm: true, key: 'mail', enabled: true });
    await api('loop/start', { confirm: true, rounds: 0, everySeconds: 1 });
    await waitFor(() => session.loop.completed >= 1, '开始持续挂机');
    assert(calls.some(call => call.name === 'EmailBoxRequest'));
    const result = await api('loop/task', { confirm: true, key: 'mail', enabled: false });
    assert.equal(result.running, true);
    assert(Object.values(session.loop.tasks).every(value => value === false));
    assert.equal(session.loop.controller.signal.aborted, false);
    assert.equal(session.preferences.appointments.enabled, true);
    assert.equal(loadStore().accounts[0].automation.enabled, true);
    const before = writes().length;
    await waitFor(() => writes().length > before, '关闭旧任务后再次委任');
    assert.equal(session.loop.running, true);
    assert.equal(session.loop.error, null);
    await api('loop/stop', { confirm: true });
    await session.loop.job;
  });

  console.log(`英雄委任 HTTP 挂机测试 ${passed}/${passed} 通过`);
} finally {
  session?.loop.controller?.abort();
  await session?.loop.job;
  await app.close();
  if (originalData === undefined) delete process.env.CW_DATA_DIR;
  else process.env.CW_DATA_DIR = originalData;
  if (originalPack === undefined) delete process.env.CW_CONFIG_PACK;
  else process.env.CW_CONFIG_PACK = originalPack;
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
}
