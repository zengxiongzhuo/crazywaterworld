// Local HTTP only: obsolete choices and stale resources must block execution,
// while the editor remains usable. All gameplay uses an in-memory fake client.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-settings-upgrade-'));
const keys = ['CW_DATA_DIR', 'CW_CONFIG_PACK', 'CW_RESOURCE_DIR', 'CW_RESOURCE_AUTO_UPDATE', 'CW_RESOURCE_APP_VERSION'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
delete process.env.CW_RESOURCE_AUTO_UPDATE;
process.env.CW_RESOURCE_APP_VERSION = '1.14.5';
const pack = crops => JSON.stringify([[0, 'FarmlandPlantCfg', { data: crops.map(id => ({ id })) }]]);
fs.writeFileSync(process.env.CW_CONFIG_PACK, pack(['wheat']));
const { saveStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { GameClient } = await import('../src/client.mjs');
const { defaultSettings, saveAutomationSettings } = await import('../src/automation-settings.mjs');
const { writeResourceCheck, activeResources } = await import('../src/resource-store.mjs');
let connections = 0;
GameClient.prototype.connect = async () => { connections++; throw new Error('Test must not connect'); };
saveStore({ activeId: 'upgrade', accounts: [{ id: 'upgrade', url: 'ws://invalid.invalid', login: {}, automation: { enabled: false } }] });
const settings = defaultSettings();
settings.farm.enabled = true;
settings.farm.customPlant = true;
settings.farm.crops = [{ id: 'wheat', target: 10 }];
saveAutomationSettings('upgrade', settings, { revision: 0 });
const app = createConsole({ port: 0, protocol: {} });
try {
  const root = await app.listen();
  const api = async (route, body) => {
    const response = await fetch(root + '/api/' + route + '?account=upgrade', body ? {
      method: 'POST', body: JSON.stringify({ confirm: true, ...body }),
    } : {});
    return { status: response.status, data: await response.json() };
  };
  const before = await api('settings');
  assert.equal(before.status, 200);
  assert.equal(before.data.compatibility, null);
  fs.writeFileSync(process.env.CW_CONFIG_PACK, pack([]));
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(process.env.CW_CONFIG_PACK, future, future);
  const obsolete = await api('settings');
  assert.equal(obsolete.status, 200);
  assert(obsolete.data.compatibility.fields['farm.crops']);
  assert.deepEqual(obsolete.data.settings.farm.crops, settings.farm.crops);
  const blocked = await api('loop/start', { rounds: 1 });
  assert.equal(blocked.status, 400);
  assert(blocked.data.fields['farm.crops']);
  assert.equal(app.sessions.get('upgrade').loop.running, false);
  assert.equal(connections, 0);

  const corrected = structuredClone(obsolete.data.settings);
  corrected.farm.customPlant = false;
  corrected.farm.crops = [];
  const saved = await api('settings', { settings: corrected, revision: obsolete.data.revision });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.compatibility, null);
  console.log('通过：资源热更新后旧选项阻止启动、原值可见，修正后解除配置错误');

  const resourceRoot = process.env.CW_RESOURCE_DIR;
  const generation = '0000000000000000-00000000-0000-0000-0000-000000000000';
  fs.mkdirSync(path.join(resourceRoot, generation), { recursive: true });
  fs.writeFileSync(path.join(resourceRoot, generation, 'config.json'), pack([]));
  fs.writeFileSync(path.join(resourceRoot, generation, 'world_map1.json'), '{}');
  fs.writeFileSync(path.join(resourceRoot, 'active.json'), JSON.stringify({ generation, appVersion: '1.14.5',
    version: '1.14.5.1', configVersion: 'old', mapVersion: 'old', scenarios: [1] }));
  fs.writeFileSync(path.join(resourceRoot, 'check.json'), JSON.stringify({ version: 1, appVersion: '1.14.5',
    required: { appVersion: '1.14.5', version: '1.14.5.2', configVersion: 'new', mapVersion: 'new' } }));
  delete process.env.CW_CONFIG_PACK;
  const stale = await api('settings');
  assert.equal(stale.status, 200);
  assert.match(stale.data.compatibility.error, /等待配置和地图完整更新/);
  const refused = await api('loop/start', { rounds: 1 });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /等待配置和地图完整更新/);
  assert.equal(connections, 0);
  const edited = await api('settings', { settings: stale.data.settings, revision: stale.data.revision });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert(edited.data.compatibility);
  console.log('通过：已知新资源未完整启用时禁止挂机，配置仍可查看和保存');

  const publish = version => {
    const generation = '1234567890abcdef-00000000-0000-0000-0000-00000000000' + version;
    const target = path.join(resourceRoot, generation);
    fs.mkdirSync(target);
    const tables = {
      TrialRaidCfg: [{ raidId: 1, title: '离线试炼' }],
      TrialRaidStageCfg: [{ raidId: 1, stageId: 1, openLevel: 1 }],
      // The update makes the formerly free sweep paid. The old plan must never send.
      TrialRaidBuySweepCfg: [{ buyTimes: 1, costRuby: version === 1 ? 0 : 50 }],
    };
    fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify(Object.entries(tables).map(([name, data], index) => [index, name, { data }])));
    fs.writeFileSync(path.join(target, 'world_map1.json'), '{}');
    const metadata = { generation, scenarios: [1], appVersion: '1.14.5', version: '1.14.5.' + version,
      configVersion: 'cfg' + version, mapVersion: 'map' + version };
    fs.writeFileSync(path.join(resourceRoot, 'active.json'), JSON.stringify(metadata));
    writeResourceCheck(resourceRoot, { appVersion: '1.14.5', required: metadata,
      verifiedAt: new Date().toISOString(), verifiedGeneration: generation });
  };
  publish(1);
  const current = await api('settings');
  const trialSettings = defaultSettings();
  trialSettings.schedule.trialSweep = true;
  const trialSaved = await api('settings', { settings: trialSettings, revision: current.data.revision });
  assert.equal(trialSaved.status, 200, JSON.stringify(trialSaved.data));
  const session = app.sessions.get('upgrade');
  const client = new EventEmitter();
  client.setMaxListeners(100);
  client.connected = true;
  client.stop = () => { client.connected = false; };
  client.snapshot = () => ({ state: 'READY' });
  const writes = [], readVersions = [];
  client.request = async name => {
    assert.equal(name, 'TrialRaidInfoRequest', '本测试只允许读取试炼进度');
    readVersions.push(activeResources().configVersion);
    if (readVersions.length === 1) publish(2);
    return { raid: { raidId: 1, passedStage: 1, buySweepTimes: 0 } };
  };
  client.sendWatch = async (name, body) => {
    writes.push({ name, body });
    throw new Error('资源变更后不应发送旧的免费扫荡计划');
  };
  session.client = client;
  session.player = { playerId: 9001001, worldId: 9001, level: 10 };
  const started = await api('loop/start', { rounds: 1 });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const deadline = Date.now() + 5000;
  while (session.loop.running && Date.now() < deadline) await sleep(10);
  assert.equal(session.loop.running, false, '有限轮数在重新规划后应能正常完成');
  assert.equal(session.loop.error, null);
  assert.equal(session.loop.completed, 1, '被资源更新取消的旧轮不应计入已完成轮数');
  assert.deepEqual(readVersions, ['cfg1', 'cfg2'], '同一连接必须重新读取并按新配置规划');
  assert.deepEqual(writes, [], '新版扫荡收费，不能沿用旧表的免费判断发送请求');
  assert.equal(connections, 0, '重新规划不应重新登录或连接真实游戏');
  console.log('通过：轮中资源更新取消旧免费扫荡并自动按新版重新规划，挂机正常完成');
} finally {
  app.server.closeAllConnections();
  await app.close();
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert(path.basename(target).startsWith('cw-settings-upgrade-'));
  fs.rmSync(target, { recursive: true, force: true });
}
