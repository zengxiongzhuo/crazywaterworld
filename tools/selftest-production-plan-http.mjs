import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-production-plan-http-'));
process.env.CW_DATA_DIR = directory;
process.env.CW_CONFIG_PACK = path.join(directory, 'config.json');
process.env.CW_PROTO_BUNDLE = path.join(directory, 'intentionally-missing-protocol.js');
const config = {
  BuildingCfg: [{ buildingType: '食品厂' }, { buildingType: '农田' }, { buildingType: '民居' }],
  BuildingUpgradeCfg: [{ buildingType: '民居', level: 1, effect: [] },
    { buildingType: '民居', level: 2, playerLevel: 1, curPeople: 1, condition: [['食品厂', 1]], consume: [['面包', 4]] }],
  BuildingProduceCfg: [{ itemId: '面包', buildType: '食品厂', unlockLevel: 1, produceTime: 60, costItem: [['小麦', 5]] }],
  FarmlandPlantCfg: [{ id: '小麦', time: 30, produceNum: 5, material: ['小麦种子', 1] }],
  BuildingProduceParamCfg: [{ paramName: '制造位上限', paramValue: 6 }],
  GameParamCfg: [{ paramName: '初始人口', paramValue: 3 }, { paramName: '初始人口上限', paramValue: 100 }, { paramName: '产品存量初始上限', paramValue: 50 }],
  CargoUnlockCfg: [{ playerLevel: 9 }],
  ModuleOpenCfg: [{ moduleId: '联盟情报', playerLevel: 18 }, { moduleId: '联盟商船', playerLevel: 18 }],
  HeroRaidOrderCfg: [{ raidId: 1, orderId: 2, unlockDay: 1, orderList: [['面包', 1]] }],
};
fs.writeFileSync(process.env.CW_CONFIG_PACK, JSON.stringify(Object.entries(config).map(([name, data], index) => [index, name, { data }])));

const { GameClient } = await import('../src/client.mjs');
const { saveStore, loadStore } = await import('../src/accounts.mjs');
const { createConsole } = await import('./fixtures/console-server.mjs');
const { defaultSettings, saveAutomationSettings } = await import('../src/automation-settings.mjs');
const { watchHeroRaidPushes } = await import('../src/hero-raid-automation.mjs');
const requests = ['OnWater', 'AllItem', 'AllResource', 'GameEffect', 'MonthCard', 'AllHero', 'WeekInfo', 'WeekOrderInfo', 'CargoShips', 'GuildOrder', 'RadarInfo'];
const protocol = createDeclaredProtocol(requests.flatMap(name => [name + 'Request', name + 'Response']));
const states = new Map(), live = new Set(), apps = new Set();
let sequence = 0, passed = 0;

Object.defineProperty(GameClient.prototype, 'connected', { get() { return live.has(this); } });
GameClient.prototype.connect = async function (login) {
  this.fixture = states.get(login.fixtureId);
  assert(this.fixture, '仅允许隔离测试账号登录');
  this.fixture.logins++;
  this.connectionEpoch++;
  this.stopping = false;
  live.add(this);
  this.emit('login');
  this.emit('message', { name: 'SCAllActivity', body: { raid: [{ raidId: 1, startTime: this.fixture.now - 60,
    finishTime: this.fixture.now + 3600, order: { orderId: 2, gotOrderId: 1, gotTimes: 0 } }] } });
  return { result: 0, playerInfo: this.fixture.player };
};
GameClient.prototype.send = function (name) {
  this.fixture.sends.push(name);
  assert.equal(name, 'LoginFinishRequest', '排产读取不能发送游戏写请求');
};
GameClient.prototype.sendWatch = async function (name) { assert.fail('意外游戏写请求 ' + name); };
GameClient.prototype.request = async function (name) {
  if (this.heldByRead()) { await this.readGate; return this.request(name); }
  const state = this.fixture;
  state.requests.push(name);
  await state.onRequest?.(name, this);
  if (name === 'OnWaterRequest') await state.gate?.promise;
  assert(Object.hasOwn(state.responses, name), '未声明的读取 ' + name);
  const response = structuredClone(state.responses[name]);
  this.emit('message', { name: name.replace(/Request$/, 'Response'), body: response });
  return response;
};
GameClient.prototype.stop = function () { this.stopping = true; live.delete(this); };

function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() };
}
async function waitFor(check) {
  for (let index = 0; index < 300; index++) { if (check()) return; await sleep(10); }
  assert.fail('等待读取开始超时');
}
async function fixture() {
  const id = 'plan-http-' + ++sequence, now = Math.floor(Date.now() / 1000);
  const player = { playerId: '900719925474' + String(1000 + sequence), worldId: 1000001, guildId: '999', level: 25, nickname: '排产离线测试' };
  const state = { now, player, logins: 0, requests: [], sends: [], responses: {
    OnWaterRequest: { workerOrder: [{ index: 1, requirements: [{ id: '面包', num: 2 }] }, { index: 2, requirements: [{ id: '面包', num: 1 }] }],
      building: [{ buildingId: '1食品厂', level: 1, factory: { factoryQ: [], finishedProducts: [] } }, { buildingId: '1农田', level: 1, farm: {} }] },
    AllItemRequest: { items: [{ itemId: '面包', num: 20 }, { itemId: '小麦', num: 100 }, { itemId: '小麦种子', num: 10 }] },
    AllResourceRequest: { list: [{ res: 3, amount: 10000 }] },
    GameEffectRequest: { effects: [{ id: 1, value: 0 }, { id: 2, value: 0 }, { id: 11, value: 0 }] },
    MonthCardRequest: { cardItem: [] }, AllHeroRequest: { heroes: [] },
    WeekInfoRequest: { activityTime: [{ type: 5, startTime: now - 60, endTime: now + 3600, period: 1 }] },
    WeekOrderInfoRequest: { order: [{ id: '面包', num: 2 }], gotRwdId: [] },
    CargoShipsRequest: { ship: [{ index: 1, status: 0, orderItem: [{ asset: { id: '面包', num: 1 } }] },
      { index: 2, status: 0, orderItem: [{ asset: { id: '面包', num: 1 } }, { filled: true, asset: { id: '面包', num: 99 } }] }] },
    GuildOrderRequest: { order: { requirements: [{ id: '面包', num: 1 }], nextRefreshTime: now + 3600 } },
    RadarInfoRequest: { radarInfo: { events: [{ uid: 1, eventId: 40001, state: 1, refugee: { requirements: [{ id: '面包', num: 1 }] } }] } },
  } };
  states.set(id, state);
  const store = loadStore();
  store.accounts.push({ id, url: 'ws://invalid.invalid', login: { fixtureId: id }, automation: { enabled: false } });
  store.activeId = id;
  saveStore(store);
  const settings = defaultSettings();
  settings.loop.world = true;
  Object.assign(settings.factory, { enabled: true, produce: true, demandFirst: true });
  Object.assign(settings.building, { enabled: true, build: true, upgrade: true });
  Object.assign(settings.farm, { harvest: true, autoPlant: true });
  settings.weekOrder.enabled = true;
  settings.factory.keepStock = 0;
  settings.factory.demandPriority = [];
  settings.farm.enabled = true;
  Object.assign(settings.alliance, { enabled: true, recruit: true });
  settings.heroRaid.enabled = true;
  saveAutomationSettings(id, settings, { revision: 0 });
  const app = createConsole({ port: 0, protocol });
  apps.add(app);
  const root = await app.listen();
  const response = async (route, body = null) => {
    const result = await fetch(root + '/api/' + route + '?account=' + id, {
      ...(body === null ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000),
    });
    return { status: result.status, data: await result.json() };
  };
  const api = async (route, body = null) => {
    const result = await response(route, body);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  await api('accounts');
  const session = () => app.sessions.get(id);
  const close = async () => { state.gate?.resolve(); await app.close(); apps.delete(app); };
  return { id, state, app, api, response, session, close };
}
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
async function updateSettings(fixture, change) {
  const view = await fixture.api('settings');
  change(view.settings);
  await fixture.api('settings', { settings: view.settings, revision: view.revision, baseRevision: view.baseRevision });
}
saveStore({ activeId: null, accounts: [] });
try {
  await test('断开状态只读排产拒绝请求且不会自行登录', async () => {
    const f = await fixture();
    try {
      const response = await f.response('world/production-plan');
      assert.equal(response.status, 400);
      assert.match(response.data.error, /连接/);
      assert.equal(f.state.logins, 0);
      assert.deepEqual(f.state.requests, []);
      assert.deepEqual(f.state.sends, []);
    } finally { await f.close(); }
  });
  await test('真实HTTP保留全部当前订单与完整库存并保持零游戏写入', async () => {
    const f = await fixture();
    try {
      await f.api('connect', {});
      f.state.requests.length = 0;
      f.state.sends.length = 0;
      const result = await f.api('world/production-plan');
      assert.equal(result.orders.length, 8);
      assert.deepEqual([...new Set(result.orders.map(order => order.source))].sort(), ['cargo', 'guildRecruit', 'heroRaid', 'merchant', 'refugee', 'resident']);
      assert.equal(result.orders.filter(order => order.source === 'cargo').length, 2);
      assert.equal(result.upperBound, 0, '二十份真实库存足以同时齐套当前十份需求');
      assert.equal(result.missingReads.length, 0);
      assert(!JSON.stringify(result).includes('"raw"'));
      assert.deepEqual(f.state.sends, []);
      assert(f.state.requests.every(name => requests.some(prefix => name === prefix + 'Request')));
      assert.equal(f.state.logins, 1);
    } finally { await f.close(); }
  });
  await test('活动HTTP总开关逐项控制联合排产需求，恢复后沿用细项并保持零游戏写入', async () => {
    const f = await fixture();
    try {
      await f.api('connect', {});
      f.state.requests.length = 0;
      f.state.sends.length = 0;
      const selections = (await f.api('settings')).settings.schedule;
      const toggle = async (key, value) => {
        const view = await f.api('activities/settings');
        await f.api('activities/settings', { key, value, revision: view.revision, baseRevision: view.baseRevision, confirm: true });
        return f.api('world/production-plan');
      };
      const initial = await f.api('world/production-plan');
      assert.equal(initial.orders.length, 8);
      assert(initial.orders.some(order => order.source === 'heroRaid'));
      assert(initial.orders.some(order => order.source === 'merchant'));

      const heroOff = await toggle('heroRaid.enabled', false);
      assert.equal(heroOff.orders.length, 7);
      assert(!heroOff.orders.some(order => order.source === 'heroRaid'));
      assert(heroOff.orders.some(order => order.source === 'merchant'));
      const bothOff = await toggle('weekOrder.enabled', false);
      assert.equal(bothOff.orders.length, 6);
      assert(!bothOff.orders.some(order => ['merchant', 'heroRaid'].includes(order.source)));
      assert.deepEqual([...new Set(bothOff.orders.map(order => order.source))].sort(), ['cargo', 'guildRecruit', 'refugee', 'resident']);

      const heroOn = await toggle('heroRaid.enabled', true);
      assert.equal(heroOn.orders.length, 7);
      assert(heroOn.orders.some(order => order.source === 'heroRaid'));
      assert(!heroOn.orders.some(order => order.source === 'merchant'));
      const restored = await toggle('weekOrder.enabled', true);
      assert.deepEqual(restored.orders.map(order => order.id), initial.orders.map(order => order.id));
      assert.deepEqual((await f.api('settings')).settings.schedule, selections);
      assert.equal(f.session().loop.running, false);
      assert.deepEqual(f.state.sends, []);
      assert(f.state.requests.every(name => requests.some(prefix => name === prefix + 'Request')));
      assert.equal(f.state.logins, 1);
    } finally { await f.close(); }
  });
  await test('关闭活动的数据缺失或读取失败不会阻断其它来源的HTTP排程', async () => {
    const f = await fixture();
    try {
      await f.api('connect', {});
      await updateSettings(f, settings => { settings.heroRaid.enabled = settings.weekOrder.enabled = false; });
      const heroState = watchHeroRaidPushes(f.session().client);
      heroState.observed = false; heroState.invalid = true; heroState.raids.clear();
      f.state.requests.length = 0;
      f.state.sends.length = 0;
      f.state.onRequest = name => {
        if (['WeekInfoRequest', 'WeekOrderInfoRequest'].includes(name)) throw new Error('已关闭活动的读取不可用');
      };
      const result = await f.api('world/production-plan');
      assert.equal(result.status, 'optimal');
      assert.deepEqual(result.missingReads, []);
      assert.equal(result.orders.length, 6);
      assert.deepEqual([...new Set(result.orders.map(order => order.source))].sort(), ['cargo', 'guildRecruit', 'refugee', 'resident']);
      assert(!f.state.requests.some(name => ['WeekInfoRequest', 'WeekOrderInfoRequest'].includes(name)));
      assert.deepEqual(f.state.sends, []);
      assert.equal(f.state.logins, 1);
    } finally { await f.close(); }
  });
  await test('保存需求优先级后实际HTTP排程顺序与分级工期同步变化', async () => {
    const f = await fixture();
    try {
      await f.api('connect', {});
      f.state.sends.length = 0;
      f.state.responses.AllItemRequest.items.find(item => item.itemId === '面包').num = 0;
      await updateSettings(f, settings => {
        settings.factory.demandPriority = ['resident', 'cargo', 'guildRecruit', 'heroRaid', 'merchant', 'refugee'];
      });
      const residentFirst = await f.api('world/production-plan');
      assert.equal(residentFirst.objective, 'priority-makespan');
      assert.equal(residentFirst.orders[0].source, 'resident');
      assert(residentFirst.orders.filter(order => order.source === 'resident').every(order => order.priority === 0));
      assert(residentFirst.orders.filter(order => order.source === 'cargo').every(order => order.priority === 1));
      assert.match(residentFirst.orders[0].priorityLabel, /第1级/);
      assert.deepEqual(residentFirst.priorityBounds.map(bound => bound.priority), [0, 1, 2, 3, 4, 5]);
      assert.match(residentFirst.priorityBounds[0].label, /居民/);
      assert.equal(residentFirst.priorityBounds[0].upperBound, 180, '居民三份面包优先占用三批生产');
      assert.equal(residentFirst.timeline.find(job => job.kind === 'production').priority, 0);

      await updateSettings(f, settings => {
        settings.factory.demandPriority = ['cargo', 'resident', 'guildRecruit', 'heroRaid', 'merchant', 'refugee'];
      });
      const cargoFirst = await f.api('world/production-plan');
      assert.equal(cargoFirst.orders[0].source, 'cargo');
      assert(cargoFirst.orders.filter(order => order.source === 'cargo').every(order => order.priority === 0));
      assert(cargoFirst.orders.filter(order => order.source === 'resident').every(order => order.priority === 1));
      assert.deepEqual(cargoFirst.priorityBounds.map(bound => bound.priority), [0, 1, 2, 3, 4, 5]);
      assert.match(cargoFirst.priorityBounds[0].label, /贸易港/);
      assert.equal(cargoFirst.priorityBounds[0].upperBound, 120, '货船两份面包移到最高优先级后最先齐套');
      assert.equal(cargoFirst.orders.length, residentFirst.orders.length);
      assert.deepEqual(f.state.sends, []);
      assert.equal(f.state.logins, 1);
    } finally { await f.close(); }
  });
  await test('真实HTTP建筑备料同时遵守来源选择与补料开关并保护已齐材料', async () => {
    const f = await fixture();
    try {
      await f.api('connect', {});
      f.state.sends.length = 0;
      f.state.responses.OnWaterRequest.building.push({ buildingId: '1民居', level: 1 });
      await updateSettings(f, settings => { settings.factory.demandPriority = ['building', 'resident']; });
      assert(!(await f.api('world/production-plan')).orders.some(order => order.source === 'building'));

      await updateSettings(f, settings => { settings.building.supply = true; });
      const enabled = await f.api('world/production-plan');
      const target = enabled.orders.find(order => order.source === 'building');
      assert(target);
      assert.equal(target.priority, 0);
      assert.equal(target.kind, 'consumption');
      assert.equal(target.metadata.ready, true);
      assert.deepEqual(target.requirements.map(({ id, num }) => ({ id, num })), [{ id: '面包', num: 4 }]);
      assert.match(enabled.priorityBounds[0].label, /建筑/);
      assert.equal(enabled.upperBound, 0);

      await updateSettings(f, settings => { settings.factory.demandPriority = ['resident']; });
      assert(!(await f.api('world/production-plan')).orders.some(order => order.source === 'building'));
      assert.deepEqual(f.state.sends, []);
      assert.equal(f.state.logins, 1);
    } finally { await f.close(); }
  });
  await test('同账号并发点击复用整份只读计算', async () => {
    const f = await fixture();
    try {
      await f.api('connect', {});
      f.state.requests.length = 0;
      f.state.gate = deferred();
      const first = f.response('world/production-plan');
      await waitFor(() => f.state.requests.includes('OnWaterRequest'));
      const second = f.response('world/production-plan');
      await sleep(30);
      f.state.gate.resolve();
      const results = await Promise.all([first, second]);
      assert(results.every(result => result.status === 200));
      assert.deepEqual(results[0].data, results[1].data);
      assert.equal(f.state.requests.filter(name => name === 'OnWaterRequest').length, 1);
      assert.equal(f.state.requests.filter(name => name === 'AllItemRequest').length, 1);
    } finally { await f.close(); }
  });
  await test('读取期间保存设置或改变角色身份使旧快照失效', async () => {
    for (const change of ['settings', 'player', 'replace-player']) {
      const f = await fixture();
      try {
        await f.api('connect', {});
        f.state.requests.length = 0;
        f.state.sends.length = 0;
        f.state.gate = deferred();
        const pending = f.response('world/production-plan');
        await waitFor(() => f.state.requests.includes('OnWaterRequest'));
        if (change === 'settings') {
          const view = await f.api('settings');
          view.settings.factory.produce = !view.settings.factory.produce;
          await f.api('settings', { settings: view.settings, revision: view.revision, baseRevision: view.baseRevision });
        } else if (change === 'player') f.session().player.playerId = '9007199254749999';
        else f.session().player = { ...f.session().player, playerId: '9007199254749999' };
        f.state.gate.resolve();
        const result = await pending;
        assert.equal(result.status, 400, JSON.stringify(result.data));
        assert.match(result.data.error, /变化/);
        assert(!f.state.requests.includes('AllItemRequest'));
        assert.deepEqual(f.state.sends, []);
      } finally { await f.close(); }
    }
  });
  await test('库存列表缺失时HTTP返回明确的不完整状态', async () => {
    const f = await fixture();
    try {
      await f.api('connect', {});
      f.state.responses.AllItemRequest = {};
      const result = await f.api('world/production-plan');
      assert.equal(result.status, 'incomplete');
      assert.equal(result.completionAt, null);
      assert(result.missingReads.some(reason => reason.includes('AllItemRequest')));
      assert.equal(result.orders.length, 8);
    } finally { await f.close(); }
  });
  await test('读取中的库存推送阻止混合快照，下次稳定读取恢复', async () => {
    const f = await fixture();
    try {
      await f.api('connect', {});
      f.state.onRequest = (name, client) => {
        if (name === 'AllItemRequest') client.emit('message', { name: 'SCUpdateItem', body: { items: [{ itemId: '面包', num: 20 }] } });
      };
      const rejected = await f.response('world/production-plan');
      assert.equal(rejected.status, 400);
      assert.match(rejected.data.error, /游戏状态已变化/);
      f.state.onRequest = null;
      const recovered = await f.api('world/production-plan');
      assert.equal(recovered.orders.length, 8);
      assert.equal(recovered.upperBound, 0);
    } finally { await f.close(); }
  });
  console.log('排产 HTTP 测试通过 ' + passed + ' 项');
} finally {
  for (const app of apps) await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
