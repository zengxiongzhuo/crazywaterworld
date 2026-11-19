// 新账号创建、逐项开启、服务重建及凭据刷新均使用隔离存储，禁止连接真实游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-new-account-defaults-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');

const { GameClient } = await import('../src/client.mjs');
const { loadStore, saveStore, upsertAccount } = await import('../src/accounts.mjs');
const { loadAutomationSettings } = await import('../src/automation-settings.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');

let connections = 0;
GameClient.prototype.connect = async () => {
  connections++;
  throw new Error('新账号默认配置测试禁止连接游戏');
};

let app, root, passed = 0;
const firstId = 'new-account-first', secondId = 'new-account-second';
const credential = (id, token = 'fixture-token') => ({
  url: 'wss://fixture.invalid/game', source: 'mitm',
  login: { eworldParams: { openId: id, token }, worldId: 9001 },
});
function add(id, token) {
  const store = loadStore();
  const result = upsertAccount(store, credential(id, token));
  saveStore(store);
  return result;
}
async function open() {
  app = createConsole({ port: 0, protocol: {}, captureController: {
    inspectCaptureRecovery: () => ({ pending: false }),
    captureState: () => ({ running: false }),
  } });
  root = await app.listen();
}
async function close() {
  if (!app) return;
  app.server.closeAllConnections();
  await app.close();
  app = null;
}
async function api(id, route, body, status = 200) {
  const response = await fetch(root + '/api/' + route + '?account=' + encodeURIComponent(id), {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify({ confirm: true, ...body }) }),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
function enabledFields(value, prefix = '') {
  if (typeof value === 'boolean') return value ? [prefix] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => enabledFields(child, prefix ? prefix + '.' + key : key));
}
function assertEnabledSettings(settings, allowed = []) {
  // 隐藏兼容字段及装备总控下的默认动作不会单独触发自动执行。
  assert.deepEqual(enabledFields(settings).sort(), ['ads.noPrivilege', 'forge.collect', 'forge.craft', ...allowed].sort());
  assert.equal(settings.forge.enabled, false);
  assert.equal(settings.forge.nativeAuto, false);
}
function assertIdle(view, enabled = []) {
  assert.equal(view.running, false);
  assert.equal(view.autoStart, false);
  assert.deepEqual(view.tasks.filter(task => task.enabled).map(task => task.key).sort(), [...enabled].sort());
  assert.equal(connections, 0, '读取、配置及重启不能自动登录游戏');
}
async function test(name, work) {
  await work();
  passed++;
  console.log('通过：' + name);
}

try {
  await test('新建账号的自动执行默认关闭，读取配置不连接游戏', async () => {
    const result = add(firstId);
    assert.equal(result.created, true);
    assert.deepEqual(result.account.automation, { enabled: false, autoStart: false });
    assertEnabledSettings(loadAutomationSettings(firstId).settings);
    await open();
    const view = await api(firstId, 'settings');
    assert.equal(view.revision, 0);
    assertEnabledSettings(view.settings);
    assertIdle(await api(firstId, 'loop'));
    assert(app.sessions.get(firstId).preferences, '首次保存前也必须使用完整配置门控');
  });

  await test('未选择自动项目时拒绝启动，且不发起登录', async () => {
    const failure = await api(firstId, 'loop/start', {}, 400);
    assert.match(failure.error, /请至少启用一个自动项目/);
    assertIdle(await api(firstId, 'loop'));
    assert.equal(loadStore().accounts[0].automation.enabled, false);
    assert.equal(loadAutomationSettings(firstId).revision, 0);
  });

  await test('明确开启邮件只保存该项目，不开启其他功能或自动启动', async () => {
    assertIdle(await api(firstId, 'loop/task', { key: 'mail', enabled: true }), ['mail']);
    const stored = loadAutomationSettings(firstId);
    assert.equal(stored.revision, 1, '首次逐项开启应保存完整配置');
    assertEnabledSettings(stored.settings, ['schedule.mail']);
    assertEnabledSettings((await api(firstId, 'settings')).settings, ['schedule.mail']);
  });

  await test('重建服务保留用户已开启的项目，新添账号仍独立保持全关', async () => {
    await close();
    assert.equal(add(secondId).created, true);
    await open();
    assertEnabledSettings((await api(firstId, 'settings')).settings, ['schedule.mail']);
    assertIdle(await api(firstId, 'loop'), ['mail']);
    assertEnabledSettings((await api(secondId, 'settings')).settings);
    assertIdle(await api(secondId, 'loop'));
  });

  await test('刷新同一账号的凭据保留其已保存设置和关闭的自动启动状态', async () => {
    const before = loadAutomationSettings(firstId);
    const result = add(firstId, 'refreshed-fixture-token');
    assert.equal(result.created, false);
    assert.equal(result.account.login.eworldParams.token, 'refreshed-fixture-token');
    assert.equal(result.account.automation.autoStart, false);
    assert.deepEqual(loadAutomationSettings(firstId), before);
    await close();
    await open();
    assertIdle(await api(firstId, 'loop'), ['mail']);
    assertEnabledSettings((await api(firstId, 'settings')).settings, ['schedule.mail']);
    assertIdle(await api(secondId, 'loop'));
  });

  await test('旧任务入口开启农田不连带开启基地运行、收获或种植', async () => {
    const view = await api(secondId, 'loop/task', { key: 'farm', enabled: true });
    assertIdle(view, ['farm']);
    assert.equal(view.tasks.find(task => task.key === 'farm').blockedBySettings, true);
    const stored = loadAutomationSettings(secondId);
    assert.equal(stored.revision, 1);
    assertEnabledSettings(stored.settings, ['schedule.farm', 'farm.enabled']);
    assert.equal(stored.settings.loop.world, false);
    assert.equal(stored.settings.farm.harvest, false);
    assert.equal(stored.settings.farm.autoPlant, false);
    assert.equal(stored.settings.farm.customPlant, false);
    assertEnabledSettings((await api(firstId, 'settings')).settings, ['schedule.mail']);
  });

  await test('未保存原生任务的旧账号保留已选运行参数，同时所有功能保持关闭', async () => {
    const id = 'legacy-numeric-options';
    add(id);
    const store = loadStore();
    Object.assign(store.accounts.find(account => account.id === id).automation, {
      rounds: 8, everySeconds: 37, fishingGoldReserve: 321,
    });
    saveStore(store);
    for (let attempt = 0; attempt < 2; attempt++) {
      const view = await api(id, 'settings');
      assert.equal(view.revision, 0);
      assertEnabledSettings(view.settings);
      assert.equal(view.settings.loop.rounds, 8);
      assert.equal(view.settings.loop.everySeconds, 37);
      assert.equal(view.settings.gather.fishingGoldReserve, 321);
      const loop = await api(id, 'loop');
      assertIdle(loop);
      assert.equal(loop.rounds, 8);
      assert.equal(loop.everyMs, 37000);
      assert.equal(loop.fishingGoldReserve, 321);
      assert.equal(loadStore().accounts.find(account => account.id === id).automation.tasks, undefined);
      if (attempt === 0) { await close(); await open(); }
    }
  });

  console.log(`新账号默认全关闭专项 ${passed}/${passed} 通过`);
} finally {
  await close();
  assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
  fs.rmSync(directory, { recursive: true, force: true });
}
