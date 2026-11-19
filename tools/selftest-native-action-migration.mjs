import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-native-action-migration-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK, '[]');
const { GameClient } = await import('../src/client.mjs');
const { saveStore, loadStore } = await import('../src/accounts.mjs');
const { defaultSettings, saveAutomationSettings, loadAutomationSettings, settingsFromNative, settingsFromLegacyNative } = await import('../src/automation-settings.mjs');
const { nativePreferenceEnabled } = await import('../src/automation-policy.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const oldKeys = ['museumCollect', 'museumExplore', 'petCollect', 'petBreed', 'radarAuto', 'radarRepair', 'museumRevenue', 'museumAchievements'];
let connections = 0, app, root;
GameClient.prototype.connect = async () => { connections++; throw new Error('迁移测试禁止连接游戏'); };
async function open() {
  app = createConsole({ port: 0, protocol: {} }); root = await app.listen();
}
async function close() {
  if (!app) return;
  app.server.closeAllConnections(); await app.close(); app = null;
}
async function api(account, route, body) {
  const response = await fetch(root + '/api/' + route + '?account=' + account, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, ...body }) }),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
}
let passed = 0;
async function test(name, work) { await work(); passed++; console.log('通过：' + name); }

try {
  const tasks = { collect: true, autoFish: true, dailyRewards: true, museumCollect: true, museumExplore: false,
    petCollect: false, petBreed: false, radarAuto: false, radarRepair: false, museumRevenue: false, museumAchievements: false };
  saveStore({ version: 1, activeId: 'migrate', accounts: ['migrate', 'false-only', 'detailed', 'new', 'museum-rewards'].map(id => ({
    id, label: id, url: 'wss://fixture.invalid/game', login: {}, automation: { enabled: false, autoStart: false,
      ...(id === 'new' ? {} : { tasks: id === 'museum-rewards' ? { museumRevenue: true, museumAchievements: true }
        : { ...tasks, museumCollect: id !== 'false-only' } }) },
  })) });
  const paused = defaultSettings();
  saveAutomationSettings('detailed', paused, { revision: 0 });
  await open();

  await test('仅无详细设置的原生迁移推导总控，常规和新账号默认保持关闭', async () => {
    const ordinary = settingsFromNative(tasks);
    assert.equal(ordinary.loop.world, false); assert.equal(ordinary.building.enabled, false);
    const converted = settingsFromLegacyNative(tasks);
    for (const key of ['collect', 'autoFish', 'dailyRewards']) assert(nativePreferenceEnabled(converted, key), key);
    assert.equal(converted.museum.runEnabled, true); assert.equal(converted.museum.enabled, true);
    assert(!Object.hasOwn(converted.museum, 'claim')); assert(!Object.hasOwn(converted.museum, 'explore'));
    assert.equal(converted.museum.useGuide, false);
    assert.equal(converted.museum.achievements, true, '原先自动探宝内置成就迁入独立动作');
    assert.equal(converted.building.upgrade, false); assert.equal(converted.factory.produce, false);
    assert.equal(converted.pet.enabled, false); assert.equal(converted.radar.runEnabled, false);
    const fresh = await api('new', 'settings');
    assert.equal(fresh.revision, 0); assert.deepEqual(fresh.settings, defaultSettings());
  });

  await test('原生博物馆收益与成就独立迁移持久化，不连带开启探宝或陈列', async () => {
    for (const [revenue, achievements] of [[true, false], [false, true], [true, true]]) {
      const converted = settingsFromLegacyNative({ museumRevenue: revenue, museumAchievements: achievements });
      assert.equal(converted.museum.runEnabled, true); assert.equal(converted.loop.world, true);
      assert.equal(converted.museum.revenue, revenue); assert.equal(converted.museum.achievements, achievements);
      assert.equal(converted.museum.enabled, false); assert.equal(converted.museum.display, false);
      for (const key of oldKeys) assert(!Object.hasOwn(converted.schedule, key));
    }
    const view = await api('museum-rewards', 'settings');
    assert.equal(view.revision, 1); assert.equal(view.settings.museum.revenue, true);
    assert.equal(view.settings.museum.achievements, true); assert.equal(view.settings.museum.enabled, false);
    assert.deepEqual(loadAutomationSettings('museum-rewards').settings, view.settings);
    for (const key of oldKeys) assert(!Object.hasOwn(view.settings.schedule, key));
    assert.equal(connections, 0);
  });

  await test('其他明确启用的原生任务补齐各自总控，不连带选择同组动作', () => {
    for (const key of ['freeRecruit', 'dailyRewards', 'build', 'startProduce', 'autoDive', 'farm', 'stageAuto',
      'weekPass', 'weekGift', 'weekChipFree', 'compassReward', 'vipDaily', 'campaignReports', 'weekSupplyFree']) {
      const converted = settingsFromLegacyNative({ museumCollect: true, [key]: true });
      assert(nativePreferenceEnabled(converted, key), key + ' 保持可执行');
      assert.equal(converted.schedule.mail, false); assert.equal(converted.schedule.ticketRecruit, false);
      assert.equal(converted.museum.enabled, true); assert.equal(converted.pet.enabled, false);
      assert(!Object.hasOwn(converted.museum, 'claim')); assert(!Object.hasOwn(converted.museum, 'explore'));
    }
    const farm = settingsFromLegacyNative({ farm: true, museumCollect: true });
    assert.equal(farm.farm.harvest, true); assert.equal(farm.farm.autoPlant, true); assert.equal(farm.farm.speedUp, false);
    const repair = settingsFromLegacyNative({ radarRepair: true });
    assert.equal(repair.radar.runEnabled, true); assert.equal(repair.radar.repairIdle, true);
    assert.equal(repair.radar.enabled, false); assert.equal(repair.loop.world, false);
  });

  await test('原生旧任务自动迁移为持久配置，原有采集和每日领奖继续有效', async () => {
    const view = await api('migrate', 'settings');
    assert.equal(view.revision, 1);
    assert.equal(view.settings.loop.world, true);
    assert.equal(view.settings.museum.runEnabled, true); assert.equal(view.settings.museum.enabled, true);
    assert(!Object.hasOwn(view.settings.museum, 'claim')); assert(!Object.hasOwn(view.settings.museum, 'explore'));
    assert.deepEqual(loadAutomationSettings('migrate').settings, view.settings);
    for (const key of oldKeys) assert(!Object.hasOwn(view.settings.schedule, key));
    const loop = await api('migrate', 'loop');
    for (const key of ['collect', 'autoFish', 'dailyRewards']) {
      const task = loop.tasks.find(item => item.key === key);
      assert.equal(task.enabled, true, key); assert.equal(task.blockedBySettings, false, key);
    }
    assert.equal(loop.running, false); assert.equal(connections, 0);
    await api('migrate', 'loop/stop', {});
    const account = loadStore().accounts.find(item => item.id === 'migrate');
    for (const key of oldKeys) assert(!Object.hasOwn(account.automation.tasks, key), key);
  });

  await test('重建后迁移动作和原任务仍在，只有false旧标志的账号保持原运行语义', async () => {
    const before = loadAutomationSettings('migrate');
    await close(); await open();
    const rebuilt = await api('migrate', 'settings');
    assert.equal(rebuilt.revision, before.revision); assert.deepEqual(rebuilt.settings, before.settings);
    for (const key of ['collect', 'autoFish', 'dailyRewards']) assert(nativePreferenceEnabled(app.sessions.get('migrate').preferences, key));
    const untouched = await api('false-only', 'settings');
    assert.equal(untouched.revision, 0); assert.equal(app.sessions.get('false-only').preferences, null);
    const loop = await api('false-only', 'loop');
    for (const key of ['collect', 'autoFish', 'dailyRewards']) assert.equal(loop.tasks.find(item => item.key === key).blockedBySettings, false);
  });

  await test('已有详细设置的显式关闭不会被旧原生记录重开', async () => {
    const view = await api('detailed', 'settings');
    assert.equal(view.revision, 1); assert.deepEqual(view.settings, paused);
    assert.equal(app.sessions.get('detailed').preferences.loop.world, false);
    assert.equal(app.sessions.get('detailed').preferences.museum.runEnabled, false);
    assert.equal(connections, 0);
  });
  console.log(`原生任务首次迁移专项 ${passed}/${passed} 通过`);
} finally {
  await close();
  assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
  fs.rmSync(directory, { recursive: true, force: true });
}
